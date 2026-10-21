import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager
} from '@earendil-works/pi-coding-agent'
import type { FileEntry, ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from '@earendil-works/pi-ai'
import { ASSET_KINDS, object } from '../../../contract/src/assistant.ts'
import type { AiProvider, AiSendParams } from '../../../contract/src/shell.ts'
import type { BrowserToolName } from '../../../contract/src/assistant.ts'
import type { AgentFactory } from './types.ts'
import { WEB_ASSISTANT_PROMPT } from './prompt.ts'
import { seedSetupToken } from './setup-token.ts'
import { createWalletImages, thumbnailTool } from './thumbnail.ts'
import { createSkillsComponent } from '../adapters/skills.ts'
import type { SkillsComponent } from '../adapters/skills.ts'

const PROVIDERS = { claude: 'anthropic', codex: 'openai-codex' } as const

function resources(skills: SkillsComponent): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() }
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => `${WEB_ASSISTANT_PROMPT}\n\nAvailable SDK skill documents:\n${skills.catalog}`,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {}
  }
}

// one model for every turn: the strongest, and no choice to make in the composer
export const ASSISTANT_MODEL = 'claude-opus-5-5'

export async function createPiFactory(authPath: string, preferredModel?: string, setupToken?: string, skills?: SkillsComponent): Promise<AgentFactory> {
  const skillLibrary = skills ?? await createSkillsComponent()
  if (setupToken !== undefined) await seedSetupToken(authPath, setupToken)
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false })
  if (preferredModel !== undefined && !Object.values(PROVIDERS).some((provider) =>
    runtime.getModels(provider).some((model) => model.id === preferredModel))) throw new Error('AI_MODEL is not a supported model')
  for (const id of Object.values(PROVIDERS)) {
    const provider = runtime.getProvider(id)
    const oauth = provider?.auth.oauth
    if (provider !== undefined && oauth !== undefined) {
      runtime.registerNativeProvider({ ...provider, auth: { oauth: {
        ...oauth,
        refresh: (credential, signal) => {
          if (credential.setupToken === true) return Promise.reject(new Error('Rotate the expired Claude setup token and restart the service.'))
          return oauth.refresh(credential, signal)
        }
      } } })
    }
  }
  const providers: AgentFactory['providers'] = async () => {
    const credentials = await runtime.listCredentials()
    return (Object.entries(PROVIDERS) as Array<[AiProvider, string]>).map(([id, provider]) => {
      const all = runtime.getModels(provider).map((model) => model.id)
      // a configured model is the only one offered, so clients cannot pick a costlier one
      const models = preferredModel === undefined ? all : all.filter((model) => model === preferredModel)
      const available = credentials.some((c) => c.providerId === provider && c.type === 'oauth') && models.length > 0
      return {
        id, label: id === 'claude' ? 'Claude' : 'Codex', available, models,
        defaultModel: models.find((model) => model === preferredModel) ?? [...models].reverse().find((m) => m.includes('opus')) ?? models[models.length - 1] ?? '',
        transport: 'service' as const,
        ...(!available ? { reason: 'This provider is not signed in on the assistant service.' } : {})
      }
    })
  }
  return {
    providers,
    async create(params, call, emit, restore, images) {
      const info = (await providers()).find((p) => p.id === params.provider)
      if (info === undefined || !info.available) throw new Error('Provider unavailable')
      const chosen = params.model ?? info.defaultModel
      if (!info.models.includes(chosen)) throw new Error('Unknown model')
      const model = runtime.getModel(PROVIDERS[info.id], chosen)
      if (model === undefined) throw new Error('Unknown model')
      const label = Type.Optional(Type.String({ description: 'What you are doing now, for the creator, at most six words' }))
      const schema = {
        list_files: Type.Object({
          kind: Type.Optional(Type.Union([...ASSET_KINDS].map((kind) => Type.Literal(kind)))),
          match: Type.Optional(Type.String()),
          label
        }),
        read_file: Type.Object({ path: Type.String(), label }),
        asset_request: Type.Object({
          action: Type.Union(['inspect_model', 'search_prefabs', 'import_prefab'].map((value) => Type.Literal(value))),
          query: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })),
          path: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), label
        }),
        write_file: Type.Object({ path: Type.String(), content: Type.String(), revision: Type.Union([Type.String(), Type.Null()]), label }),
        scene_request: Type.Object({ request: Type.Object({ type: Type.String() }, { additionalProperties: true }), label }),
        build: Type.Object({ label }),
        playtest: Type.Object({
          action: Type.Union(['start', 'stop', 'status', 'input', 'wait', 'walk', 'click'].map((value) => Type.Literal(value))),
          keys: Type.Optional(Type.Array(Type.String(), { maxItems: 2 })),
          durationMs: Type.Optional(Type.Number({ minimum: 0, maximum: 5000 })),
          to: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() })),
          x: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          y: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), label
        }),
        view: Type.Object({
          target: Type.Optional(Type.Union([Type.Literal('editor'), Type.Literal('mobile')])),
          openIfClosed: Type.Optional(Type.Boolean({ description: 'Open the mobile preview if closed. Use only when the creator asks to see or check mobile UI.' })),
          entity: Type.Optional(Type.String()),
          from: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() })),
          lookAt: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() })),
          label
        })
      }
      const descriptions: Record<BrowserToolName, string> = {
        list_files: 'List the open browser project\'s files, optionally only one kind (models, images, sounds, videos, data, code) and those whose path contains match. read_file opens code and data; models, images, sounds and videos are referenced by path.',
        read_file: 'Read a browser project file and its revision. Missing files have a null revision.',
        asset_request: 'Search the prefab library, import a returned ref into the project without placing it, or inspect a local model for dimensions, pivot, animation names, colliders and dependencies. Search results have nextOffset.',
        write_file: 'Create or replace source code, only if its revision still matches.',
        scene_request: 'Inspect or change the live scene using the editor actions documented in the system prompt.',
        build: 'Compile and run the browser project once. Return compiler diagnostics, runtime errors and mobilePreview status; does not publish it. After visual UI changes, inspect an open mobile preview with view target: mobile.',
        playtest: 'Check the running game with the real player controller and UI: a quick run after a build, or reproducing what the creator reports. start reloads the client scene at spawn and plays; stop restores edit mode and discards client runtime changes. The multiplayer server can retain progress across reloads: click the game restart button and verify its initial HUD before a fresh attempt. status reports player world position, HUD text and runtime errors. input holds the interaction keys E/F for durationMs (0–5000); wait advances time; walk uses the controller towards to in world metres, on the ground only. click presses the scene UI at x/y fractions of the viewport. Does not grant progress. Use view during play to see the HUD and route.',
        view: 'A picture of the scene. Use target: mobile when asked how mobile controls or UI look; set openIfClosed: true for that request to open the preview if needed. Mobile captures include touch controls and scene UI, embedded or in another tab. A minimized preview briefly resumes for the picture and pauses again afterward. Loading previews are awaited. It uses the current player camera and cannot frame an entity. With no target or camera arguments, the embedded mobile preview is captured when open. target: editor captures the editor camera, optionally framed on entity or from a world position from looking at lookAt, in metres (16 per parcel). Use it to check what you placed, moved or built.'
      }
      const tools: ToolDefinition[] = (Object.keys(schema) as BrowserToolName[]).map((name) => ({
        name, label: name, description: descriptions[name], parameters: schema[name],
        execute: async (_id, args, signal) => {
          if (!object(args)) throw new Error('Invalid tool arguments')
          const text = await call(name, args, signal)
          if (name !== 'view') return { content: [{ type: 'text' as const, text }], details: {} }
          // the browser answers a picture; the model reads it as an image, not as base64 text
          const view: unknown = JSON.parse(text)
          if (!object(view) || typeof view.image !== 'string' || view.mimeType !== 'image/jpeg') throw new Error('The browser sent no picture.')
          const framed = typeof view.framed === 'string' ? ` framed on "${view.framed}"` : ''
          return {
            content: [
              { type: 'image' as const, mimeType: 'image/jpeg', data: view.image },
              { type: 'text' as const, text: `The scene from the creator's camera${framed}, ${String(view.width)}×${String(view.height)}.` }
            ],
            details: {}
          }
        }
      }))
      tools.push({
        name: 'read_skill', label: 'Read SDK skill',
        description: 'Read bundled Decentraland SDK guidance or references. Paths are relative to the skill library, not the project. Follow nextOffset for more; query searches a document and returns matching lines with offsets.',
        parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), query: Type.Optional(Type.String()) }),
        execute: async (_id, args) => {
          if (!object(args) || typeof args.path !== 'string' ||
            (args.offset !== undefined && typeof args.offset !== 'number') ||
            (args.query !== undefined && typeof args.query !== 'string')) throw new Error('Invalid skill arguments')
          return { content: [{ type: 'text', text: skillLibrary.read(args.path, args.offset, args.query) }], details: {} }
        }
      })
      tools.push(thumbnailTool(call, images ?? createWalletImages(undefined, undefined, 0)))
      const sessionManager = SessionManager.inMemory(undefined, undefined, restore as FileEntry[] | undefined)
      const { session } = await createAgentSession({
        modelRuntime: runtime, model, resourceLoader: resources(skillLibrary),
        sessionManager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
        tools: tools.map((tool) => tool.name), customTools: tools
      })
      if (session.getActiveToolNames().some((name) => !tools.some((tool) => tool.name === name))) {
        session.dispose()
        throw new Error('Unexpected assistant tool')
      }
      // usage already counted: a restored conversation was paid for when it ran
      let counted = session.getSessionStats().cost
      let emittedText = false
      let separator = false
      session.subscribe((event) => {
        if (event.type === 'message_start' && event.message.role === 'assistant') separator = emittedText
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          const delta = event.assistantMessageEvent.delta
          if (delta === '') return
          emit({ text: `${separator ? '\n\n' : ''}${delta}` })
          emittedText = true
          separator = false
        }
      })
      return {
        async prompt(next: AiSendParams) {
          emittedText = false
          separator = false
          const images = next.images?.map((image) => {
            const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image.dataUrl)
            if (match === null) throw new Error('Invalid image')
            return { type: 'image' as const, mimeType: match[1], data: match[2] }
          })
          await session.prompt(`${next.context ?? ''}\n\n${next.text}`, { images })
          const last = session.messages.at(-1)
          if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) {
            throw new Error('The model did not complete this turn.')
          }
        },
        takeUsage() {
          const stats = session.getSessionStats()
          const cost = Math.max(0, stats.cost - counted)
          counted = stats.cost
          return { cost }
        },
        abort: () => session.abort(),
        dispose: () => session.dispose(),
        snapshot: () => {
          const header = sessionManager.getHeader()
          return header === null ? sessionManager.getEntries() : [header, ...sessionManager.getEntries()]
        }
      }
    }
  }
}
