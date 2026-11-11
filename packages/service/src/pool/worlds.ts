// The Worlds content server calls the pool needs. Reads are public; undeploy is signed
// by the pool wallet.
import type { PoolSigner } from './signer.ts'

const TIMEOUT_MS = 15_000

export interface StandingScene {
  entityId: string
  deployer: string
  parcels: string[]
  bytes: number
  worldConfiguration: Record<string, unknown> | null
}

export interface WorldsClient {
  /** The scenes standing on any of these parcels. */
  scenesOn(world: string, parcels: string[]): Promise<StandingScene[]>
  /** The oldest scenes of the world, at most one page. */
  firstScenes(world: string): Promise<StandingScene[]>
  permissions(world: string): Promise<{ owner: string; deployers: string[] | 'unrestricted' }>
  /** The owner's storage, shared by every NAME it holds. */
  space(owner: string): Promise<{ used: number; allowed: number }>
  undeploy(world: string, parcel: string): Promise<void>
}

interface SceneRow {
  entityId?: unknown
  deployer?: unknown
  parcels?: unknown
  size?: unknown
  entity?: { metadata?: { worldConfiguration?: unknown } }
}

const row = (scene: SceneRow): StandingScene => ({
  entityId: String(scene.entityId),
  deployer: String(scene.deployer).toLowerCase(),
  parcels: Array.isArray(scene.parcels) ? scene.parcels.map(String) : [],
  bytes: Number(scene.size ?? 0),
  worldConfiguration: (scene.entity?.metadata?.worldConfiguration as Record<string, unknown> | undefined) ?? null
})

export function createWorldsClient(server: string, signer: PoolSigner, send: typeof fetch = fetch): WorldsClient {
  const base = server.replace(/\/+$/, '')
  const world = (name: string) => `${base}/world/${encodeURIComponent(name)}`

  async function read<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await send(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Worlds answered ${response.status} for ${new URL(url).pathname}`)
    return (await response.json()) as T
  }

  return {
    async scenesOn(name, parcels) {
      const body = await read<{ scenes?: SceneRow[] }>(`${world(name)}/scenes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coordinates: parcels })
      })
      return (body.scenes ?? []).map(row)
    },
    async firstScenes(name) {
      const body = await read<{ scenes?: SceneRow[] }>(`${world(name)}/scenes?limit=100&offset=0`)
      return (body.scenes ?? []).map(row)
    },
    async permissions(name) {
      const body = await read<{ owner?: unknown; permissions?: { deployment?: { type?: unknown; wallets?: unknown } } }>(`${world(name)}/permissions`)
      const deployment = body.permissions?.deployment
      return {
        owner: String(body.owner ?? '').toLowerCase(),
        deployers: deployment?.type === 'unrestricted'
          ? 'unrestricted'
          : Array.isArray(deployment?.wallets) ? deployment.wallets.map((wallet) => String(wallet).toLowerCase()) : []
      }
    },
    async space(owner) {
      const body = await read<{ usedSpace?: unknown; maxAllowedSpace?: unknown }>(`${base}/wallet/${owner}/stats`)
      return { used: Number(body.usedSpace ?? 0), allowed: Number(body.maxAllowedSpace ?? 0) }
    },
    async undeploy(name, parcel) {
      const response = await signer.signedFetch(`${world(name)}/scenes/${encodeURIComponent(parcel)}`, { method: 'DELETE' })
      // already gone is what we wanted
      if (!response.ok && response.status !== 404) throw new Error(`Worlds refused to undeploy ${name} ${parcel}: ${response.status}`)
    }
  }
}
