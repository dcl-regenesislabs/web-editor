import type { AiEvent, AiProviderInfo, AiSendParams } from './shell'

export const ASSISTANT_MAX_FILE_BYTES = 256 * 1024
export const ASSISTANT_MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const ASSISTANT_MAX_MESSAGE_BYTES = 12 * 1024 * 1024
export const ASSISTANT_ID = /^[a-zA-Z0-9-]{1,80}$/
export const ASSISTANT_PROTOCOL = 'dcl-assistant-v1'
export const ASSISTANT_TICKET_PREFIX = 'dcl-ticket.'

export const BROWSER_TOOLS = ['list_files', 'search_files', 'read_file', 'edit_file', 'write_file', 'scene_request', 'asset_request', 'build', 'view', 'playtest', 'ui_layout', 'mobile_check'] as const
export type BrowserToolName = (typeof BROWSER_TOOLS)[number]
export interface BrowserToolCall {
  kind: 'call'
  turnId: string
  callId: string
  tool: BrowserToolName
  args: Record<string, unknown>
  // the assistant's own words for this step, shown as the turn's running status
  label?: string
}

export function isCatalogSearch(tool: BrowserToolName, args: Record<string, unknown>): boolean {
  return tool === 'scene_request' && object(args.request) && args.request.type === 'findModels'
}

/** A conversation the service keeps encrypted between sessions; only the browser holds `key`. */
export interface AssistantMemoryRef {
  id: string
  key: string
}
export type AssistantClientMessage =
  | { kind: 'prompt'; turnId: string; projectId: string; params: AiSendParams; memory?: AssistantMemoryRef }
  | { kind: 'result'; turnId: string; callId: string; ok: boolean; text: string }
  | { kind: 'stop'; turnId: string }
  | { kind: 'reset' }
  | { kind: 'forget'; id: string }

export type AssistantServerMessage =
  | { kind: 'ready'; providers: AiProviderInfo[] }
  | { kind: 'event'; event: AiEvent }
  | BrowserToolCall
  | { kind: 'failure'; message: string }

// One model and one effort for every assistant turn, web and desktop alike, so a run on either
// reads the same. The web service may override the model (AI_MODEL); the desktop dev picker too.
export const ASSISTANT_MODEL = 'claude-opus-5-5'
export const ASSISTANT_EFFORT = 'medium'

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function assistantReadable(path: string): boolean {
  if (path.length === 0 || path.length > 512 || /[\\\x00-\x1f\x7f:]/.test(path)) return false
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '..' || part.startsWith('.') || part === 'node_modules' || part === 'bin')) return false
  return /\.(ts|tsx|js|jsx|json|md|txt)$/i.test(path)
}

export function assistantWritable(path: string): boolean {
  return assistantReadable(path) && /^src\//.test(path) && /\.(ts|tsx|js|jsx)$/.test(path) &&
    !path.split('/').includes('runtime')
}

// What a project file is to the assistant, by path: what list_files filters by and the per-turn summary counts
export const ASSET_KINDS = ['models', 'images', 'sounds', 'videos', 'data', 'code'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]
const KIND_TESTS: Array<[AssetKind, RegExp]> = [
  ['models', /\.(glb|gltf)$/i],
  ['images', /\.(png|jpe?g|webp|ktx2)$/i],
  ['sounds', /\.(mp3|ogg|wav)$/i],
  ['videos', /\.mp4$/i],
  ['data', /^assets\/data\/.+\.(json|txt|md)$/i],
  ['code', /\.(ts|tsx|js|jsx|json|md|txt)$/i]
]
export function assetKind(path: string): AssetKind | null {
  if (path.startsWith('node_modules/') || path.startsWith('bin/')) return null
  return KIND_TESTS.find(([, test]) => test.test(path))?.[0] ?? null
}
