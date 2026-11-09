// scene.json is where a scene's title, parcels and spawn points live. main.composite carries a copy
// (inspector::SceneMetadata on the root entity) that the inspector's data layer writes back over
// scene.json whenever that copy changes in its engine — and the copy it makes when a scene has none
// is a one-parcel "Test Scene". These keep the copy in line with scene.json, never the other way
// round, and recognise a scene.json write that carries that default.

export const INSPECTOR_DEFAULT_TITLE = 'Test Scene'
const INSPECTOR_DEFAULT_BASE = '0,0'

type Axis = number | number[]

export interface SceneJsonMetadata {
  display?: { title?: string; description?: string; navmapThumbnail?: string; [k: string]: unknown }
  contact?: { name?: string; email?: string; [k: string]: unknown }
  scene?: { parcels?: string[]; base?: string; [k: string]: unknown }
  spawnPoints?: Array<{ name?: string; default?: boolean; position?: { x?: Axis; y?: Axis; z?: Axis }; cameraTarget?: unknown }>
  [k: string]: unknown
}

interface CompositeDoc {
  components?: Array<{ name?: string; data?: Record<string, { json?: unknown }> }>
}

const PARCEL_RE = /^-?\d+,-?\d+$/

function coords(parcel: string): { x: number; y: number } {
  const [x, y] = parcel.split(',').map((n) => parseInt(n, 10))
  return { x, y }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const axis = (v: Axis | undefined): { $case: 'range' | 'single'; value: Axis } =>
  Array.isArray(v) ? { $case: 'range', value: v } : { $case: 'single', value: v ?? 0 }

// What the inspector itself puts in the copy when it reads scene.json (its sceneJson → metadata
// conversion), for the fields its write-back carries to scene.json.
function metadataFrom(scene: SceneJsonMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: scene.display?.title ?? '',
    description: scene.display?.description ?? '',
    thumbnail: scene.display?.navmapThumbnail ?? '',
    author: scene.contact?.name ?? '',
    email: scene.contact?.email ?? '',
    spawnPoints: (scene.spawnPoints ?? []).map((p, i) => ({
      name: p.name ?? `Spawn Point ${i + 1}`,
      default: p.default,
      position: { x: axis(p.position?.x), y: axis(p.position?.y), z: axis(p.position?.z) },
      cameraTarget: p.cameraTarget
    }))
  }
  const parcels = scene.scene?.parcels
  const base = scene.scene?.base
  if (Array.isArray(parcels) && parcels.length > 0 && parcels.every((p) => typeof p === 'string' && PARCEL_RE.test(p))) {
    out.layout = {
      base: coords(typeof base === 'string' && PARCEL_RE.test(base) ? base : parcels[0]),
      parcels: parcels.map(coords)
    }
  }
  return out
}

// the copy's write-back turns a missing field into '' or [], so those compare equal
const comparable = (v: unknown): string => JSON.stringify(v ?? '') ?? ''
function same(key: string, a: unknown, b: unknown): boolean {
  if (key === 'spawnPoints') return comparable(a ?? []) === comparable(b ?? [])
  return comparable(a) === comparable(b)
}

// main.composite's text with its scene metadata matching scene.json, or null when it already does,
// has no metadata to fix, or cannot be read.
export function alignCompositeMetadata(compositeText: string, scene: SceneJsonMetadata): string | null {
  let doc: CompositeDoc
  try {
    doc = JSON.parse(compositeText) as CompositeDoc
  } catch {
    return null
  }
  if (!isRecord(doc) || !Array.isArray(doc.components)) return null
  const target = metadataFrom(scene)
  let changed = false
  for (const component of doc.components) {
    if (component?.name?.startsWith('inspector::SceneMetadata') !== true) continue
    const root = component.data?.['0']?.json
    if (!isRecord(root)) continue
    for (const [key, value] of Object.entries(target)) {
      if (same(key, root[key], value)) continue
      root[key] = value
      changed = true
    }
  }
  return changed ? JSON.stringify(doc, null, 2) : null
}

function parcelsOf(scene: SceneJsonMetadata): string[] {
  return Array.isArray(scene.scene?.parcels) ? scene.scene.parcels.filter((p): p is string => typeof p === 'string') : []
}

function isDefaultLayout(scene: SceneJsonMetadata): boolean {
  const parcels = parcelsOf(scene)
  return parcels.length === 1 && parcels[0] === INSPECTOR_DEFAULT_BASE && (scene.scene?.base ?? INSPECTOR_DEFAULT_BASE) === INSPECTOR_DEFAULT_BASE
}

// For a scene.json write the editor did not make itself (the creator's own edits go through Scene
// settings and Rename, which skip this): the scene.json to put back, or null to keep the write.
// A write that replaces the title with the inspector's default, or shrinks the parcels down to its
// one default parcel, came from a default copy in main.composite. When it carries both, everything
// else it wrote came from that copy too (its spawn points, thumbnail, contact), so the whole
// previous scene.json goes back.
export function guardSceneJsonWrite<T extends SceneJsonMetadata>(previous: T, next: T): T | null {
  const title = previous.display?.title
  const tookTitle = next.display?.title === INSPECTOR_DEFAULT_TITLE && title !== INSPECTOR_DEFAULT_TITLE
  const before = parcelsOf(previous)
  const after = new Set(parcelsOf(next))
  const tookParcels = isDefaultLayout(next) && before.some((p) => !after.has(p))
  if (!tookTitle && !tookParcels) return null
  const whole = next.display?.title === INSPECTOR_DEFAULT_TITLE && isDefaultLayout(next)
  if (whole) return previous
  let repaired: T = next
  if (tookTitle) repaired = { ...repaired, display: { ...(repaired.display ?? {}), title } }
  if (tookParcels) repaired = { ...repaired, scene: { ...(repaired.scene ?? {}), parcels: [...before], base: previous.scene?.base } }
  return repaired
}
