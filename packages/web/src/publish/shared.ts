// Publishing to a shared world, for a creator without a NAME (issue #52, approach 5): the
// project service lends a zone of one of its pool NAMEs, checks the entity this page
// built and signs it with the pool wallet. The upload still goes from here to the Worlds
// server; the service never relays content.
import type { AuthChain } from '@ui/engine/hosted'
import { type RawSceneJson, parseSceneJson } from '../shell/scene-json'
import { PublishError } from './errors'

export interface SharedLease {
  world: string
  // the lowest corner of the guest's square of parcels
  zone: { x: number; y: number; size: number }
  maxSceneBytes: number
  // what every scene of the world carries: the pool sets the world's settings
  worldConfiguration: Record<string, unknown>
}

export interface PoolClient {
  lease(): Promise<SharedLease>
  sign(entity: string, bytes: number): Promise<AuthChain>
  // the upload finished; resolves once the service saw the scene land, or gave up waiting
  published(entityId: string): Promise<void>
}

type SignedFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: BodyInit | null }) => Promise<Response>

const mb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`
const SETTLE_TRIES = 6
const SETTLE_MS = 2000

// What the service's refusal codes mean to the creator.
function poolRefusal(status: number, body: { error?: unknown; retryAfter?: unknown; limit?: unknown; zone?: { size?: unknown } }): PublishError {
  const code = typeof body.error === 'string' ? body.error : `status ${status}`
  const detail = `${status} ${code}`
  const wait = typeof body.retryAfter === 'number' ? body.retryAfter : null
  const later = wait === null ? 'Try again in a minute.' : wait < 90 ? `Try again in ${wait} seconds.` : `Try again in ${Math.ceil(wait / 60)} minutes.`
  switch (code) {
    case 'pool-unavailable':
      return new PublishError('refused', "Shared worlds aren't available right now.", false, detail)
    case 'pool-not-allowed':
      return new PublishError('permission', "Shared worlds are open to a small group for now, and this wallet isn't in it yet.", false, detail)
    case 'pool-blocked':
      return new PublishError('permission', 'This wallet can no longer publish to shared worlds.', false, detail)
    case 'pool-full':
      return new PublishError('refused', 'The shared worlds have no room for another scene right now. Try again later, or get a NAME of your own.', true, detail)
    case 'pool-busy':
    case 'rate-limited':
      return new PublishError('busy', `Too many publishes at once. ${later}`, true, detail)
    case 'scene-too-large':
      return new PublishError('too-large', `A scene in a shared world can be ${mb(Number(body.limit))} at most. Remove or shrink its largest files.`, false, detail)
    case 'outside-zone':
      return new PublishError('invalid-scene', `A scene in a shared world fits in ${Number(body.zone?.size)}×${Number(body.zone?.size)} parcels. Use fewer parcels in Scene settings.`, false, detail)
    case 'parcels-taken':
      return new PublishError('changed', 'Something else stands on your parcels of the shared world. Publish again.', true, detail)
    case 'entity-timestamp':
      return new PublishError('expired', "This device's clock is off. Check the date and time, then publish again.", false, detail)
    case 'no-lease':
      return new PublishError('changed', 'Your place in the shared world was given back. Publish again to get a new one.', true, detail)
    default:
      if (status >= 500) return new PublishError('busy', `Shared worlds had a problem (${code}). ${later}`, true, detail)
      return new PublishError('refused', `The shared world refused this scene: ${code}`, false, detail)
  }
}

export function createPoolClient(base: string, signedFetch: SignedFetch): PoolClient {
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    let response: Response
    try {
      response = await signedFetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body)
      })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      if (why === 'not-signed-in') throw new PublishError('not-signed-in', 'Sign in to publish')
      throw new PublishError('network', 'Could not reach the editor service. Check your connection and try again.', true, why)
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok && response.status !== 202) throw poolRefusal(response.status, json)
    return { status: response.status, json }
  }

  return {
    async lease() {
      const { json } = await call('POST', '/pool/lease')
      return json.lease as SharedLease
    },
    async sign(entity, bytes) {
      const { json } = await call('POST', '/pool/sign', { entity, bytes })
      return json.authChain as AuthChain
    },
    async published(entityId) {
      for (let attempt = 0; attempt < SETTLE_TRIES; attempt++) {
        if ((await call('POST', '/pool/published', { entityId })).status !== 202) return
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      }
    }
  }
}

const parcel = (text: string): [number, number] => text.split(',').map(Number) as [number, number]

// The project's scene.json with its parcels moved, as one block, into the lent zone and the
// world's settings set to the pool's. The project keeps its own: only the published copy moves.
export function placeInZone(bytes: Uint8Array | undefined, lease: SharedLease): Uint8Array {
  const scene: RawSceneJson | null = parseSceneJson(bytes)
  const parcels = scene?.scene?.parcels
  const base = scene?.scene?.base
  if (scene === null || !Array.isArray(parcels) || parcels.length === 0 || typeof base !== 'string') {
    throw new PublishError('invalid-scene', 'This scene has no parcels. Set them in Scene settings.')
  }
  const points = parcels.map(parcel)
  const minX = Math.min(...points.map(([x]) => x))
  const minY = Math.min(...points.map(([, y]) => y))
  const width = Math.max(...points.map(([x]) => x)) - minX + 1
  const height = Math.max(...points.map(([, y]) => y)) - minY + 1
  const { size } = lease.zone
  if (width > size || height > size) {
    throw new PublishError('invalid-scene', `A scene in a shared world fits in ${size}×${size} parcels, and this one spans ${width}×${height}. Use fewer parcels in Scene settings.`)
  }
  const move = (text: string): string => {
    const [x, y] = parcel(text)
    return `${x - minX + lease.zone.x},${y - minY + lease.zone.y}`
  }
  const placed = {
    ...scene,
    scene: { ...scene.scene, parcels: parcels.map(move), base: move(base) },
    worldConfiguration: lease.worldConfiguration
  }
  return new TextEncoder().encode(JSON.stringify(placed, null, 2))
}
