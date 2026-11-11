// OpenDCL model catalog (https://models.dclregenesislabs.xyz) — 5.7k+ plain
// GLB models, one file per asset, no smart-item wiring. Import flow:
//   1. fetch the GLB from the catalog CDN
//   2. write it into the scene project (models/…) through the dev server's
//      data-layer (so it persists and the dev server can serve it)
//   3. /register_content tells the engine to map the new file into the live
//      scene's content map (renders without a reload)
//   4. create the entity (Transform + GltfContainer + Name) — the composite
//      auto-saves like any other edit
import { cmd } from './engine/cmd'
import { sceneRpc } from './engine/bus'
import { CONTENT_MAP_TIMEOUT_MS, CONTENT_POLL_INTERVAL_MS } from './config'
import { createEntities } from '@scene/inspector'
import { state, setSelected } from '@scene/state'
import { revealInTree } from './panels/reveal'
import { NAME_COMPONENT } from '@scene/custom-components'
import { dataLayerSaveFileBytes, dataLayerAvailable, dataLayerListFiles } from './engine/datalayer'
import { IGNORED_DIRS } from './script/project-files'
import { referencedNames } from './script/references'
import { gltfExternalUris } from './gltf-refs'
import { launchParam } from './boot/launch-params'
import { log } from './log'

const OPENDCL_ORIGIN = 'https://models.dclregenesislabs.xyz'
const CATALOG_URL = `${OPENDCL_ORIGIN}/catalog/asset-catalog.json`

// The catalog CDN lacks CORS/CORP headers, which strict crossOriginIsolated
// pages (the electron host) refuse. The host's local server proxies it at
// /opendcl/*; when that's present every catalog URL is rewritten through it,
// otherwise we fetch directly (works in lenient browsers).
let proxyBase: string | null | undefined
async function resolveProxy(): Promise<string | null> {
  if (proxyBase !== undefined) return proxyBase
  try {
    const r = await fetch('/opendcl/ping')
    // a single-page host answers every path with its index.html
    proxyBase = r.ok && (r.headers.get('content-type') ?? '').includes('application/json') ? '/opendcl' : null
  } catch {
    proxyBase = null
  }
  return proxyBase
}

// the catalog CDN, directly or through the dev proxy: the only place a preview may fetch a model from
export function catalogUrl(url: string): boolean {
  const parsed = URL.canParse(url, location.href) ? new URL(url, location.href) : null
  return parsed !== null && (parsed.origin === OPENDCL_ORIGIN || (proxyBase === '/opendcl' && parsed.origin === location.origin && parsed.pathname.startsWith('/opendcl/')))
}

export function opendclUrl(u: string | undefined): string | undefined {
  if (u === undefined) return undefined
  if (proxyBase === '/opendcl' && u.startsWith(OPENDCL_ORIGIN)) {
    return u.replace(OPENDCL_ORIGIN, proxyBase)
  }
  return u
}

export type ModelAsset = {
  id: string
  name: string
  filename: string
  url: string
  collection: string
  category: string
  tags: string[]
  subcategory?: string
  description?: string
  thumbnailUrl?: string
  width?: number
  height?: number
  depth?: number
  triangles?: number
  fileSize?: number
  animations?: string[]
}

let assets: ModelAsset[] | null = null
let dupFilenames: Set<string> = new Set()
let loadPromise: Promise<ModelAsset[]> | null = null

export async function loadModelCatalog(): Promise<ModelAsset[]> {
  if (assets !== null) return assets
  if (loadPromise === null) {
    loadPromise = (async () => {
      await resolveProxy()
      const res = await fetch(opendclUrl(CATALOG_URL) as string)
      if (!res.ok) throw new Error(`model catalog fetch failed: ${res.status}`)
      const json = (await res.json()) as { assets?: ModelAsset[] }
      const list = json.assets ?? []
      const seen = new Set<string>()
      dupFilenames = new Set()
      for (const a of list) {
        if (seen.has(a.filename)) dupFilenames.add(a.filename)
        seen.add(a.filename)
      }
      assets = list
      return list
    })().catch((e) => {
      loadPromise = null
      throw e
    })
  }
  return loadPromise
}

export function modelById(id: string): ModelAsset | undefined {
  return assets?.find((a) => a.id === id)
}

// Entity names must be unique — getEntitiesWithName / the inspector key on them.
// If `base` is taken, append " 2", " 3", … until free.
//
// A name a SCRIPT still names counts as taken even when no entity carries it. Delete
// every "Trigger Zone" and the reactions that referenced one keep the string; reusing
// the name would silently re-bind them to the next entity to get it (see
// script/references.ts).
export function uniqueEntityName(base: string): string {
  const taken = referencedNames(state.snapshot)
  for (const id of Object.keys(state.snapshot)) {
    const n = (state.snapshot[id]?.[NAME_COMPONENT] as { value?: string } | undefined)?.value
    if (typeof n === 'string') taken.add(n)
  }
  if (!taken.has(base)) return base
  for (let i = 2; i < 10000; i++) {
    const cand = `${base} ${i}`
    if (!taken.has(cand)) return cand
  }
  return `${base} ${Date.now()}`
}

// models/<filename>, disambiguated with a short content-id suffix when the
// catalog has several assets sharing a filename
export function modelRelPath(a: ModelAsset): string {
  if (!dupFilenames.has(a.filename)) return `models/${a.filename}`
  const dot = a.filename.lastIndexOf('.')
  const base = dot > 0 ? a.filename.slice(0, dot) : a.filename
  const ext = dot > 0 ? a.filename.slice(dot) : ''
  return `models/${base}-${a.id.slice(-8)}${ext}`
}

// Make a just-written file resolvable by the live scene without a reload. The
// patched engine had /register_content for this; stock main instead exposes
// /scene_content, which REFRESHES the engine's content map from the dev server
// (picking up files written outside the editor) and returns the file list. Poll
// it until our file appears: that both forces the refresh (so GltfContainer.src
// resolves) and confirms the dev server is serving it before the engine's single
// load attempt. False when the budget ran out: the running scene loads the file
// after its next reload instead.
export async function ensureContentMapped(rel: string): Promise<boolean> {
  const target = rel.toLowerCase()
  const deadline = Date.now() + CONTENT_MAP_TIMEOUT_MS
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const files = await withDeadline(cmd.sceneContent(), deadline)
      if (files.some((f) => f.toLowerCase() === target)) return true
    } catch (e) {
      lastError = e
    }
    await new Promise((r) => setTimeout(r, CONTENT_POLL_INTERVAL_MS))
  }
  log.warn(`${rel} is not in the scene's content map yet`, lastError ?? '')
  return false
}

function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('scene_content did not answer in time')), Math.max(0, deadline - Date.now()))
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

const MAX_MODEL_BYTES = 50 * 1024 * 1024

// streamed, so an oversized or lying content-length can't fill memory first
export async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(res.headers.get('content-length')) > max || res.body === null) throw new Error(`File exceeds the ${max / 1024 / 1024} MB limit.`)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) throw new Error(`File exceeds the ${max / 1024 / 1024} MB limit.`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

// Download a catalog asset into the project and register it with the live
// scene's content map — no entity is created. Returns the project-relative path.
export async function importCatalogFile(asset: ModelAsset): Promise<string> {
  if (dataLayerAvailable() !== true) {
    throw new Error('model import needs the scene server running with --data-layer')
  }
  if (new URL(asset.url).origin !== OPENDCL_ORIGIN) throw new Error('model is not on the catalog CDN')
  const rel = modelRelPath(asset)
  const res = await fetch(opendclUrl(asset.url) as string)
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`)
  const bytes = await readCapped(res, MAX_MODEL_BYTES)
  await dataLayerSaveFileBytes(rel, bytes)
  await ensureContentMapped(rel)
  return rel
}

export async function importModel(
  asset: ModelAsset,
  position: { x: number; y: number; z: number }
): Promise<void> {
  const rel = await importCatalogFile(asset)

  const ids = await createEntities([
    {
      Transform: {
        position,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        parent: 0
      },
      // visible meshes double as colliders (physics + pointer) — catalog
      // models ship without separate collider meshes
      GltfContainer: { src: rel, visibleMeshesCollisionMask: 3 },
      [NAME_COMPONENT]: { value: uniqueEntityName(asset.name) }
    }
  ])
  if (ids.length > 0) {
    const eid = String(ids[0])
    setSelected([eid])
    state.activeEntity = eid
    revealInTree(eid)
  }
}

// --- local models (project content) ---
// The scene folder's own files, read off disk through the data layer (the same
// path space saveFile/getFile use). Not the engine's content map: that is keyed
// by the scene's base parcel, so it can answer with a deployed scene's files.
const MODEL_EXT = /\.(glb|gltf)$/i
export async function projectFiles(): Promise<string[]> {
  return await dataLayerListFiles(IGNORED_DIRS)
}
export async function loadLocalModels(): Promise<string[]> {
  try {
    return (await projectFiles()).filter((p) => MODEL_EXT.test(p)).sort()
  } catch {
    return []
  }
}

export const SOUND_EXT = /\.(mp3|ogg|wav)$/i

export async function loadLocalSounds(): Promise<string[]> {
  try {
    return (await projectFiles()).filter((p) => SOUND_EXT.test(p)).sort()
  } catch {
    return []
  }
}

// imported images and videos; textures that ship with a model live under models/ and stay out
export async function loadLocalMedia(): Promise<string[]> {
  try {
    return (await projectFiles()).filter((p) => p.startsWith('assets/') && (IMAGE_EXT.test(p) || VIDEO_EXT.test(p))).sort()
  } catch {
    return []
  }
}

// Place a model that's already in the project content at `position`.
export async function placeLocalModel(
  rel: string,
  name: string,
  position: { x: number; y: number; z: number }
): Promise<void> {
  await placeLocal(name, position, { GltfContainer: { src: rel, visibleMeshesCollisionMask: 3 } })
}

// a sound in the scene is ambience, so it starts playing and loops; the inspector turns either off
export async function placeLocalSound(
  rel: string,
  name: string,
  position: { x: number; y: number; z: number }
): Promise<void> {
  await placeLocal(name, position, { AudioSource: { audioClipUrl: rel, playing: true, loop: true, volume: 1 } })
}

async function placeLocal(name: string, position: { x: number; y: number; z: number }, components: Record<string, unknown>): Promise<void> {
  const ids = await createEntities([
    {
      Transform: {
        position,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        parent: 0
      },
      ...components,
      [NAME_COMPONENT]: { value: uniqueEntityName(name) }
    }
  ])
  if (ids.length > 0) {
    const eid = String(ids[0])
    setSelected([eid])
    state.activeEntity = eid
    revealInTree(eid)
  }
}

const sanitizeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
const fileBytes = async (f: File): Promise<Uint8Array> => new Uint8Array(await f.arrayBuffer())

// Refs the project content doesn't already satisfy — an earlier upload or
// authored content covers a ref just as well as the current pick. When the
// listing is unavailable, keep the warning rather than swallow it.
async function unsatisfiedRefs(uris: Set<string>): Promise<string[]> {
  if (uris.size === 0) return []
  try {
    const content = new Set((await projectFiles()).map((p) => p.toLowerCase()))
    return [...uris].filter((uri) => !content.has(`models/${uri}`.toLowerCase())).sort()
  } catch {
    return [...uris].sort()
  }
}

// Which files the picked models reference that neither the picked set nor the
// project content satisfies. Checked BEFORE anything is written, so the UI can
// warn while the user can still cancel and re-pick with the textures included.
export async function missingModelRefs(files: File[]): Promise<string[]> {
  const picked = new Set(files.map((f) => f.name.toLowerCase()))
  const missing = new Set<string>()
  for (const f of files) {
    if (!MODEL_EXT.test(f.name)) continue
    for (const uri of gltfExternalUris(f.name, await fileBytes(f))) {
      const basename = uri.split('/').pop() ?? uri
      if (!picked.has(basename.toLowerCase())) missing.add(uri)
    }
  }
  return await unsatisfiedRefs(missing)
}

const IMAGE_EXT = /\.(png|jpe?g)$/i
const DATA_EXT = /\.(json|txt|md)$/i
const AUDIO_EXT = /\.(mp3|ogg|wav)$/i
const VIDEO_EXT = /\.mp4$/i
// a Worlds deployment refuses any single file over this
const MAX_FILE_BYTES = 50 * 1024 * 1024

export interface ImportResult {
  // the model placed in the scene, if the import had one
  placed: string | null
  // images, sounds, videos and data files added on their own, by project path
  added: string[]
  // files the models reference that are still not in the project
  missing: string[]
  // files left out, each with why
  skipped: string[]
}

// Import files from disk (HTML Files — the browser and the electron renderer alike). Models are
// saved with the files they reference at the exact relative path they use (that's how renderers
// resolve them) and the first is placed. Everything else needs no model: images, sounds, videos and
// data files land in assets/images, assets/audio, assets/video and assets/data.
export async function importFiles(
  files: File[],
  position: { x: number; y: number; z: number }
): Promise<ImportResult> {
  if (dataLayerAvailable() !== true) {
    throw new Error('import needs the scene server running with --data-layer')
  }
  const skipped: string[] = []
  const fits = files.filter((f) => {
    if (f.size <= MAX_FILE_BYTES) return true
    skipped.push(`${f.name} (over 50 MB, which Worlds refuse)`)
    return false
  })
  const models = fits.filter((f) => MODEL_EXT.test(f.name))

  // what the models reference, keyed by basename so picked files (which arrive
  // without folders) can be matched back to the referenced path
  const wantedByBasename = new Map<string, string>()
  const missing = new Set<string>()
  const loaded: Array<{ file: File; bytes: Uint8Array }> = []
  for (const model of models) {
    const bytes = await fileBytes(model)
    loaded.push({ file: model, bytes })
    for (const uri of gltfExternalUris(model.name, bytes)) {
      const basename = uri.split('/').pop()
      if (basename !== undefined) wantedByBasename.set(basename.toLowerCase(), uri)
      missing.add(uri)
    }
  }

  const taken = new Set((await projectFiles().catch(() => [])).map((p) => p.toLowerCase()))
  // a second texture.png must not replace the first
  const freePath = (dir: string, name: string): string => {
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    let path = `${dir}/${name}`
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${dir}/${stem}-${n}${ext}`
    taken.add(path.toLowerCase())
    return path
  }

  const added: string[] = []
  for (const f of fits) {
    if (MODEL_EXT.test(f.name)) continue
    const uri = wantedByBasename.get(f.name.toLowerCase())
    if (uri !== undefined) {
      // referenced files keep the model's spelling — a sanitized name would no
      // longer match the uri inside the model
      await dataLayerSaveFileBytes(`models/${uri}`, await fileBytes(f))
      missing.delete(uri)
      continue
    }
    const dir = IMAGE_EXT.test(f.name)
      ? 'assets/images'
      : DATA_EXT.test(f.name)
        ? 'assets/data'
        : AUDIO_EXT.test(f.name)
          ? 'assets/audio'
          : VIDEO_EXT.test(f.name)
            ? 'assets/video'
            : null
    if (dir === null) {
      skipped.push(`${f.name} (not a model, image, sound, video or data file)`)
      continue
    }
    const rel = freePath(dir, sanitizeName(f.name))
    await dataLayerSaveFileBytes(rel, await fileBytes(f))
    added.push(rel)
  }

  for (const { file, bytes } of loaded) {
    await dataLayerSaveFileBytes(`models/${sanitizeName(file.name)}`, bytes)
  }
  if (models.length === 0) return { placed: null, added, missing: [], skipped }

  const primary = models[0]
  const placeRel = `models/${sanitizeName(primary.name)}`
  await ensureContentMapped(placeRel)
  const stillMissing = await unsatisfiedRefs(missing)
  await placeLocalModel(placeRel, primary.name.replace(MODEL_EXT, ''), position)
  return { placed: primary.name, added, missing: stillMissing, skipped }
}

// Fallback drop position: the centre of the parcel the editor was opened at
// (?position=x,y), at ground level. Used when the camera-aware drop can't be
// computed (camera/world-origin not ready, or the scene didn't answer).
export function defaultDropPosition(): { x: number; y: number; z: number } {
  const raw = launchParam('position') ?? '0,0'
  const [px, py] = raw.split(',').map((n) => parseInt(n, 10))
  return {
    x: (Number.isFinite(px) ? px : 0) * 16 + 8,
    y: 0,
    z: (Number.isFinite(py) ? py : 0) * 16 + 8
  }
}

// Where a freshly-imported model should land: in front of the editor camera on
// the ground (the scene owns the camera, so it computes the local position).
// Falls back to the parcel centre if the camera isn't ready or the rpc fails.
export async function dropPosition(): Promise<{ x: number; y: number; z: number }> {
  try {
    const p = await sceneRpc<{ x: number; y: number; z: number } | null>('cameraDrop')
    if (p !== null && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      return p
    }
  } catch {
    /* camera not ready / rpc timeout — use the parcel-centre fallback below */
  }
  return defaultDropPosition()
}
