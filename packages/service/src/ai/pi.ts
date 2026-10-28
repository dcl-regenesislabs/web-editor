import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager
} from '@earendil-works/pi-coding-agent'
import type { Extension, FileEntry, ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from '@earendil-works/pi-ai'
import { ASSET_KINDS, ASSISTANT_EFFORT, ASSISTANT_MODEL, object } from '../../../contract/src/assistant.ts'
import type { AiProvider, AiSendParams } from '../../../contract/src/shell.ts'
import type { BrowserToolName } from '../../../contract/src/assistant.ts'
import { EDITOR_TOOL_DESCRIPTIONS, editorToolContent, isEditorTool } from '../../../contract/src/editor-tools.ts'
import type { AgentFactory } from './types.ts'
import { WEB_ASSISTANT_PROMPT } from './prompt.ts'
import { seedSetupToken } from './setup-token.ts'
import { createWalletImages, thumbnailTool } from './thumbnail.ts'
import { createSkillsComponent } from '../adapters/skills.ts'
import type { SkillsComponent } from '../adapters/skills.ts'

const PROVIDERS = { claude: 'anthropic', codex: 'openai-codex' } as const

// the only extension: hands each provider response's headers (Claude's plan usage) to the service
function responseHeaders(onHeaders: (headers: Record<string, string>) => void): Extension {
  const path = '<inline:response-headers>'
  return {
    path, resolvedPath: path, hidden: true,
    sourceInfo: { path, source: 'inline', scope: 'temporary', origin: 'top-level' },
    handlers: new Map([['after_provider_response', [async (event: unknown) => {
      if (!object(event) || !object(event.headers)) return
      onHeaders(Object.fromEntries(Object.entries(event.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
    }]]]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map()
  }
}

function resources(skills: SkillsComponent, onHeaders?: (headers: Record<string, string>) => void): ResourceLoader {
  const extensions = { extensions: onHeaders === undefined ? [] : [responseHeaders(onHeaders)], errors: [], runtime: createExtensionRuntime() }
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

// one model for every turn, and no choice to make in the composer (contract/assistant.ts)
export { ASSISTANT_MODEL }

export async function createPiFactory(authPath: string, preferredModel?: string, setupToken?: string, skills?: SkillsComponent,
  logger?: { info(message: string): void }, onProviderHeaders?: (headers: Record<string, string>) => void): Promise<AgentFactory> {
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
        search_files: Type.Object({ query: Type.String(), regex: Type.Optional(Type.Boolean()), match: Type.Optional(Type.String()), label }),
        read_file: Type.Object({
          path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })),
          query: Type.Optional(Type.String()), regex: Type.Optional(Type.Boolean()), label
        }),
        edit_file: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String(), all: Type.Optional(Type.Boolean()), label }),
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
          platform: Type.Optional(Type.Union([Type.Literal('desktop'), Type.Literal('mobile')])),
          keys: Type.Optional(Type.Array(Type.String(), { maxItems: 2 })),
          durationMs: Type.Optional(Type.Number({ minimum: 0, maximum: 5000 })),
          waitFor: Type.Optional(Type.String()),
          to: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() })),
          x: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          y: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), label
        }),
        ui_layout: Type.Object({ label }),
        view: Type.Object({
          target: Type.Optional(Type.Union([Type.Literal('editor'), Type.Literal('mobile')])),
          openIfClosed: Type.Optional(Type.Boolean({ description: 'Open the mobile preview if closed. Use only when the creator asks to see or check mobile UI.' })),
          entity: Type.Optional(Type.String()),
          from: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() })),
          lookAt: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() })),
          label
        })
      }
      // the browser's tools are the editor tools both assistants share
      const descriptions: Record<BrowserToolName, string> = EDITOR_TOOL_DESCRIPTIONS
      const tools: ToolDefinition[] = (Object.keys(schema) as BrowserToolName[]).map((name) => ({
        name, label: name, description: descriptions[name], parameters: schema[name],
        execute: async (_id, args, signal) => {
          if (!object(args)) throw new Error('Invalid tool arguments')
          const text = await call(name, args, signal)
          if (isEditorTool(name)) return { content: editorToolContent(name, text), details: {} }
          return { content: [{ type: 'text' as const, text }], details: {} }
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
          // the browser steps are logged by the connection; this one never reaches the browser
          logger?.info(`assistant skill read path=${args.path}${args.query === undefined ? '' : ` query=${JSON.stringify(args.query)}`}`)
          return { content: [{ type: 'text', text: skillLibrary.read(args.path, args.offset, args.query) }], details: {} }
        }
      })
      tools.push(thumbnailTool(call, images ?? createWalletImages(undefined, undefined, 0)))
      const sessionManager = SessionManager.inMemory(undefined, undefined, restore as FileEntry[] | undefined)
      const { session } = await createAgentSession({
        modelRuntime: runtime, model, resourceLoader: resources(skillLibrary, onProviderHeaders),
        sessionManager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, defaultThinkingLevel: ASSISTANT_EFFORT }),
        tools: tools.map((tool) => tool.name), customTools: tools
      })
      if (session.getActiveToolNames().some((name) => !tools.some((tool) => tool.name === name))) {
        session.dispose()
        throw new Error('Unexpected assistant tool')
      }
      // usage already counted: a restored conversation was paid for when it ran. The session log only
      // grows (compaction appends its own usage), so deltas never count a call twice.
      const baseline = session.getSessionStats()
      let counted = { cost: baseline.cost, ...baseline.tokens }
      let calls = 0
      let unreported = 0
      let responseModel: string | undefined
      let emittedText = false
      let separator = false
      session.subscribe((event) => {
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          calls++
          if (event.message.usage.totalTokens === 0) unreported++
          responseModel = event.message.responseModel ?? event.message.model
        }
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
          const next = { cost: stats.cost, ...stats.tokens }
          const delta = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => Math.max(0, next[key] - counted[key])
          const usage = {
            cost: Math.max(0, next.cost - counted.cost),
            tokens: { input: delta('input'), output: delta('output'), cacheRead: delta('cacheRead'), cacheWrite: delta('cacheWrite') },
            calls, unreported, responseModel
          }
          counted = next
          calls = 0
          unreported = 0
          return usage
        },
        model: chosen,
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
