import { isReservedEntity, object } from '@dcl-editor/contract'
import { state, componentKey, isUiEntity, isRuntimeEntity, provenanceBaseline } from '@scene/state'
import { buildFromSchema, getSchema, type ComponentSchema } from '@scene/schema'
import { cmd } from '../engine/cmd'
import { entityName, NAME_COMPONENT } from '@scene/custom-components'
import { isAllowedComponent } from '@scene/allowed-components'
import { uiAddEntity } from '../actions/entities'
import { uiDeleteComponent, uiSetComponentValue } from '../actions/components'
import { createPrefabFrom } from '../actions/prefabs'
import { uiSetSpawnedOnly } from '../actions/spawned-only'
import { flushPendingSave } from '../core/autosave'
import { prefabStore, refreshPrefabs } from '../panels/prefab-store'
import { prefabAssetId } from '../prefabs/provenance'
import { ensureContentMapped, importCatalogFile, loadModelCatalog, modelById, type ModelAsset } from '../assets'
import { dataLayerListFiles, dataLayerReadFile, dataLayerReadFileBytes, dataLayerSaveFile, dataLayerSaveFileBytes } from '../engine/datalayer'
import { inspectModel } from '../model-info'
import { announceBuiltModel } from '../features/ai/built-models'
import { announceThumbnail, announceThumbnailUsed } from '../features/ai/built-thumbnails'
import { buildCodeModel, overBudget, MODEL_BUDGET } from './code-model'
import { MATERIAL_MAPS, materialFile } from '../three/materials'
import { materialBytes, soundBytes } from './library-bytes'
import { SOUNDS, isSoundName, soundInfo, soundProjectPath } from '../sounds'
import { modelImagePath, sceneBudget, sceneTextures } from '../scene-budget'
import { isFlatModel, searchModels } from './model-search'
import { uiResyncScene } from '../actions/assets'
import { runRequestText } from './requests'
import { resolveEntityRef } from './request-format'
import { sceneOutline } from './roster'
import { invalidateSceneCheckCache, refreshSceneChecks } from '../features/editor/scene-check-context'
import { readThumbnail, saveThumbnail, THUMBNAIL_VERSION, thumbnailPath } from './thumbnail'

function entity(ref: unknown): string {
  if (typeof ref !== 'string') throw new Error('An entity id or unique name is required.')
  const id = resolveEntityRef(state.snapshot, ref)
  if (id === null || isReservedEntity(id) || isUiEntity(state.snapshot, id)) throw new Error('No editable entity matches that reference.')
  return id
}

// The engine reads a protobuf oneof as `{ pbr: {...} }`; models often write the SDK's `{ $case: 'pbr', pbr: {...} }`
function toEngineValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toEngineValue)
  if (!object(value)) return value
  if (typeof value.$case === 'string') return { [value.$case]: toEngineValue(value[value.$case]) }
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, toEngineValue(field)]))
}

const schemas = new Map<string, Promise<ComponentSchema | null>>()

function schemaOf(name: string): Promise<ComponentSchema | null> {
  const cached = getSchema(name)
  if (cached !== undefined) return Promise.resolve(cached)
  let pending = schemas.get(name)
  if (pending === undefined) {
    pending = cmd.componentSchema(name).then((reply) => JSON.parse(reply) as ComponentSchema, () => null)
    schemas.set(name, pending)
  }
  return pending
}

// a patch lays its fields over the current value, object by object: {position:{y:3}} moves one axis
function merged(current: unknown, patch: unknown): unknown {
  if (!object(current) || !object(patch)) return patch
  const out: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) out[key] = merged(current[key], value)
  return out
}

async function setComponent(id: string, name: unknown, value: unknown, expected: unknown, patch = false): Promise<void> {
  if (typeof name !== 'string' || !isAllowedComponent(name) || !object(value)) throw new Error('Invalid component update.')
  const previous = state.snapshot[id]?.[name] ?? null
  // a patch needs no inspect first: it is applied to whatever the component holds now
  if (!patch && JSON.stringify(previous) !== JSON.stringify(expected)) throw new Error('This component changed. Inspect the scene and retry.')
  const key = componentKey(id, name)
  let engineValue = toEngineValue(patch ? merged(previous, value) : value)
  // Transform has no engine schema to fill from; every entity already has a whole one
  if (name === 'Transform' && object(engineValue) && object(previous)) engineValue = { ...previous, ...engineValue }
  // the engine refuses a value missing any field, as the inspector's own writes never are
  const schema = await schemaOf(name)
  const built = schema === null ? null : buildFromSchema(key, schema, engineValue)
  await uiSetComponentValue(key, id, name, built?.ok === true ? built.json : JSON.stringify(engineValue))
  if (state.editStatus.get(key) !== '✓ set') throw new Error('The editor could not apply that component.')
}

const MAX_MODEL_MATCHES = 20
const metre = (n: number | undefined) => Math.round((n ?? 0) * 10) / 10
const sizeOf = (a: ModelAsset) => ({ x: metre(a.width), y: metre(a.height), z: metre(a.depth) })
const describe = (a: ModelAsset) => ({
  id: a.id, name: a.name, category: a.subcategory === undefined ? a.category : `${a.category}/${a.subcategory}`, size: sizeOf(a),
  triangles: a.triangles ?? null, kb: Math.round((a.fileSize ?? 0) / 1024), tags: a.tags.slice(0, 6),
  ...((a.animations?.length ?? 0) > 0 ? { animations: a.animations } : {}),
  ...(isFlatModel(a) ? { flat: true } : {})
})

// what the assistant may change in scene.json; the host that owns scene.json validates and applies it
export interface AssistantSceneSettings {
  permissions?: unknown
  spawnPoints?: unknown
  parcels?: unknown
  base?: unknown
  thumbnailPath?: unknown
}

export type SceneSettingsEditor = (settings: AssistantSceneSettings) => Promise<unknown>

const MAX_BATCH = 200

// A batch answers what the request did, not the components it just wrote: echoing them back
// filled the conversation with the assistant's own input. inspect reads them when needed.
function brief(result: unknown): unknown {
  if (!object(result)) return result
  const { components: _components, value: _value, ...rest } = result
  return rest
}

export async function browserSceneRequest(request: unknown, signal: AbortSignal, settings?: SceneSettingsEditor): Promise<unknown> {
  signal.throwIfAborted()
  if (!object(request)) throw new Error('Invalid scene request.')
  if (request.type === 'batch') {
    if (!Array.isArray(request.requests) || request.requests.length === 0 || request.requests.length > MAX_BATCH) {
      throw new Error(`A batch needs 1–${MAX_BATCH} requests.`)
    }
    // one failure doesn't stop the rest: each later request may not depend on it
    const results: unknown[] = []
    for (const item of request.requests) {
      if (object(item) && item.type === 'batch') throw new Error('Batches do not nest.')
      try {
        results.push({ ok: true, result: brief(await browserSceneRequest(item, signal, settings)) })
      } catch (e) {
        signal.throwIfAborted()
        results.push({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return { results }
  }
  if (request.type === 'sceneSettings') {
    if (settings === undefined) throw new Error('Scene settings cannot be changed here.')
    return settings({ permissions: request.permissions, spawnPoints: request.spawnPoints, parcels: request.parcels, base: request.base })
  }
  if (request.type === 'saveThumbnail') {
    if (settings === undefined) throw new Error('The thumbnail cannot be saved here.')
    const saved = await saveThumbnail(request, {
      files: () => dataLayerListFiles(),
      save: dataLayerSaveFileBytes,
      setThumbnail: (path) => settings({ thumbnailPath: path })
    }, signal)
    invalidateSceneCheckCache()
    announceThumbnail({ path: saved.path, version: saved.version })
    return saved
  }
  if (request.type === 'readThumbnail') return readThumbnail(await dataLayerReadFile('scene.json'), dataLayerReadFileBytes)
  if (request.type === 'useThumbnail') {
    if (settings === undefined) throw new Error('The thumbnail cannot be changed here.')
    if (typeof request.version !== 'number' || !Number.isInteger(request.version)) throw new Error('useThumbnail needs the version number.')
    const path = thumbnailPath(request.version)
    if (!THUMBNAIL_VERSION.test(path) || !(await dataLayerReadFileBytes(path).then(() => true, () => false))) {
      throw new Error(`There is no thumbnail version ${request.version}.`)
    }
    await settings({ thumbnailPath: path })
    invalidateSceneCheckCache()
    announceThumbnailUsed(path)
    return { path, version: request.version }
  }
  if (request.type === 'outline') {
    return sceneOutline(state.snapshot, {
      match: typeof request.match === 'string' ? request.match : undefined,
      offset: typeof request.offset === 'number' ? request.offset : undefined
    })
  }
  if (request.type === 'check') {
    // the editor's own scene checks, as the Scene checks card shows them
    const findings = await refreshSceneChecks()
    const baseline = provenanceBaseline()
    const authored = Object.entries(state.snapshot).filter(([id]) => !isReservedEntity(id) && !isRuntimeEntity(id, baseline))
    const models = authored.filter(([, c]) => object(c.GltfContainer) && typeof c.GltfContainer.src === 'string')
    return {
      visuals: {
        modelEntities: models.length,
        modelPaths: [...new Set(models.map(([, c]) => (c.GltfContainer as { src: string }).src))],
        primitiveEntities: authored.filter(([, c]) => c.MeshRenderer !== undefined).length
      },
      liveParcels: state.scene?.parcels ?? [],
      budget: await sceneBudget(),
      findings: findings.map((f) => ({
        level: f.level, title: f.title, detail: f.detail,
        ...(f.entityId === undefined ? {} : { entity: entityName(state.snapshot, f.entityId) ?? f.entityId })
      }))
    }
  }
  if (request.type === 'inspect') {
    // a big scene doesn't fit one answer: match narrows by name, offset pages through the rest
    const match = typeof request.match === 'string' ? request.match.toLowerCase() : ''
    const offset = typeof request.offset === 'number' && request.offset > 0 ? Math.floor(request.offset) : 0
    const entries = Object.entries(state.snapshot).filter(([id]) =>
      !isReservedEntity(id) && !isUiEntity(state.snapshot, id) && (entityName(state.snapshot, id) ?? '').toLowerCase().includes(match))
    return {
      selected: [...state.selected], editMode: state.frozen, total: entries.length, offset,
      entities: entries.slice(offset, offset + 150).map(([id, components]) => ({
        id, name: entityName(state.snapshot, id),
        components: Object.fromEntries(Object.entries(components).filter(([name]) => isAllowedComponent(name)))
      }))
    }
  }
  if (request.type === 'findModels') {
    if (typeof request.query !== 'string') throw new Error('findModels needs query: a few words.')
    const limit = Math.min(MAX_MODEL_MATCHES, Math.max(1, Number(request.limit ?? 8) || 8))
    const assets = await loadModelCatalog()
    return { models: searchModels(assets, request.query, limit).map(describe), total: assets.length }
  }
  if (!state.frozen) throw new Error('Stop Play before changing the scene.')
  if (request.type === 'addSound') {
    if (!isSoundName(request.name)) throw new Error(`addSound needs name, one of: ${SOUNDS.join(', ')}.`)
    const path = soundProjectPath(request.name)
    if (!(await dataLayerListFiles()).includes(path)) await dataLayerSaveFileBytes(path, await soundBytes(request.name))
    await ensureContentMapped(path)
    const { durationSeconds, loop } = soundInfo(request.name)
    return { path, durationSeconds, loop }
  }
  if (request.type === 'placeModel') {
    if (typeof request.id !== 'string') throw new Error('placeModel needs the id of a findModels result.')
    await loadModelCatalog()
    const asset = modelById(request.id)
    if (asset === undefined) throw new Error('No catalog model has that id. Use findModels.')
    const rel = await importCatalogFile(asset)
    const cost = await catalogTextureCost(rel)
    const placed = await placeGltf(request, rel, asset.name, signal, settings)
    return { ...placed, size: sizeOf(asset), ...cost }
  }
  if (request.type === 'buildModel') {
    // building into a stand-in may leave out the name: the stand-in's own name is the model's
    const name = typeof request.name === 'string' && request.name.trim() !== '' ? request.name
      : request.into === undefined ? '' : entityName(state.snapshot, entity(request.into)) ?? String(request.into)
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (slug === '' || slug.length > 60) throw new Error('buildModel needs name (or into): 1–60 letters or digits.')
    if (typeof request.code !== 'string' || request.code.length > 60_000) throw new Error('buildModel needs code: the model script, under 60,000 characters.')
    const { bytes, clips, library, warnings } = await buildCodeModel(request.code, name, signal)
    // counted from the exported file: the script ran in the worker, so nothing it reports is trusted
    const info = inspectModel(bytes)
    // the only files a built model may point at are the shared materials written beside it
    const allowed = new Map(library.flatMap((name) => MATERIAL_MAPS.map((map) => [materialFile(name, map), { name, map }] as const)))
    const outside = info.sharedImages.filter((uri) => !allowed.has(uri))
    if (info.externalResources.some((uri) => !info.sharedImages.includes(uri)) || outside.length > 0) throw new Error('The model refers to files outside the shared materials.')
    const stats = { triangles: info.triangles, materials: info.materials.length, textures: info.textures - info.sharedImages.length, largestTexture: info.largestImage }
    const over = overBudget(stats, info.textureProblems)
    if (over.length > 0) throw new Error(`The model is over budget (${over.join(', ')}); simplify it and build again.`)
    // shared materials cost the scene's texture limit, once each however many models use them
    const textures = await sceneTextures()
    const adds = stats.textures + info.sharedImages.filter((uri) => !textures.shared.has(`models/${uri}`)).length
    if (textures.used + adds > textures.limit) {
      throw new Error(`The scene has ${Math.max(0, textures.limit - textures.used)} of its ${textures.limit} textures left and this model would add ${adds}. ` +
        'Reuse materials the scene already has, give parts seen from afar relief:false, use fewer materials, or grow the parcels.')
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    // a rebuild gets a new path, so the engine loads it instead of a cached copy
    const rel = `models/${slug}-${[...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}.glb`
    await ignoreModelScripts()
    await dataLayerSaveFileBytes(`models/src/${slug}.js`, new TextEncoder().encode(request.code))
    // the shared material files first, so the model never loads without them
    for (const uri of info.sharedImages) {
      const { name, map } = allowed.get(uri)!
      const file = `models/${uri}`
      if (!(await dataLayerReadFileBytes(file).then(() => true, () => false))) await dataLayerSaveFileBytes(file, await materialBytes(name, map))
      await ensureContentMapped(file)
    }
    await dataLayerSaveFileBytes(rel, bytes)
    await ensureContentMapped(rel)
    // the old build stays: undo can still point the entity back at it, and Assets can delete it
    const placed = await placeGltf({ ...request, name: request.into === undefined ? name : undefined }, rel, name, signal, settings)
    announceBuiltModel({ name, path: rel, triangles: stats.triangles })
    return { ...placed, script: `models/src/${slug}.js`, stats, clips, materials: library, ...(warnings.length > 0 ? { warnings } : {}), budget: MODEL_BUDGET, kb: Math.round(bytes.length / 1024), scene: await sceneBudget() }
  }
  if (request.type === 'createEntity') {
    if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 100) throw new Error('Choose an entity name of 1–100 characters.')
    const parent = request.parent === undefined || request.parent === '0' ? 0 : Number(entity(request.parent))
    const before = new Set(Object.keys(state.snapshot))
    if (request.components !== undefined && !object(request.components)) throw new Error('components must map component names to values.')
    await uiAddEntity(request.name, parent)
    const id = state.activeEntity
    if (id === null || before.has(id)) throw new Error('The entity could not be created.')
    const failed: string[] = []
    for (const [name, value] of Object.entries(request.components ?? {})) {
      try {
        await setComponent(id, name, value, state.snapshot[id]?.[name] ?? null)
      } catch (e) {
        failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { id, components: state.snapshot[id], ...(failed.length > 0 ? { failed } : {}) }
  }
  if (request.type === 'move') {
    // a relative move needs no lookup: "raise it a metre" is one request
    const id = entity(request.to)
    const by = request.by
    if (!object(by) || !['x', 'y', 'z'].some((k) => typeof by[k] === 'number')) throw new Error('move needs by: {x, y, z} in metres.')
    const current = state.snapshot[id]?.Transform
    const position = object(current) && object(current.position) ? current.position : { x: 0, y: 0, z: 0 }
    const next = Object.fromEntries((['x', 'y', 'z'] as const).map((k) => [k, Number(position[k] ?? 0) + (typeof by[k] === 'number' ? by[k] : 0)]))
    await setComponent(id, 'Transform', { position: next }, null, true)
    return { id, position: next }
  }
  if (request.type === 'setComponent') {
    const id = entity(request.to)
    if ('patch' in request) await setComponent(id, request.component, request.patch, null, true)
    else {
      if (!('expected' in request)) throw new Error('Invalid component update.')
      await setComponent(id, request.component, request.value, request.expected)
    }
    return { id, component: request.component, value: state.snapshot[id]?.[String(request.component)] }
  }
  if (request.type === 'removeComponent') {
    const id = entity(request.to)
    const name = request.component
    // isAllowedComponent admits Transform and the name, which every entity must keep
    if (typeof name !== 'string' || !isAllowedComponent(name) || name === 'Transform' || name === NAME_COMPONENT) throw new Error('That component cannot be removed.')
    if (state.snapshot[id]?.[name] === undefined) return { id, component: name, removed: false }
    uiDeleteComponent(id, name)
    return { id, component: name, components: state.snapshot[id] }
  }
  if (request.type === 'createPrefab') {
    const id = entity(request.from)
    const spawnedOnly = request.spawnedOnly !== false
    const assetId = prefabAssetId(state.snapshot[id])
    const items = assetId === null ? [] : await refreshPrefabs()
    // a refresh that bailed answers [] or stale items; a second prefab would orphan the first
    const existing = [...items, ...prefabStore.items].find((item) => item.data.id === assetId)
    const name = typeof request.name === 'string' && request.name.trim() ? request.name.trim() : entityName(state.snapshot, id) ?? 'Prefab'
    if (name.length > 100) throw new Error('Choose a prefab name of 1–100 characters.')
    // the assistant's prefabs serve this scene; the creator's library is theirs to fill
    const made = existing !== undefined
      ? { id: existing.data.id, folder: existing.folder, name: existing.data.name, warnings: [] }
      : await createPrefabFrom([id], name, { spawnedOnly, library: false })
    // also walks a folder's members, and undoes an earlier mark when asked to stay in the game
    await uiSetSpawnedOnly(id, spawnedOnly)
    // the spawn registry is regenerated on save; a build later this turn must see it
    const saved = await flushPendingSave()
    const warnings = saved.ok ? made.warnings : [...made.warnings, 'The scene could not be saved, so a build may not see this prefab yet; retry before building.']
    return { entity: id, prefab: made.id, folder: made.folder, name: made.name, ...(existing !== undefined ? { reused: true } : {}), ...(warnings.length > 0 ? { warnings } : {}) }
  }
  if (!['attachScript', 'setParams', 'placePrefab'].includes(String(request.type))) throw new Error('Unsupported scene request.')
  if (request.type !== 'placePrefab') entity(request.to)
  return runRequestText(JSON.stringify({ version: 1, requests: [request] }), state.activeEntity)
}

// A catalog model is placed whatever its textures cost: the answer says what it spends of the scene's limit.
async function catalogTextureCost(rel: string): Promise<Record<string, unknown>> {
  let info: ReturnType<typeof inspectModel>
  try {
    info = inspectModel(await dataLayerReadFileBytes(rel))
  } catch {
    return { warning: 'Its textures could not be counted; run check to see the scene budget.' }
  }
  const scene = await sceneTextures()
  const placedAlready = Object.values(state.snapshot).some((c) => object(c.GltfContainer) && c.GltfContainer.src === rel)
  const adds = placedAlready ? 0 : info.textures - info.sharedImages.length + info.sharedImages.filter((uri) => !scene.shared.has(modelImagePath(rel, uri))).length
  const left = scene.limit - scene.used - adds
  return {
    textures: info.textures, materials: info.materials.length, sceneTexturesLeft: left,
    ...(left < 0 ? { warning: `The scene now uses ${scene.used + adds} of its ${scene.limit} textures; explorers warn above that. Swap it for a model with fewer textures, or grow the parcels.` } : {})
  }
}

// Puts a model file on a new entity, or turns the `into` stand-in into it in place.
async function placeGltf(request: Record<string, unknown>, rel: string, fallbackName: string, signal: AbortSignal, settings?: SceneSettingsEditor): Promise<Record<string, unknown>> {
  // the model's own meshes collide
  const gltf = { src: rel, visibleMeshesCollisionMask: 3 }
  const pose = Object.fromEntries((['position', 'rotation', 'scale'] as const).filter((k) => object(request[k])).map((k) => [k, request[k]]))
  try {
    if (request.into !== undefined) {
      const id = entity(request.into)
      await setComponent(id, 'GltfContainer', gltf, null, true)
      for (const name of ['MeshRenderer', 'Material', 'MeshCollider']) if (state.snapshot[id]?.[name] !== undefined) uiDeleteComponent(id, name)
      // a stand-in's scale was its size; the model has its own
      await setComponent(id, 'Transform', { scale: { x: 1, y: 1, z: 1 }, ...pose }, null, true)
      return { id, model: rel, components: state.snapshot[id] }
    }
    const created = await browserSceneRequest({
      type: 'createEntity', name: request.name ?? fallbackName, parent: request.parent,
      components: { Transform: { position: { x: 8, y: 0, z: 8 }, ...pose }, GltfContainer: gltf }
    }, signal, settings)
    return { ...(object(created) ? created : {}), model: rel }
  } finally {
    // new content can re-instance the scene, which drops the editor's pick colliders
    void uiResyncScene()
  }
}

const MODEL_SCRIPTS = 'models/src/'

// model scripts are for editing, not for players: keep them out of the published scene
async function ignoreModelScripts(): Promise<void> {
  // only a missing file counts as empty: any other read error must not overwrite the creator's list
  const current = await dataLayerReadFile('.dclignore').catch(async (error: unknown) => {
    if ((await dataLayerListFiles()).includes('.dclignore')) throw error
    return ''
  })
  if (current.split('\n').some((line) => line.trim() === MODEL_SCRIPTS)) return
  await dataLayerSaveFile('.dclignore', `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${MODEL_SCRIPTS}\n`)
}
