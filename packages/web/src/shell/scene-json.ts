// Reading and merge-writing a project's scene.json and main.composite. These
// mirror desktop's scene-settings.ts, scene-meta.ts and composite-entities.ts:
// that package reads through node:fs and is not a dependency of this one.
import type { SceneSettings, SpawnPointSetting } from '@dcl-editor/contract'
import type { AssistantSceneSettings } from '@ui/ai/scene'

export const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

type Axis = number | number[]
interface RawSpawnPoint {
  name?: string
  default?: boolean
  position?: { x?: Axis; y?: Axis; z?: Axis }
  cameraTarget?: { x?: Axis; y?: Axis; z?: Axis }
}

// scene.json as parsed: everything optional, everything else preserved
export interface RawSceneJson {
  display?: { title?: string; description?: string; navmapThumbnail?: string; [k: string]: unknown }
  contact?: { name?: string; email?: string; [k: string]: unknown }
  scene?: { parcels?: string[]; base?: string; [k: string]: unknown }
  spawnPoints?: RawSpawnPoint[]
  worldConfiguration?: { name?: string; [k: string]: unknown }
  [k: string]: unknown
}

// Any JSON object file of a project; null when missing or not an object.
export function parseSceneJson(bytes: Uint8Array | undefined): RawSceneJson | null {
  if (bytes === undefined) return null
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as RawSceneJson) : null
  } catch {
    return null
  }
}

export const sceneJsonBytes = (raw: RawSceneJson): Uint8Array => new TextEncoder().encode(JSON.stringify(raw, null, 2) + '\n')

export function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot).toLowerCase()
}

export function imageDataUrl(path: string, bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${IMG_MIME[extensionOf(path)] ?? 'image/png'};base64,${btoa(binary)}`
}

// an axis range [min,max] becomes its midpoint: the editor edits one spot
function axis(v: Axis | undefined): number {
  if (Array.isArray(v)) return v.length === 0 ? 0 : (Math.min(...v) + Math.max(...v)) / 2
  return typeof v === 'number' ? v : 0
}

export function extractSettings(raw: RawSceneJson): Omit<SceneSettings, 'thumbnail'> {
  return {
    title: raw.display?.title ?? '',
    description: raw.display?.description ?? '',
    thumbnailPath: raw.display?.navmapThumbnail ?? null,
    contactName: raw.contact?.name ?? '',
    contactEmail: raw.contact?.email ?? '',
    parcels: Array.isArray(raw.scene?.parcels) ? [...raw.scene.parcels] : [],
    base: raw.scene?.base ?? '',
    spawnPoints: (raw.spawnPoints ?? []).map((p, i) => ({
      name: p.name ?? `Spawn Point ${i + 1}`,
      default: p.default === true,
      position: { x: axis(p.position?.x), y: axis(p.position?.y), z: axis(p.position?.z) },
      ...(p.cameraTarget !== undefined
        ? { cameraTarget: { x: axis(p.cameraTarget.x), y: axis(p.cameraTarget.y), z: axis(p.cameraTarget.z) } }
        : {})
    }))
  }
}

const PARCEL_RE = /^-?\d+,-?\d+$/

export function validateSettings(s: SceneSettings): string | null {
  if (s.title.trim() === '') return 'The scene needs a name'
  if (s.parcels.length === 0) return 'The scene needs at least one parcel'
  const bad = s.parcels.find((p) => !PARCEL_RE.test(p))
  if (bad !== undefined) return `"${bad}" is not a valid parcel — use "x,y"`
  if (new Set(s.parcels).size !== s.parcels.length) return 'Duplicate parcels'
  if (!s.parcels.includes(s.base)) return 'The base parcel must be one of the scene’s parcels'
  for (const sp of s.spawnPoints) {
    if (sp.name.trim() === '') return 'Every spawn point needs a name'
    for (const v of [sp.position.x, sp.position.y, sp.position.z]) {
      if (!Number.isFinite(v)) return `Spawn point "${sp.name}" has an invalid position`
    }
    if (sp.cameraTarget !== undefined) {
      for (const v of [sp.cameraTarget.x, sp.cameraTarget.y, sp.cameraTarget.z]) {
        if (!Number.isFinite(v)) return `Spawn point "${sp.name}" has an invalid camera target`
      }
    }
  }
  return null
}

// Keeps every field the editor does not model. `raw` is not mutated.
export function applySettings(raw: RawSceneJson, s: SceneSettings): RawSceneJson {
  const spawnPoints = s.spawnPoints.map((p: SpawnPointSetting) => ({
    name: p.name.trim(),
    default: p.default,
    position: { x: p.position.x, y: p.position.y, z: p.position.z },
    ...(p.cameraTarget !== undefined ? { cameraTarget: { ...p.cameraTarget } } : {})
  }))
  return {
    ...raw,
    display: {
      ...(raw.display ?? {}),
      title: s.title.trim(),
      description: s.description.trim(),
      ...(s.thumbnailPath !== null ? { navmapThumbnail: s.thumbnailPath } : {})
    },
    contact: { ...(raw.contact ?? {}), name: s.contactName.trim(), email: s.contactEmail.trim() },
    scene: { ...(raw.scene ?? {}), parcels: [...s.parcels], base: s.base },
    spawnPoints
  }
}

// Where Stop puts the player back, in world space ("x,y,z"): the authored spawn
// point, else the centre of the base parcel. Empty when there is no usable base.
export function spawnWorldPosition(raw: RawSceneJson): string {
  const [px, py] = (raw.scene?.base ?? '0,0').split(',').map((n) => parseInt(n, 10))
  if (!Number.isFinite(px) || !Number.isFinite(py)) return ''
  const point = raw.spawnPoints?.find((p) => p.default) ?? raw.spawnPoints?.[0]
  if (point?.position === undefined) return `${px * 16 + 8},0,${py * 16 + 8}`
  const { x, y, z } = point.position
  return `${px * 16 + axis(x)},${axis(y)},${py * 16 + axis(z)}`
}

export const COMPOSITE_CANDIDATES = ['assets/scene/main.composite', 'main.composite', 'assets/main.composite']

// The entities authored into a main.composite, from its text.
export function compositeEntityIds(text: string): number[] {
  let doc: { components?: Array<{ name?: string; data?: Record<string, unknown> }> }
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  const ids = new Set<number>()
  for (const c of doc.components ?? []) {
    // composite::root is the container itself, not scene content
    if (c?.name === 'composite::root') continue
    for (const key of Object.keys(c?.data ?? {})) {
      const n = Number(key)
      // entity 0 is the scene root and carries only editor metadata
      if (Number.isFinite(n) && n > 0) ids.add(n)
    }
  }
  return [...ids].sort((a, b) => a - b)
}

// what the assistant may change in scene.json: never the title or anything published as identity
export const ASSISTANT_PERMISSIONS = [
  'ALLOW_TO_MOVE_PLAYER_INSIDE_SCENE',
  'ALLOW_TO_TRIGGER_AVATAR_EMOTE',
  'OPEN_EXTERNAL_LINK',
  'USE_WEB3_API',
  'USE_FETCH',
  'USE_WEBSOCKET'
]


const MAX_ASSISTANT_PARCELS = 100

// one piece: every parcel reachable from the first through shared edges
function connected(parcels: string[]): boolean {
  const all = new Set(parcels)
  const seen = new Set([parcels[0]])
  const queue = [parcels[0]]
  while (queue.length > 0) {
    const [x, y] = queue.pop()!.split(',').map(Number)
    for (const next of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
      if (all.has(next) && !seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return seen.size === all.size
}

function point(v: unknown): { x: number; y: number; z: number } | null {
  if (typeof v !== 'object' || v === null) return null
  const { x, y, z } = v as Record<string, unknown>
  return [x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x: x as number, y: y as number, z: z as number } : null
}

// Adds permissions, replaces the spawn points, the parcels and the thumbnail; throws on anything it would not write.
export function applyAssistantSettings(raw: RawSceneJson, s: AssistantSceneSettings): RawSceneJson {
  const next: RawSceneJson = { ...raw }
  if (s.thumbnailPath !== undefined) {
    if (typeof s.thumbnailPath !== 'string' || !/^assets\/images\/[\w-]+\.(jpg|png)$/.test(s.thumbnailPath)) throw new Error('thumbnailPath must be an image under assets/images/')
    next.display = { ...(raw.display ?? {}), navmapThumbnail: s.thumbnailPath }
  }
  if (s.permissions !== undefined) {
    if (!Array.isArray(s.permissions) || s.permissions.some((p) => typeof p !== 'string' || !ASSISTANT_PERMISSIONS.includes(p))) {
      throw new Error(`permissions must be some of: ${ASSISTANT_PERMISSIONS.join(', ')}`)
    }
    const current = Array.isArray(raw.requiredPermissions) ? (raw.requiredPermissions as unknown[]).filter((p) => typeof p === 'string') : []
    next.requiredPermissions = [...new Set([...current, ...(s.permissions as string[])])]
  }
  if (s.parcels !== undefined || s.base !== undefined) {
    const current = raw.scene ?? {}
    const parcels = s.parcels ?? current.parcels
    if (!Array.isArray(parcels) || parcels.length === 0 || parcels.length > MAX_ASSISTANT_PARCELS ||
      parcels.some((p) => typeof p !== 'string' || !PARCEL_RE.test(p))) {
      throw new Error(`parcels must be a list of 1–${MAX_ASSISTANT_PARCELS} "x,y" coordinates`)
    }
    const list = (parcels as string[]).map((p) => p.split(',').map(Number).join(','))
    if (new Set(list).size !== list.length) throw new Error('parcels has duplicates')
    if (!connected(list)) throw new Error('parcels must form one connected area: each one shares an edge with another')
    const base = s.base ?? (typeof current.base === 'string' && list.includes(current.base) ? current.base : list[0])
    if (typeof base !== 'string' || !list.includes(base)) throw new Error('base must be one of the parcels')
    next.scene = { ...current, parcels: list, base }
  }
  if (s.spawnPoints !== undefined) {
    if (!Array.isArray(s.spawnPoints) || s.spawnPoints.length > 16) throw new Error('spawnPoints must be a list of up to 16 points')
    next.spawnPoints = s.spawnPoints.map((p: unknown, i) => {
      const o = typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {}
      const position = point(o.position)
      if (position === null) throw new Error(`spawn point ${i + 1} needs a position {x,y,z} in scene metres`)
      const cameraTarget = o.cameraTarget === undefined ? undefined : point(o.cameraTarget)
      if (cameraTarget === null) throw new Error(`spawn point ${i + 1} has an invalid cameraTarget`)
      return {
        name: typeof o.name === 'string' && o.name.trim() !== '' ? o.name.trim().slice(0, 100) : `Spawn Point ${i + 1}`,
        default: o.default === true || (i === 0 && !(s.spawnPoints as unknown[]).some((q) => (q as Record<string, unknown> | null)?.default === true)),
        position,
        ...(cameraTarget !== undefined ? { cameraTarget } : {})
      }
    })
  }
  return next
}
