// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setHost, type DclEditorHostV0 } from '../engine/hosted'
import { probeDataLayer, setDataLayerClient, type DataLayerClient } from '../engine/datalayer'
import { ensureScriptRuntime } from './generate'

// Hosted, there is no dev server to dial: the web shell hands its project store in
// (web/src/main.tsx → setDataLayerClient) and boot probes it. The build tool's
// vendoring pass runs over that store, through the real data-layer module.

vi.mock('@scene/inspector', () => ({ writeComponent: async () => {}, setOnSnapshotReady: () => {} }))
vi.mock('@scene/state', () => ({ state: { snapshot: {} } }))

const files = new Map<string, Uint8Array>()
const store: DataLayerClient = {
  saveFile: async ({ path, content }) => {
    files.set(path, content)
  },
  getFile: async ({ path }) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`no such file: ${path}`)
    return { content }
  },
  removeFiles: async () => ({ success: [], failed: [] }),
  getFilesSizes: async () => ({ files: [...files.keys()].sort().map((path) => ({ path })) })
}

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
  openCreatePage: () => {}
}

describe('vendoring the script runtime in the hosted editor', () => {
  beforeEach(() => {
    files.clear()
    setHost(host)
    setDataLayerClient(store)
  })
  afterEach(() => {
    setDataLayerClient(null)
    setHost(null)
  })

  it('copies a module a script imports, and its icons, through the project store the shell provides', async () => {
    files.set('src/scripts/hud.tsx', new TextEncoder().encode("import { actionIcon } from './runtime/actionIcons'\nexport const grab = actionIcon('pick-up')\n"))
    expect(await probeDataLayer()).toBe(true)

    const result = await ensureScriptRuntime()

    expect(result.vendored).toContain('src/scripts/runtime/actionIcons.tsx')
    expect(files.has('src/scripts/runtime/actionIcons.tsx')).toBe(true)
    expect([...files.keys()].some((path) => path.startsWith('assets/images/action-icons/'))).toBe(true)
  })
})
