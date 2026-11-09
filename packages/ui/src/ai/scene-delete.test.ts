import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserSceneRequest } from './scene'
import { state } from '@scene/state'
import { uiDeleteEntityRecursive } from '../actions/entities'

type Snap = Record<string, Record<string, unknown>>

const { codeIds, deleteRecursive } = vi.hoisted(() => ({
  codeIds: new Set<string>(),
  deleteRecursive: vi.fn()
}))
vi.mock('@scene/state', () => ({
  state: { snapshot: {}, frozen: true, selected: new Set(), editStatus: new Map(), activeEntity: null },
  componentKey: (id: string, name: string) => `${id}:${name}`,
  isUiEntity: (snapshot: Snap, id: string) => snapshot[id]?.UiTransform !== undefined,
  isRuntimeEntity: () => false,
  provenanceBaseline: () => null
}))
vi.mock('@scene/custom-components', () => ({
  entityName: (snapshot: Snap, id: string) => (snapshot[id]?.['core::Name'] as { value?: string } | undefined)?.value,
  nameKey: (name: string) => name.trim().toLowerCase(),
  NAME_COMPONENT: 'core::Name'
}))
vi.mock('../panels/hierarchy-model', () => ({ isCodeEntity: (_: Snap, id: string) => codeIds.has(id) }))
vi.mock('../panels/authored-ids', () => ({ authoredFromComposite: () => null }))
vi.mock('../actions/entities', () => ({ uiAddEntity: vi.fn(), uiDeleteEntityRecursive: deleteRecursive }))
vi.mock('../engine/cmd', () => ({ cmd: {} }))
vi.mock('../actions/components', () => ({ uiSetComponentValue: vi.fn(), uiDeleteComponent: vi.fn() }))
vi.mock('../assets', () => ({ importCatalogFile: vi.fn(), loadModelCatalog: vi.fn(), modelById: vi.fn(), ensureContentMapped: vi.fn() }))
vi.mock('../engine/datalayer', () => ({ dataLayerListFiles: vi.fn(), dataLayerReadFile: vi.fn(), dataLayerReadFileBytes: vi.fn(), dataLayerSaveFile: vi.fn(), dataLayerSaveFileBytes: vi.fn() }))
vi.mock('./library-bytes', () => ({ materialBytes: vi.fn(), soundBytes: vi.fn() }))
vi.mock('../engine/bus', () => ({ sendToScene: vi.fn() }))
vi.mock('./code-model', () => ({ buildCodeModel: vi.fn(), overBudget: () => [], MODEL_BUDGET: {} }))
vi.mock('./requests', () => ({ runRequestText: vi.fn() }))
vi.mock('../actions/prefabs', () => ({ createPrefabFrom: vi.fn() }))
vi.mock('../actions/spawned-only', () => ({ uiSetSpawnedOnly: vi.fn() }))
vi.mock('../core/autosave', () => ({ asAssistant: <T>(work: () => Promise<T>) => work(), flushPendingSave: vi.fn() }))
vi.mock('../panels/prefab-store', () => ({ prefabStore: { items: [] }, refreshPrefabs: vi.fn() }))
vi.mock('./request-format', () => ({
  // the real lookup: an id, else the first entity with that name
  resolveEntityRef: (snapshot: Snap, ref: string) =>
    snapshot[ref] !== undefined ? ref
      : Object.keys(snapshot).find((id) => (snapshot[id]?.['core::Name'] as { value?: string } | undefined)?.value?.toLowerCase() === ref.toLowerCase()) ?? null
}))
vi.mock('../features/editor/scene-check-context', () => ({ refreshSceneChecks: vi.fn(), invalidateSceneCheckCache: vi.fn() }))

const named = (name: string, parent = 0): Record<string, unknown> => ({
  'core::Name': { value: name },
  Transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, parent }
})

const signal = new AbortController().signal

beforeEach(() => {
  codeIds.clear()
  state.frozen = true
  state.snapshot = {
    '512': named('Old Station'),
    '513': named('Counter', 512),
    '514': named('Sign', 513),
    '515': named('New Station'),
    '516': named('Crate'),
    '517': named('Crate')
  }
  // the hand delete takes the subtree out of the snapshot
  deleteRecursive.mockReset().mockImplementation(async (id: string) => {
    const gone = [id]
    for (let i = 0; i < gone.length; i++) {
      for (const [child, c] of Object.entries(state.snapshot)) {
        if ((c.Transform as { parent: number }).parent === Number(gone[i])) gone.push(child)
      }
    }
    state.snapshot = Object.fromEntries(Object.entries(state.snapshot).filter(([e]) => !gone.includes(e)))
  })
})

describe('the assistant deleting an entity', () => {
  it('goes through the Delete key, children included, and names everything that went', async () => {
    expect(await browserSceneRequest({ type: 'deleteEntity', entity: 'Old Station' }, signal)).toEqual({
      id: '512',
      name: 'Old Station',
      deleted: [{ id: '512', name: 'Old Station' }, { id: '513', name: 'Counter' }, { id: '514', name: 'Sign' }]
    })
    expect(uiDeleteEntityRecursive).toHaveBeenCalledWith('512')
    expect(Object.keys(state.snapshot)).toEqual(['515', '516', '517'])
  })

  it('takes an id, and the target named as to like the other edits', async () => {
    await browserSceneRequest({ type: 'deleteEntity', entity: '515' }, signal)
    await browserSceneRequest({ type: 'deleteEntity', to: '514' }, signal)
    expect(deleteRecursive.mock.calls).toEqual([['515'], ['514']])
  })

  it('refuses a name two entities share, naming their ids', async () => {
    await expect(browserSceneRequest({ type: 'deleteEntity', entity: 'Crate' }, signal)).rejects.toThrow('ids 516, 517')
    expect(deleteRecursive).not.toHaveBeenCalled()
  })

  it('refuses what the scene\'s code creates, as the hierarchy does', async () => {
    codeIds.add('515')
    await expect(browserSceneRequest({ type: 'deleteEntity', entity: 'New Station' }, signal)).rejects.toThrow('made by the scene\'s code')
    expect(deleteRecursive).not.toHaveBeenCalled()
  })

  it('refuses the scene root, reserved and UI entities, and names that match nothing', async () => {
    state.snapshot = { ...state.snapshot, '0': {}, '2': named('Player'), '600': { ...named('Hud'), UiTransform: {} } }
    for (const ref of ['0', '2', 'Hud', 'Nothing']) {
      await expect(browserSceneRequest({ type: 'deleteEntity', entity: ref }, signal)).rejects.toThrow('No editable entity')
    }
    await expect(browserSceneRequest({ type: 'deleteEntity' }, signal)).rejects.toThrow('An entity id or unique name is required.')
    expect(deleteRecursive).not.toHaveBeenCalled()
  })

  it('waits for edit mode, as every other edit does', async () => {
    state.frozen = false
    await expect(browserSceneRequest({ type: 'deleteEntity', entity: 'Old Station' }, signal)).rejects.toThrow('The scene is playing.')
    expect(deleteRecursive).not.toHaveBeenCalled()
  })

  it('says so when the entity is still there afterwards', async () => {
    deleteRecursive.mockResolvedValue(undefined)
    await expect(browserSceneRequest({ type: 'deleteEntity', entity: 'New Station' }, signal)).rejects.toThrow('"New Station" could not be deleted.')
  })

  it('removes a replaced piece inside the batch that replaces it', async () => {
    const reply = await browserSceneRequest({
      type: 'batch',
      requests: [{ type: 'deleteEntity', entity: 'Old Station' }, { type: 'deleteEntity', entity: 'Old Station' }]
    }, signal) as { results: { ok: boolean }[] }
    expect(reply.results.map((r) => r.ok)).toEqual([true, false])
  })
})
