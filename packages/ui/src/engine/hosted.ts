// Hosted mode: the editor runs inside a page that already owns the engine
// (bevy-web) instead of hosting the engine in an iframe. The page hands over
// this object (editor host contract v0 or v1); null means the desktop / iframe path.
import { reactive } from '@scene/reactive'

export interface DclEditorHostV0 {
  version: 0
  pageDir: string
  editorBase: string
  busSession: string
  container: HTMLElement
  engineConsole(line: string): Promise<string>
  identity(): { address: string | null; isGuest: boolean }
  setMode(mode: 'edit' | 'play' | 'off'): void
  setViewportActive?(active: boolean): void
  openPreview(projectId: string, position: string): Promise<void>
  spawnEditorScene(): Promise<{ hash: string }>
  exit(): void
  // contract v1.1: the HUD's Create page, where the scenes are listed
  openCreatePage?(): void
  // the open preview's `/values…` and `/players/<address>/values…`, as its server copy reaches them
  previewStorageFetch?(path: string, init?: HostFetchInit): Promise<Response>
}

export interface HostFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit | null
  // contract v1.2, for services.signed urls: ADR-44 metadata, and aborting the request
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}

// contract v1.2: Decentraland's services the host signs for, beside the project storage
export interface SignedServices {
  worldsContent: string
  commsGatekeeper: string
  storage: string
  creatorsData: string
  multiplayer: string
}

export interface DeploymentRequest {
  world: string
  entityId: string
  title: string
  fileCount: number
  bytes: number
}

export type AuthChain = Array<{ type: string; payload: string; signature: string }>

export interface DclEditorHostV1 extends Omit<DclEditorHostV0, 'version'> {
  version: 1
  // from `?editor=<id>`
  openProject: string | null
  services: {
    // no trailing slash; null: no project storage for this page
    projects: string | null
    worldsContent: string
    // only when worldsContent is Decentraland's own (.org or .zone)
    signed?: SignedServices
  }
  // rejects 'not-signed-in' for a guest, 'not-allowed' for a url or method the host does not sign,
  // 'cancelled' when the player declines a scene removal
  signedFetch(url: string, init?: HostFetchInit): Promise<Response>
  // the host asks the player first; rejects 'cancelled' or 'not-signed-in'
  signDeployment(request: DeploymentRequest): Promise<AuthChain>
  // contract v1.3: the open preview's scene server console after `after` (a seq it returned, 0 for all)
  previewServerLogs?(after: number): ServerLogLine[]
  // contract v1.3: a build landed in the open preview, so the host restarts its scene server on it
  previewChanged?(): void
}

export interface ServerLogLine {
  seq: number
  level: 'log' | 'error' | 'system'
  msg: string
}

export type DclEditorHost = DclEditorHostV0 | DclEditorHostV1

let host: DclEditorHost | null = null

export function setHost(h: DclEditorHost | null): void {
  host = h
  editorScene = null
}

export function getHost(): DclEditorHost | null {
  return host
}

// A v0 host has no services and signs nothing: sync and publish are unavailable.
export function hostV1(h: DclEditorHost | null = host): DclEditorHostV1 | null {
  return h !== null && h.version === 1 ? h : null
}

export function isHosted(): boolean {
  return host !== null
}

// There is no page navigation in hosted mode: null is no scene open. `opens`
// counts openProject calls: opening the project already open starts it over.
// `notice` is one line for the Create page to show once.
export const hostedRoute = reactive({ project: null as string | null, opens: 0, notice: null as string | null })

// The host spawns the editor scene once and answers every later call with the
// same instance. That instance picked its edit target as it booted, so each
// project after the first needs a new one: reload it, by its hash.
let editorScene: string | null = null

export function editorSceneHash(): string | null {
  return editorScene
}

export async function startEditorScene(reload: (hash: string) => Promise<unknown>): Promise<void> {
  if (host === null) return
  const { hash } = await host.spawnEditorScene()
  if (editorScene === hash) await reload(hash)
  editorScene = hash
}

// The scene sandbox appends the tab's session to every channel name it opens;
// the page side has to spell the same name.
export function busChannelName(base: string): string {
  return host !== null && host.busSession !== '' ? `${base}#${host.busSession}` : base
}

export const EDITOR_UI_HOST_ID = 'editor-ui-host'

// Did the event start inside the editor's own UI (its shadow root)?
export function fromEditorUi(e: Event): boolean {
  return e.composedPath().some((n) => n instanceof HTMLElement && n.id === EDITOR_UI_HOST_ID)
}
