import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markEdited, state, type Snapshot } from '@scene/state'
import type { LiveSceneInfo } from '@scene/bevy-api/interface'
import type { DclEditorHostV0 } from '../../engine/hosted'
import { hostedRoute, setHost } from '../../engine/hosted'
import { type DataLayerClient, setDataLayerClient } from '../../engine/datalayer'
import { flushPendingSave, markDirty } from '../../core/autosave'
import { boot, stopBoot } from '../../boot/boot'
import { backToProjects } from './nav'

// Hosted, one page opens scene after scene, and the project store writes into
// whichever one is open when a write lands. A Blank scene opened after a scene
// with scripts got that scene's Script entities merged into its main.composite,
// and its build failed on files only the other scene has.

vi.mock('@scene/cmd', async (real) => {
  const actual = await real<typeof import('@scene/cmd')>()
  return { cmd: { ...actual.cmd, crdtInitial: async () => ({}) } }
})
vi.mock('../../engine/console', async (real) => ({ ...(await real<object>()), engineReady: () => true }))
vi.mock('../../engine/bus', () => ({
  onSceneMessage: () => () => {},
  sendToScene: async () => {},
  sceneRpc: async () => undefined,
  startBusPolling: () => {},
  stopBus: () => {}
}))
vi.mock('../../prefabs/generate', () => ({ regenerateSpawnables: async () => ({ written: false, vendored: [], blocked: false, problems: [] }) }))
vi.mock('../../gameconfig/generate', () => ({ regenerateGameConfig: async () => ({ written: false }) }))

const COMPOSITE = 'assets/scene/main.composite'
const SCRIPT = 'asset-packs::Script'
const NAME = 'core-schema::Name'

// the shell's store: a write goes to the project open at that moment
const disk = new Map<string, Map<string, string>>()
let open: string | null = null
const store: DataLayerClient = {
  saveFile: async ({ path, content }) => {
    if (open === null) throw new Error('no project is open')
    const files = disk.get(open) ?? new Map<string, string>()
    files.set(path, new TextDecoder().decode(content))
    disk.set(open, files)
  },
  getFile: async () => ({ content: new Uint8Array() }),
  removeFiles: async () => ({ success: [], failed: [] }),
  getFilesSizes: async () => ({ files: [] })
}

const openCreatePage = vi.fn()
const host: DclEditorHostV0 = {
  version: 0,
  pageDir: '/',
  editorBase: '/',
  busSession: '',
  container: document.createElement('div'),
  engineConsole: async () => '',
  identity: () => ({ address: null, isGuest: true }),
  setMode: () => {},
  openPreview: async () => {},
  spawnEditorScene: async () => ({ hash: 'editor' }),
  exit: () => {},
  openCreatePage
}

const liveScene = (hash: string): LiveSceneInfo => ({
  hash, title: hash, parcels: [{ x: 0, y: 0 }], isPortable: false, isBroken: false, isBlocked: false, isSuper: false, sdkVersion: '7'
})

// what the scene-ready handler and an edit leave behind, without an engine
function loadScene(project: string, snapshot: Snapshot): void {
  state.scene = liveScene(`b64-${project}`)
  state.frozen = true
  state.snapshot = snapshot
  state.createdEntities = new Set(Object.keys(snapshot))
  for (const [id, comps] of Object.entries(snapshot)) for (const [name, value] of Object.entries(comps)) markEdited(id, name, value)
}

// opening a project from the Create page: the shell switches its store, then the editor boots
async function openProject(id: string): Promise<void> {
  hostedRoute.project = id
  open = id
  void boot()
  await vi.waitFor(() => expect(state.componentNames.length).toBeGreaterThan(0))
}

async function leaveProject(): Promise<void> {
  openCreatePage.mockClear()
  backToProjects()
  await vi.waitFor(() => expect(openCreatePage).toHaveBeenCalled())
  open = null
}

const delivery: Snapshot = {
  '512': { [NAME]: { value: 'Depot' }, [SCRIPT]: { value: [{ path: 'src/scripts/DeliveryGame.ts', priority: 0, layout: '{}' }] } }
}
const obby: Snapshot = { '512': { [NAME]: { value: 'Obby start' } }, '513': { [NAME]: { value: 'Platform' } } }

describe('switching scenes in one hosted page', () => {
  beforeEach(() => {
    disk.clear()
    setHost(host)
    window.editorShell = { closeProject: async () => {} } as unknown as typeof window.editorShell
    setDataLayerClient(store)
    state.componentNames = ['Transform']
  })
  afterEach(() => {
    stopBoot()
    hostedRoute.project = null
    setHost(null)
    setDataLayerClient(null)
    delete window.editorShell
  })

  it('saves only the new scene’s entities into the new scene', async () => {
    await openProject('delivery')
    loadScene('delivery', delivery)
    markDirty()
    expect((await flushPendingSave()).ok).toBe(true)
    expect(disk.get('delivery')?.get(COMPOSITE)).toContain('DeliveryGame.ts')
    await leaveProject()

    await openProject('obby')
    loadScene('obby', obby)
    markDirty()
    expect((await flushPendingSave()).ok).toBe(true)
    const written = disk.get('obby')?.get(COMPOSITE) ?? ''
    expect(written).toContain('Obby start')
    expect(written).not.toContain('DeliveryGame.ts')
    expect(written).not.toContain('Depot')
  })

  it('writes nothing of the last scene into the next one before the next one boots', async () => {
    await openProject('delivery')
    loadScene('delivery', delivery)
    markDirty()
    await flushPendingSave()
    await leaveProject()

    // the Create page opened the next scene: the store points at it, the editor has not booted yet
    hostedRoute.project = 'obby'
    open = 'obby'
    expect(state.snapshot).toEqual({})
    loadScene('delivery', delivery)
    markDirty()
    await flushPendingSave()
    expect(disk.get('obby')).toBeUndefined()
  })
})
