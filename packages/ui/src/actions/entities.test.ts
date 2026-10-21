import { beforeEach, describe, expect, it, vi } from 'vitest'

// Real history; the scene double mirrors boot.ts's observer, which records each
// writeComponent unless history is suppressed.

const scene = vi.hoisted(() => ({
  state: {
    snapshot: {} as Record<string, Record<string, unknown>>,
    activeEntity: null as string | null,
    assetBusy: false,
    saveStatus: '',
    frozen: true
  },
  created: [] as string[],
  observer: null as ((entityId: string, name: string, after: unknown, before: unknown) => void) | null
}))

const NAME = 'core-schema::Name'

// the engine instantiates each entity with its Name outside the write path; every
// other component is an ordinary write
const allocate = vi.hoisted(() => (name: string): string => {
  const id = String(700 + scene.created.length)
  scene.created.push(id)
  scene.state.snapshot[id] = { 'core-schema::Name': { value: name } }
  return id
})
const writeComponent = vi.hoisted(() => (entityId: string, name: string, json: string): Promise<void> => {
  const before = scene.state.snapshot[entityId]?.[name]
  scene.state.snapshot[entityId] = { ...scene.state.snapshot[entityId], [name]: JSON.parse(json) as unknown }
  scene.observer?.(entityId, name, JSON.parse(json), before)
  return Promise.resolve()
})

type Clip = { rootId: string; order: string[]; components: Record<string, Record<string, unknown>> }

vi.mock('@scene/state', () => ({
  state: scene.state,
  setSelected: () => {},
  topLevelSelected: () => [],
  componentKey: (id: string, name: string) => `${id}:${name}`,
  setComponentExpanded: () => {}
}))
vi.mock('@scene/reactive', () => ({ notify: () => {} }))
vi.mock('../analytics', () => ({ trackCreator: () => {} }))
vi.mock('@scene/custom-components', () => ({ NAME_COMPONENT: 'core-schema::Name', entityName: () => undefined }))
vi.mock('@scene/world-pos', () => ({ rootLocalForWorld: () => null }))
vi.mock('@scene/inspector', () => {
  const captureEntityTree = (rootId: string): Clip => {
    const order = [rootId]
    for (let i = 0; i < order.length; i++) {
      for (const [id, comps] of Object.entries(scene.state.snapshot)) {
        if ((comps.Transform as { parent?: number } | undefined)?.parent === Number(order[i])) order.push(id)
      }
    }
    const components = Object.fromEntries(order.map((id) => [id, structuredClone(scene.state.snapshot[id])]))
    return { rootId, order, components }
  }
  const instantiateEntityTree = async (clip: Clip): Promise<string> => {
    const ids = new Map(clip.order.map((old) => [old, allocate(`${String((clip.components[old][NAME] as { value: string }).value)} copy`)]))
    for (const old of clip.order) {
      for (const [n, v] of Object.entries(clip.components[old])) {
        if (n === NAME) continue
        const value = structuredClone(v) as { parent?: number }
        if (n === 'Transform' && ids.has(String(value.parent))) value.parent = Number(ids.get(String(value.parent)))
        await writeComponent(ids.get(old) as string, n, JSON.stringify(value))
      }
    }
    return ids.get(clip.rootId) as string
  }
  return {
    writeComponent,
    captureEntityTree,
    instantiateEntityTree,
    duplicateEntityTree: (id: string) => instantiateEntityTree(captureEntityTree(id)),
    deleteComponent: (entityId: string, name: string) => {
      const { [name]: _drop, ...rest } = scene.state.snapshot[entityId] ?? {}
      scene.state.snapshot[entityId] = rest
    },
    // the engine instantiates the entity with its Name outside the write path,
    // then every other component is an ordinary write
    addEntity: async (
      name: string,
      parent: number,
      position = { x: 0, y: 0, z: 0 },
      components: Record<string, unknown> = {}
    ): Promise<string> => {
      const id = '600'
      scene.state.snapshot[id] = { 'core-schema::Name': { value: name } }
      for (const [n, v] of Object.entries({ ...components, Transform: { position, parent } })) {
        await writeComponent(id, n, JSON.stringify(v))
      }
      scene.state.activeEntity = id
      return id
    }
  }
})
vi.mock('../prefabs/instantiate', () => ({
  instantiatePrefab: async (_folder: string, position: { x: number; y: number; z: number }) => {
    const root = allocate('Gate')
    const child = allocate('Gate_2')
    await writeComponent(root, 'Transform', JSON.stringify({ position, scale: { x: 1, y: 2, z: 1 }, parent: 0 }))
    await writeComponent(root, 'TriggerArea', JSON.stringify({}))
    await writeComponent(root, 'inspector::CustomAsset', JSON.stringify({ assetId: 'gate' }))
    await writeComponent(child, 'Transform', JSON.stringify({ parent: Number(root) }))
    await writeComponent(child, 'GltfContainer', JSON.stringify({ src: 'gate.glb' }))
    return { rootId: root, data: { name: 'Gate' }, warnings: [], permissionsAdded: [], hasScripts: false }
  }
}))
vi.mock('../prefabs/sdk-gate', () => ({ blockedBySdk: async () => false }))
vi.mock('../engine/bus', () => ({ sendToScene: async () => {} }))
vi.mock('../core/autosave', () => ({ flushPendingSave: async () => {} }))
vi.mock('../engine/datalayer', () => ({}))
vi.mock('../panels/prefab-store', () => ({}))
vi.mock('../prefabs/library', () => ({}))
vi.mock('../prefabs/storage', () => ({}))
vi.mock('../prefabs/update', () => ({}))
vi.mock('../prefabs/generate', () => ({}))
vi.mock('../assets', () => ({
  dropPosition: async () => ({ x: 8, y: 0, z: 8 }),
  uniqueEntityName: (base: string) => base
}))
vi.mock('../panels/reveal', () => ({ revealInTree: () => {} }))
vi.mock('./run', () => ({ run: async (p: Promise<unknown>) => p }))
vi.mock('./selection', () => ({ syncSelectionToScene: () => {}, ensureTransformTool: () => {}, focusPlaced: () => {} }))

import { canUndo, isHistorySuppressed, pushHistory, redo, undo } from '../core/history'
import { uiAddBox, uiAddEntity, uiCopyEntity, uiDuplicateEntity, uiPasteEntity } from './entities'
import { uiPlacePrefab } from './prefabs'

beforeEach(async () => {
  while (canUndo()) await undo()
  scene.state.snapshot = {}
  scene.created = []
  scene.observer = (entityId, name, after, before) => {
    if (!isHistorySuppressed()) pushHistory([{ entityId, name, before, after }])
  }
})

describe('undoing an entity creation', () => {
  it.each([
    ['New entity', () => uiAddEntity('Lamp', 0)],
    ['Add a box', () => uiAddBox()]
  ])('%s: one undo removes the whole entity and redo brings it back', async (_label, create) => {
    await create()
    const id = scene.state.activeEntity as string
    const created = JSON.parse(JSON.stringify(scene.state.snapshot[id])) as Record<string, unknown>

    await undo()
    expect(scene.state.snapshot[id]).toEqual({})
    expect(canUndo()).toBe(false)

    await redo()
    expect(scene.state.snapshot[id]).toEqual(created)
  })
})

// A copy or a placed prefab is a whole subtree; ⌘Z must take every entity of it.
describe('undoing a copy or a placed prefab', () => {
  const seedTable = (): void => {
    scene.state.snapshot = {
      '512': { [NAME]: { value: 'Table' }, Transform: { parent: 0 }, MeshRenderer: { mesh: { box: {} } } },
      '513': { [NAME]: { value: 'Leg' }, Transform: { parent: 512 }, MeshCollider: { mesh: { box: {} } } }
    }
  }

  it.each([
    ['Duplicate', () => (seedTable(), uiDuplicateEntity('512'))],
    ['Paste', () => (seedTable(), uiCopyEntity('512'), uiPasteEntity())],
    ['Place a prefab', () => uiPlacePrefab('custom/gate', 'prefabs_panel')]
  ])('%s: one undo removes every created entity and redo brings them back', async (_label, create) => {
    await create()
    const created = scene.created.map((id) => [id, structuredClone(scene.state.snapshot[id])] as const)
    expect(created.length).toBe(2)

    await undo()
    for (const [id] of created) expect(scene.state.snapshot[id]).toEqual({})
    expect(canUndo()).toBe(false)

    await redo()
    for (const [id, comps] of created) expect(scene.state.snapshot[id]).toEqual(comps)
  })
})
