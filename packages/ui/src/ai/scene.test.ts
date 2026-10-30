import { describe, expect, it, vi } from 'vitest'
import { browserSceneRequest } from './scene'
import { state } from '@scene/state'
import { importCatalogFile, loadModelCatalog, modelById, type ModelAsset } from '../assets'
import { inspectModel } from '../model-info'
import { sceneTextures } from '../scene-budget'
import { buildCodeModel } from './code-model'
import { materialFile } from '../three/materials'
import { dataLayerListFiles, dataLayerSaveFileBytes } from '../engine/datalayer'
import { soundBytes } from './library-bytes'
import { createPrefabFrom } from '../actions/prefabs'
import { flushPendingSave } from '../core/autosave'
import { uiSetSpawnedOnly } from '../actions/spawned-only'

const { setValue, deleteValue, status } = vi.hoisted(() => {
  const status = new Map<string, string>()
  const setValue = vi.fn(async (key: string) => {
    status.set(key, '✓ set')
  })
  const deleteValue = vi.fn()
  return { setValue, deleteValue, status }
})
vi.mock('@scene/state', () => ({
  state: { snapshot: { '512': {} }, frozen: true, selected: new Set(), editStatus: status, activeEntity: null, schemas: new Map() },
  componentKey: (id: string, name: string) => `${id}:${name}`,
  isUiEntity: () => false, isRuntimeEntity: () => false, provenanceBaseline: () => null
}))
vi.mock('@scene/custom-components', () => ({ entityName: () => 'Box', NAME_COMPONENT: 'core::Name' }))
vi.mock('../engine/cmd', () => ({ cmd: { componentSchema: () => Promise.reject(new Error('no engine')) } }))
vi.mock('@scene/allowed-components', () => ({ isAllowedComponent: () => true }))
vi.mock('../actions/entities', () => ({ uiAddEntity: vi.fn() }))
vi.mock('../actions/components', () => ({ uiSetComponentValue: setValue, uiDeleteComponent: deleteValue }))
vi.mock('../assets', () => ({ importCatalogFile: vi.fn(), loadModelCatalog: vi.fn(async () => []), modelById: vi.fn(() => undefined), ensureContentMapped: vi.fn() }))
vi.mock('../engine/datalayer', async (real) => ({ ...(await real<object>()), dataLayerListFiles: vi.fn(), dataLayerReadFileBytes: vi.fn(async () => new Uint8Array(0)), dataLayerSaveFileBytes: vi.fn() }))
vi.mock('./library-bytes', () => ({ materialBytes: vi.fn(), soundBytes: vi.fn() }))
vi.mock('../engine/bus', () => ({ sendToScene: vi.fn() }))
vi.mock('./code-model', () => ({ buildCodeModel: vi.fn(async () => { throw new Error('built') }), overBudget: () => [], MODEL_BUDGET: {} }))
vi.mock('./requests', () => ({ runRequestText: vi.fn() }))
vi.mock('../actions/prefabs', () => ({ createPrefabFrom: vi.fn(async (_: string[], name: string) => ({ id: 'p-bot', folder: 'custom/bot', name, warnings: [] })) }))
vi.mock('../actions/spawned-only', () => ({ uiSetSpawnedOnly: vi.fn() }))
vi.mock('../core/autosave', () => ({ flushPendingSave: vi.fn(async () => ({ pending: true, ok: true })) }))
vi.mock('../panels/prefab-store', () => ({ prefabStore: { items: [] }, refreshPrefabs: vi.fn(async () => [{ folder: 'custom/zombie', data: { id: 'p-zombie', name: 'Zombie' } }]) }))
vi.mock('../model-info', async (real) => ({ ...(await real<object>()), inspectModel: vi.fn() }))
vi.mock('../scene-budget', async (real) => ({ ...(await real<object>()), sceneTextures: vi.fn() }))
vi.mock('./request-format', () => ({ resolveEntityRef: (_: unknown, ref: string) => ref }))
vi.mock('../features/editor/scene-check-context', () => ({
  refreshSceneChecks: async () => [{ id: 'empty-prefab-ref', level: 'blocker', title: 'Nothing picked', detail: 'Pick a prefab', entityId: '512', fix: { label: 'x', action: 'y' } }]
}))

// real catalog entries, only the fields the search reads
const asset = (a: Omit<ModelAsset, 'id' | 'filename' | 'url' | 'collection'>): ModelAsset => ({ id: a.name, filename: '', url: '', collection: '', ...a })
const catalog = [
  asset({ name: 'Basenji Dog Photo Print', category: 'decoration', subcategory: 'picture', tags: ['frame', 'textured', 'picture', 'basenji', 'dog', 'flat', 'low-poly', 'photo'], description: 'A flat picture or photo of a Basenji dog, suitable as wall art or decoration.', width: 0.79, height: 0, depth: 1, triangles: 6 }),
  asset({ name: 'METADOGE Dough Cut', category: 'prop', subcategory: 'cookie-cutter', tags: ['cookie', 'dough', 'baking', 'minigame', 'flat', 'low-poly', 'dog-shaped', 'textured', 'cutout'], description: 'A flat dog-shaped dough cutout with a printed texture, used as a cookie-cutter game piece.', width: 0.79, height: 0, depth: 1, triangles: 6 }),
  asset({ name: 'Block Dog.1', category: 'character', subcategory: 'dog', tags: ['walking', 'blocky', 'pet', 'dog', 'low-poly', 'cute', 'animated', 'textured'], description: 'An animated blocky dog character with standing, idle, drinking, walking, and sitting animations.', width: 1.58, height: 0.47, depth: 0.87, triangles: 126 }),
  asset({ name: 'Doge NPC Anim4', category: 'character', subcategory: 'dog', tags: ['idle', 'NPC', 'wave', 'high-poly', 'dog', 'talk', 'walk', 'animated', 'doge', 'textured'], description: 'An animated Doge NPC character with walk, talk, wave, thinking, and idle animations.', width: 1.42, height: 1.75, depth: 0.8, triangles: 1970 }),
  asset({ name: 'Cemetery Tombstones & Gravestones Set', category: 'decoration', subcategory: 'tombstone', tags: ['textured', 'high-poly', 'large-scale', 'tombs', 'gravestones', 'cemetery', 'halloween', 'spiderweb', 'graveyard'], description: 'A collection of cemetery tombstones and grave markers with spider webs spread across a large area.', width: 76.28, height: 4.12, depth: 74.39, triangles: 117666 }),
  asset({ name: 'Stone 03', category: 'nature', subcategory: 'rock', tags: ['textured', 'stone', 'rock', 'boulder', 'fantasy', 'dark', 'collider'], description: 'Dark rocky boulder with collider, suitable for fantasy landscape decoration.', width: 2.93, height: 1.22, depth: 2.57, triangles: 488 }),
  asset({ name: 'Rock01 Rework', category: 'nature', subcategory: 'rock', tags: ['animated', 'textured', 'low-poly', 'rock', 'stone', 'boulder', 'interactive', 'nature'], description: 'A dark low-poly rock with tap interaction animation, suitable for meadow and nature environments.', width: 1.81, height: 1, depth: 1.79, triangles: 135 })
]

async function found(query: string): Promise<string[]> {
  vi.mocked(loadModelCatalog).mockResolvedValueOnce(catalog)
  const reply = await browserSceneRequest({ type: 'findModels', query }, new AbortController().signal) as { models: { name: string }[] }
  return reply.models.map((m) => m.name)
}

describe('assistant scene requests', () => {
  it('writes a oneof the model gave in the SDK form the way the engine reads it', async () => {
    const green = { r: 0.1, g: 0.8, b: 0.2, a: 1 }
    await browserSceneRequest(
      { type: 'setComponent', to: '512', component: 'Material', value: { material: { $case: 'pbr', pbr: { albedoColor: green } } }, expected: null },
      new AbortController().signal
    )
    expect(setValue).toHaveBeenCalledWith('512:Material', '512', 'Material', JSON.stringify({ material: { pbr: { albedoColor: green } } }))
  })

  it('answers check with the editor\'s findings, naming the entity each one is about', async () => {
    expect(await browserSceneRequest({ type: 'check' }, new AbortController().signal)).toEqual({
      visuals: { modelEntities: 0, modelPaths: [], primitiveEntities: 0 }, liveParcels: [],
      budget: expect.objectContaining({ parcels: 1, over: [] }),
      findings: [{ level: 'blocker', title: 'Nothing picked', detail: 'Pick a prefab', entity: 'Box' }]
    })
  })

  it('applies a patch over the current value without an inspect, and keeps the rest', async () => {
    setValue.mockClear()
    state.snapshot['512'] = { Transform: { position: { x: 1, y: 0.5, z: 1 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, parent: 0 } }
    await browserSceneRequest(
      { type: 'setComponent', to: '512', component: 'Transform', patch: { position: { y: 3.5 } } },
      new AbortController().signal
    )
    expect(JSON.parse(String((setValue.mock.calls as unknown[][]).at(-1)?.[3]))).toMatchObject({ position: { x: 1, y: 3.5, z: 1 }, scale: { x: 1, y: 1, z: 1 } })
  })

  it('answers a batch with what each request did, not the components it wrote', async () => {
    state.snapshot['512'] = { Transform: { position: { x: 1, y: 0.5, z: 1 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, parent: 0 } }
    const answer = await browserSceneRequest(
      { type: 'batch', requests: [{ type: 'setComponent', to: '512', component: 'Transform', patch: { position: { y: 2 } } }] },
      new AbortController().signal
    )
    expect(answer).toEqual({ results: [{ ok: true, result: { id: '512', component: 'Transform' } }] })
  })

  it('moves an entity by an offset in one request', async () => {
    state.snapshot['512'] = { Transform: { position: { x: 1, y: 0.5, z: 1 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, parent: 0 } }
    expect(await browserSceneRequest({ type: 'move', to: '512', by: { y: 2 } }, new AbortController().signal)).toEqual({ id: '512', position: { x: 1, y: 2.5, z: 1 } })
    await expect(browserSceneRequest({ type: 'move', to: '512', by: {} }, new AbortController().signal)).rejects.toThrow('move needs')
  })

  it('removes a component through the editor action, but never Transform or the name', async () => {
    state.snapshot['512'] = { Transform: { position: { x: 1, y: 0.5, z: 1 } }, MeshRenderer: { mesh: { box: {} } } }
    deleteValue.mockImplementation((id: string, name: string) => { delete state.snapshot[id][name] })
    expect(await browserSceneRequest({ type: 'removeComponent', to: '512', component: 'MeshRenderer' }, new AbortController().signal))
      .toEqual({ id: '512', component: 'MeshRenderer', components: { Transform: { position: { x: 1, y: 0.5, z: 1 } } } })
    expect(deleteValue).toHaveBeenCalledWith('512', 'MeshRenderer')
    expect(await browserSceneRequest({ type: 'removeComponent', to: '512', component: 'Material' }, new AbortController().signal)).toEqual({ id: '512', component: 'Material', removed: false })
    for (const component of ['Transform', 'core::Name']) {
      await expect(browserSceneRequest({ type: 'removeComponent', to: '512', component }, new AbortController().signal)).rejects.toThrow('cannot be removed')
    }
    expect(deleteValue).toHaveBeenCalledTimes(1)
  })

  it('finds the models a request means: whole words, real props before flat pictures', async () => {
    const dog = await found('dog')
    expect(dog.slice(0, 2).sort()).toEqual(['Block Dog.1', 'Doge NPC Anim4'])
    expect(dog.slice(2).sort()).toEqual(['Basenji Dog Photo Print', 'METADOGE Dough Cut'])
    const stones = await found('stones')
    expect(stones.slice(0, 2).sort()).toEqual(['Rock01 Rework', 'Stone 03'])
  })

  it('refuses a model whose shared materials would take the scene past its texture limit, counting the ones it already has once', async () => {
    const maps = (['stone-blocks', 'red-brick'] as const).flatMap((name) => [materialFile(name, 'color'), materialFile(name, 'normal')])
    vi.mocked(buildCodeModel).mockResolvedValueOnce({ bytes: new Uint8Array(8), clips: [], library: ['stone-blocks', 'red-brick'], warnings: [] })
    vi.mocked(inspectModel).mockReturnValueOnce({ triangles: 100, materials: [{}, {}], textures: 4, largestImage: 512, sharedImages: maps, externalResources: maps } as unknown as ReturnType<typeof inspectModel>)
    vi.mocked(sceneTextures).mockResolvedValueOnce({ used: 8, limit: 10, shared: new Set([`models/${materialFile('stone-blocks', 'color')}`]) })
    await expect(browserSceneRequest({ type: 'buildModel', name: 'Tower', code: 'root', position: { x: 8, y: 0, z: 8 } }, new AbortController().signal))
      .rejects.toThrow('The scene has 2 of its 10 textures left and this model would add 3')
  })

  it('builds into a stand-in without a name, the way the prompt shows it', async () => {
    await expect(browserSceneRequest({ type: 'buildModel', into: '512', code: 'root' }, new AbortController().signal)).rejects.toThrow('built')
  })

  it('adds a library sound to its own folder once, never over an unreadable project, and names the sounds when asked for one it lacks', async () => {
    const mp3 = new Uint8Array([0xff, 0xfb])
    vi.mocked(soundBytes).mockResolvedValue(mp3)
    const path = 'assets/audio/library/fire-loop.mp3'
    vi.mocked(dataLayerListFiles).mockResolvedValueOnce(['assets/audio/fire-loop.mp3']).mockResolvedValueOnce([path]).mockRejectedValueOnce(new Error('offline'))
    const added = await browserSceneRequest({ type: 'addSound', name: 'fire-loop' }, new AbortController().signal)
    expect(added).toMatchObject({ path, loop: true, durationSeconds: expect.any(Number) })
    expect(await browserSceneRequest({ type: 'addSound', name: 'fire-loop' }, new AbortController().signal)).toEqual(added)
    await expect(browserSceneRequest({ type: 'addSound', name: 'fire-loop' }, new AbortController().signal)).rejects.toThrow('offline')
    expect(dataLayerSaveFileBytes).toHaveBeenCalledTimes(1)
    expect(dataLayerSaveFileBytes).toHaveBeenCalledWith(path, mp3)
    await expect(browserSceneRequest({ type: 'addSound', name: 'banjo' }, new AbortController().signal)).rejects.toThrow('one of: coin, gem,')
  })

  it('places a catalog model that takes the scene past its texture limit, and says so, counting a file the scene has once', async () => {
    vi.mocked(modelById).mockReturnValueOnce(asset({ name: 'Stone 03', category: 'nature', tags: [] }))
    vi.mocked(importCatalogFile).mockResolvedValueOnce('models/catalog/stone-03.glb')
    vi.mocked(inspectModel).mockReturnValueOnce({ materials: ['Stone'], textures: 3, sharedImages: ['materials/T_Rock_D.jpg'] } as unknown as ReturnType<typeof inspectModel>)
    vi.mocked(sceneTextures).mockResolvedValueOnce({ used: 9, limit: 10, shared: new Set(['models/catalog/materials/T_Rock_D.jpg']) })
    const placed = await browserSceneRequest({ type: 'placeModel', id: 'Stone 03', into: '512' }, new AbortController().signal)
    expect(placed).toMatchObject({ model: 'models/catalog/stone-03.glb', textures: 3, materials: 1, sceneTexturesLeft: -1, warning: expect.stringContaining('11 of its 10 textures') })
  })

  it('makes a scene entity a prefab a spawner can point at, kept out of the build and of the creator\'s library', async () => {
    const made = await browserSceneRequest({ type: 'createPrefab', from: '512' }, new AbortController().signal)
    expect(made).toEqual({ entity: '512', prefab: 'p-bot', folder: 'custom/bot', name: 'Box' })
    expect(createPrefabFrom).toHaveBeenCalledWith(['512'], 'Box', { spawnedOnly: true, library: false })
    expect(flushPendingSave).toHaveBeenCalled()
    await browserSceneRequest({ type: 'createPrefab', from: '512', name: 'Bot', spawnedOnly: false }, new AbortController().signal)
    expect(createPrefabFrom).toHaveBeenLastCalledWith(['512'], 'Bot', { spawnedOnly: false, library: false })
    expect(uiSetSpawnedOnly).toHaveBeenLastCalledWith('512', false)
  })

  it('answers the prefab an entity already is instead of making a second one', async () => {
    state.snapshot['513'] = { 'inspector::CustomAsset': { assetId: 'p-zombie' } }
    vi.mocked(createPrefabFrom).mockClear()
    const made = await browserSceneRequest({ type: 'createPrefab', from: '513' }, new AbortController().signal)
    expect(made).toEqual({ entity: '513', prefab: 'p-zombie', folder: 'custom/zombie', name: 'Zombie', reused: true })
    expect(createPrefabFrom).not.toHaveBeenCalled()
    // an instance placed into the game still moves to "When spawned"
    expect(uiSetSpawnedOnly).toHaveBeenLastCalledWith('513', true)
    delete state.snapshot['513']
  })
})
