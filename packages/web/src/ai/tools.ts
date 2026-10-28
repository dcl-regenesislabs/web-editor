import { createFileTools, isFileTool, sameBytes } from '@ui/ai/file-tools'
import type { BrowserToolCall } from '@dcl-editor/contract'
import { viewRequest, type ViewRequest } from '@ui/ai/view-request'

export interface BrowserProject {
  files(): ReadonlyMap<string, Uint8Array>
  write(path: string, bytes: Uint8Array, expected: Uint8Array | null, signal: AbortSignal): Promise<void>
  scene(request: unknown, signal: AbortSignal): Promise<unknown>
  build(signal: AbortSignal): Promise<unknown>
  playtest?(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  // the screen UI as laid out on the desktop canvas or a phone's, with a picture
  uiLayout?(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  assets?(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  // a picture of the viewport: from the free camera placed at `from`, or framed on an entity, or as is
  view(request: ViewRequest, signal: AbortSignal): Promise<unknown>
  // when a turn ends, however it ended
  turnEnded?(): Promise<void>
  // after a successful write
  written?(path: string, content: string): Promise<void>
}

export { sameBytes }

function parseRequest(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Invalid scene request.')
  }
}

export function createBrowserTools(project: BrowserProject) {
  const files = createFileTools({
    paths: async () => [...project.files().keys()],
    read: async (path) => project.files().get(path),
    write: (path, bytes, expected, signal) => project.write(path, bytes, expected, signal),
    ...(project.written === undefined ? {} : { written: project.written })
  })
  return async (call: BrowserToolCall, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    const { tool, args } = call
    if (tool === 'playtest') {
      if (project.playtest === undefined) throw new Error('Playtesting requires an updated editor.')
      return JSON.stringify(await project.playtest(args, signal))
    }
    if (tool === 'ui_layout') {
      if (project.uiLayout === undefined) throw new Error('Measuring the UI requires an updated editor.')
      return JSON.stringify(await project.uiLayout(args, signal))
    }
    if (tool === 'asset_request') {
      if (project.assets === undefined) throw new Error('Asset tools require an updated editor.')
      return JSON.stringify(await project.assets(args, signal))
    }
    if (tool === 'build') return JSON.stringify(await project.build(signal))
    if (tool === 'view') {
      return JSON.stringify(await project.view(viewRequest(args), signal))
    }
    if (tool === 'scene_request') {
      // some models send the request object as JSON text
      return JSON.stringify(await project.scene(typeof args.request === 'string' ? parseRequest(args.request) : args.request, signal))
    }
    if (!isFileTool(tool)) throw new Error('Unknown browser tool.')
    return files(tool, args, signal)
  }
}
