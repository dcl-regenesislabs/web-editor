// The editor tools as the desktop assistant reaches them: the editor's MCP server in the main
// process forwards each call here. The web assistant runs the same modules through its browser
// tools (packages/web/src/ai/tools.ts), with the browser project as the files.
import type { EditorToolCall, EditorToolName } from '@dcl-editor/contract'
import { runFreshBuild } from '../actions/verify-build'
import { dataLayerListFiles, dataLayerReadFileBytes, dataLayerSaveFileBytes } from '../engine/datalayer'
import { awaitFreshBundle, currentSceneHealth } from '../features/editor/scene-health'
import { log } from '../log'
import { createAssetRequests } from './assets'
import { refreshWrittenScript } from './attach'
import { createFileTools, isFileTool, sameBytes, type ProjectFiles } from './file-tools'
import { setLibraryBytes } from './library-bytes'
import { browserSceneRequest } from './scene'
import { materialFile } from '../three/materials'
import { soundFile } from '../sounds'
import { leavePhone, playtest } from './playtest'
import { uiLayout } from './ui-layout'
import { captureView, viewRequest } from './view'

async function readDisk(path: string): Promise<Uint8Array | undefined> {
  try {
    return await dataLayerReadFileBytes(path)
  } catch {
    return undefined
  }
}

// The project on disk, through the scene's data layer: a write lands like a save and starts a rebuild.
const disk: ProjectFiles = {
  paths: () => dataLayerListFiles(),
  read: readDisk,
  write: async (path, bytes, expected) => {
    if (!sameBytes(await readDisk(path), expected)) throw new Error('This file changed since you read it: read it again.')
    await dataLayerSaveFileBytes(path, bytes)
  },
  written: refreshWrittenScript
}
let fileTools = createFileTools(disk)

// the dev server notices a saved file within this and starts rebuilding
const BUILD_NOTICE_MS = 1500

// Desktop builds on save: wait for the rebuild the assistant's last edits started, then run the new
// bundle once the way the web build does.
async function desktopBuild(signal: AbortSignal): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, BUILD_NOTICE_MS))
  await awaitFreshBundle()
  signal.throwIfAborted()
  const health = currentSceneHealth()
  if (health?.kind === 'build') return { ok: false, diagnostics: health.lines }
  const run = await runFreshBuild()
  signal.throwIfAborted()
  return { ok: true, diagnostics: [], run }
}

// The files asset_request reads, from disk for this call: prefab data and guides, and the model asked about.
async function assetFiles(args: Record<string, unknown>): Promise<Map<string, Uint8Array>> {
  const wanted = (await dataLayerListFiles()).filter((path) =>
    /^custom\/[^/]+\/(data\.json|ai\.md)$/.test(path) || path === args.path)
  return new Map(await Promise.all(wanted.map(async (path) => [path, await dataLayerReadFileBytes(path)] as const)))
}

function sceneRequest(value: unknown): unknown {
  if (typeof value !== 'string') return value
  // some models send the request object as JSON text
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('Invalid scene request.')
  }
}

export async function runEditorTool(name: EditorToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (name === 'view') return JSON.stringify(await captureView(viewRequest(args), signal))
  if (name === 'playtest') return JSON.stringify(await playtest(args, signal))
  if (name === 'ui_layout') return JSON.stringify(await uiLayout(args, signal))
  if (isFileTool(name)) return fileTools(name, args, signal)
  if (name === 'build') return JSON.stringify(await desktopBuild(signal))
  // scene.json (parcels, permissions, the thumbnail) is the web host's to edit; here it answers so
  if (name === 'scene_request') return JSON.stringify(await browserSceneRequest(sceneRequest(args.request), signal))
  const files = await assetFiles(args)
  return JSON.stringify(await createAssetRequests({ files: () => files })(args, signal))
}

function library(bytes: Uint8Array | undefined): Uint8Array<ArrayBuffer> {
  if (bytes === undefined) throw new Error('The shared library is not available here.')
  return new Uint8Array(bytes)
}

// Desktop: answer the main process's forwarded calls, and leave the phone when a turn ends.
export function installEditorToolBridge(): void {
  const shell = window.editorShell
  if (shell?.onEditorToolCall === undefined || shell.editorToolResult === undefined) return
  const answer = shell.editorToolResult
  setLibraryBytes({
    material: async (name, map) => library(await shell.libraryFile?.(materialFile(name, map))),
    sound: async (name) => library(await shell.libraryFile?.(soundFile(name)))
  })
  const running = new Map<string, AbortController>()
  shell.onEditorToolCall((call: EditorToolCall) => {
    if ('cancel' in call) {
      running.get(call.id)?.abort()
      return
    }
    const controller = new AbortController()
    running.set(call.id, controller)
    runEditorTool(call.name, call.args, controller.signal)
      .then((text) => answer(call.id, { ok: true, text }))
      .catch((e: unknown) => answer(call.id, { ok: false, message: e instanceof Error ? e.message : String(e) }))
      .catch((e: unknown) => log.warn('engine tool answer failed', e))
      .finally(() => running.delete(call.id))
  })
  shell.onAiEvent?.((e) => {
    if (e.kind === 'started') {
      fileTools = createFileTools(disk)
    }
    if (e.kind === 'done') leavePhone().catch((err: unknown) => log.warn('leaving the phone canvas failed', err))
  })
}
