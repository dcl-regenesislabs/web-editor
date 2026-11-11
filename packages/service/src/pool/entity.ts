// What the pool checks before it signs an entity id: the signature authorizes whatever the
// entity file says, so the file itself is read, never the caller's description of it.
import { contentCid } from '../../../contract/src/cid.ts'

export const MAX_ENTITY_BYTES = 1_000_000
// the Worlds server takes a deployment up to five minutes old
const MAX_CLOCK_SKEW_MS = 5 * 60_000
const PARCEL = /^-?\d{1,3},-?\d{1,3}$/

export interface CheckedEntity {
  entityId: string
  parcels: string[]
  base: string
  title: string
}

/** Key order and spacing don't matter, values do. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export async function checkEntity(
  bytes: Uint8Array,
  expected: { world: string; worldConfiguration: Record<string, unknown> },
  now: number
): Promise<CheckedEntity | { error: string }> {
  if (bytes.length === 0 || bytes.length > MAX_ENTITY_BYTES) return { error: 'entity-size' }
  let entity: { version?: unknown; type?: unknown; pointers?: unknown; timestamp?: unknown; content?: unknown; metadata?: Record<string, unknown> }
  try {
    entity = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as typeof entity
  } catch {
    return { error: 'entity-not-json' }
  }
  if (entity === null || typeof entity !== 'object' || entity.version !== 'v3' || entity.type !== 'scene') return { error: 'not-a-scene' }
  if (typeof entity.timestamp !== 'number' || Math.abs(now - entity.timestamp) > MAX_CLOCK_SKEW_MS) return { error: 'entity-timestamp' }
  if (!Array.isArray(entity.content)) return { error: 'no-content' }
  const metadata = entity.metadata
  if (metadata === null || typeof metadata !== 'object') return { error: 'no-metadata' }
  // world settings (skybox, access, spawn, comms) are shared by every scene in the world: the pool sets them
  const config = metadata.worldConfiguration as Record<string, unknown> | undefined
  if (typeof config?.name !== 'string' || config.name.toLowerCase() !== expected.world) return { error: 'wrong-world' }
  if (canonical(config) !== canonical(expected.worldConfiguration)) return { error: 'world-configuration' }
  const scene = metadata.scene as { parcels?: unknown; base?: unknown } | undefined
  const parcels = scene?.parcels
  const pointers = entity.pointers
  if (!Array.isArray(parcels) || !Array.isArray(pointers) || parcels.length === 0) return { error: 'no-parcels' }
  if (!parcels.every((p) => typeof p === 'string' && PARCEL.test(p)) || new Set(parcels).size !== parcels.length) return { error: 'bad-parcel' }
  if (typeof scene?.base !== 'string' || !parcels.includes(scene.base)) return { error: 'bad-parcel' }
  // the server keys the deployment on pointers; they must be the parcels the scene claims
  if ([...pointers].sort().join(';') !== [...parcels].sort().join(';')) return { error: 'pointers-mismatch' }
  const display = metadata.display as { title?: unknown } | undefined
  return {
    entityId: await contentCid(bytes),
    parcels: parcels as string[],
    base: scene.base,
    title: typeof display?.title === 'string' ? display.title.slice(0, 100) : ''
  }
}
