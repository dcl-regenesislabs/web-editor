// Shared worlds for creators without a NAME (issue #52, approach 5). The service lends a
// guest a zone of one of the pool's NAMEs and signs their deployment there with the pool
// wallet. The guest's browser still builds and uploads it; the service never relays
// content, it only reads the entity file and decides whether to sign its id.
//
//   GET    /pool            what the pool offers and the caller's lease
//   POST   /pool/lease      lend the caller a zone (or answer the one it holds)
//   POST   /pool/sign       { entity, bytes } -> { world, entityId, authChain }
//   POST   /pool/published  { entityId }: the upload finished; the pool checks what landed
//   DELETE /pool/scene      undeploy the caller's scene and give the zone back
//
// Every pool NAME's owner shares one storage allowance across all its NAMEs, and every
// guest deploys as the same pool wallet, so most limits below are pool-wide.
import { createLock } from '../store.ts'
import { checkEntity } from './entity.ts'
import type { PoolSigner } from './signer.ts'
import { openState } from './state.ts'
import type { GuestScene, Lease } from './state.ts'
import type { StandingScene, WorldsClient } from './worlds.ts'
import { createZoneGrid } from './zones.ts'
import type { Zone } from './zones.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// a guest's own upload may come out a little larger than it said (the entity file, rounding)
const DECLARED_SLACK_BYTES = 1024 * 1024

export interface PoolLimits {
  zoneSize: number
  /** No zone comes within this many parcels of 0,0, where the NAME's own scenes are. */
  keepClear: number
  /** bevy-explorer loads the first page of /scenes only, 100 scenes. */
  leasesPerName: number
  maxSceneBytes: number
  signsPerMinute: number
  signsPerDay: number
  /** New leases one client address may take a day: wallets are free to make, addresses less so. */
  leasesPerAddressPerDay: number
  /** New leases the whole pool hands out an hour, so a farm of wallets cannot drain it at once. */
  leasesPerHour: number
  /** Signed deployments not yet seen landed. Worlds holds at most 10 pending per deployer, and every guest is one deployer. */
  pendingDeploys: number
  pendingSeconds: number
  /** A lease that never got a scene goes back after this long. */
  idleLeaseHours: number
}

export const DEFAULT_POOL_LIMITS: PoolLimits = {
  zoneSize: 10,
  keepClear: 30,
  leasesPerName: 100,
  maxSceneBytes: 50 * 1024 * 1024,
  signsPerMinute: 4,
  signsPerDay: 60,
  leasesPerAddressPerDay: 3,
  leasesPerHour: 60,
  pendingDeploys: 8,
  pendingSeconds: 120,
  idleLeaseHours: 24
}

export interface PoolRequest {
  method: string
  path: string
  wallet: string
  /** The client address, when the service sits behind a proxy that names it. */
  ip: string | null
  body: Uint8Array
}

export interface PoolStatus {
  signer: string
  worldsContent: string
  limits: PoolLimits
  names: Array<{ name: string; owner: string | null; canDeploy: boolean | null; whitelisted: boolean; leases: number; usedSpace: number | null; allowedSpace: number | null }>
  leases: Array<{ wallet: string; name: string; zone: Zone; leasedAt: string; scene: { base: string; title: string; bytes: number; publishedAt: string } | null }>
  pending: number
  blocked: Array<{ wallet: string; reason: string; at: string }>
}

export interface PoolService {
  handle(request: PoolRequest): Promise<Response>
  status(): Promise<PoolStatus>
  /** Settles signatures whose upload was never reported, and frees idle leases. */
  sweep(): Promise<void>
}

export interface PoolOptions {
  names: readonly string[]
  signer: PoolSigner
  worlds: WorldsClient
  worldsContent: string
  stateDir: string
  /** null: any signed-in wallet. */
  wallets: ReadonlySet<string> | null
  blocked?: ReadonlySet<string>
  /**
   * NAMEs the Worlds server exempts from the owner's storage allowance (its whitelist gives
   * them a fixed per-scene cap and no shared total). For these the pool does not gate on the
   * owner's free space — it would otherwise self-limit to the owner's on-chain allowance, which
   * the exemption makes irrelevant. The per-scene cap and leasesPerName still bound the world.
   */
  whitelisted?: readonly string[]
  limits?: Partial<PoolLimits>
  now?: () => number
  log?: (message: string) => void
}

interface Pending {
  entityId: string
  wallet: string
  name: string
  owner: string
  bytes: number
  parcels: string[]
  base: string
  title: string
  at: number
}

class Refused extends Error {
  status: number
  code: string
  detail: Record<string, unknown>
  constructor(status: number, code: string, detail: Record<string, unknown> = {}) {
    super(code)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
  })

/** A fixed window per key, in this process's memory. */
function createWindow(windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    /** The seconds until the window resets when `limit` is spent, else 0 (and the call is counted). */
    take(key: string, now: number, limit: number): number {
      if (windows.size > 10_000) for (const [other, w] of windows) if (now - w.start >= windowMs) windows.delete(other)
      let window = windows.get(key)
      if (window === undefined || now - window.start >= windowMs) {
        window = { start: now, count: 0 }
        windows.set(key, window)
      }
      if (window.count >= limit) return Math.max(1, Math.ceil((window.start + windowMs - now) / 1000))
      window.count++
      return 0
    }
  }
}

function cached<T>(ttlMs: number, now: () => number) {
  const entries = new Map<string, { value: T; at: number }>()
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key)
    if (hit !== undefined && now() - hit.at < ttlMs) return hit.value
    const value = await load()
    entries.set(key, { value, at: now() })
    return value
  }
}

export async function createPoolService(options: PoolOptions): Promise<PoolService> {
  const limits: PoolLimits = { ...DEFAULT_POOL_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const { signer, worlds } = options
  const names = options.names.map((name) => name.toLowerCase())
  const whitelisted = new Set((options.whitelisted ?? []).map((name) => name.toLowerCase()))
  // A whitelisted world is exempt from the owner's allowance, so the owner's free space is not a gate.
  const quotaExempt = (name: string) => whitelisted.has(name)
  const grid = createZoneGrid(limits.zoneSize, limits.keepClear)
  const file = await openState(options.stateDir)
  const { state } = file
  const lock = createLock()
  const pending = new Map<string, Pending>()
  const signsPerMinute = createWindow(MINUTE)
  const signsPerDay = createWindow(DAY)
  const leasesPerAddress = createWindow(DAY)
  const leasesPerHour = createWindow(HOUR)
  const permissions = cached<{ owner: string; deployers: string[] | 'unrestricted' }>(10 * MINUTE, now)
  const configurations = cached<Record<string, unknown>>(10 * MINUTE, now)
  const spaces = cached<{ used: number; allowed: number }>(30_000, now)

  const blocked = (wallet: string) => options.blocked?.has(wallet) === true || state.blocked[wallet] !== undefined
  const leasesOn = (name: string) => Object.values(state.leases).filter((lease) => lease.name === name)
  const ownerOf = async (name: string) => (await permissions(name, () => worlds.permissions(name))).owner
  const canDeploy = async (name: string) => {
    const { deployers } = await permissions(name, () => worlds.permissions(name))
    return deployers === 'unrestricted' || deployers.includes(signer.address)
  }
  // the world settings every scene of the world carries, taken from the NAME's own scenes
  const worldConfiguration = (name: string) => configurations(name, async () => {
    const own = (await worlds.firstScenes(name)).find((scene) => scene.deployer !== signer.address && scene.worldConfiguration !== null)
    return { ...(own?.worldConfiguration ?? {}), name }
  })
  const freeSpace = async (owner: string) => {
    const { used, allowed } = await spaces(owner, () => worlds.space(owner))
    let reserved = 0
    for (const sign of pending.values()) if (sign.owner === owner) reserved += sign.bytes
    return allowed - used - reserved
  }

  const scene = (s: GuestScene) => ({ base: s.base, title: s.title, bytes: s.bytes, publishedAt: new Date(s.publishedAt).toISOString() })
  async function leaseView(lease: Lease) {
    return {
      world: lease.name,
      zone: { ...lease.zone, size: grid.size },
      maxSceneBytes: limits.maxSceneBytes,
      worldConfiguration: await worldConfiguration(lease.name),
      scene: lease.scene === null ? null : scene(lease.scene)
    }
  }

  function mustBeAllowed(wallet: string) {
    if (blocked(wallet)) throw new Refused(403, 'pool-blocked')
    if (options.wallets !== null && !options.wallets.has(wallet)) throw new Refused(403, 'pool-not-allowed')
  }

  function mustHoldLease(wallet: string): Lease {
    const lease = state.leases[wallet]
    if (lease === undefined) throw new Refused(409, 'no-lease')
    return lease
  }

  // A zone nobody holds and nothing stands on: a pool scene left from an earlier lease, or
  // the owner's own, would be replaced by the first publish there.
  async function freeZone(name: string): Promise<Zone | null> {
    const held = new Set(leasesOn(name).map((lease) => grid.anchor(lease.zone)))
    let tried = 0
    for (const zone of grid.zones) {
      if (held.has(grid.anchor(zone))) continue
      if (++tried > 5) return null
      if ((await worlds.scenesOn(name, grid.parcels(zone))).length === 0) return zone
    }
    return null
  }

  async function lease(wallet: string, ip: string | null) {
    mustBeAllowed(wallet)
    return lock('leases', async () => {
      const held = state.leases[wallet]
      if (held !== undefined) return json(200, { lease: await leaseView(held) })
      const at = now()
      if (ip !== null) {
        const wait = leasesPerAddress.take(ip, at, limits.leasesPerAddressPerDay)
        if (wait > 0) throw new Refused(429, 'rate-limited', { retryAfter: wait })
      }
      const wait = leasesPerHour.take('pool', at, limits.leasesPerHour)
      if (wait > 0) {
        log(`Pool lease rate reached (${limits.leasesPerHour} an hour)`)
        throw new Refused(429, 'pool-busy', { retryAfter: wait })
      }
      for (const name of names) {
        if (leasesOn(name).length >= limits.leasesPerName) continue
        if (!(await canDeploy(name))) continue
        if (!quotaExempt(name) && (await freeSpace(await ownerOf(name))) < limits.maxSceneBytes) continue
        const zone = await freeZone(name)
        if (zone === null) continue
        const lease: Lease = { wallet, name, zone, ip, leasedAt: at, scene: null }
        state.leases[wallet] = lease
        await file.save()
        return json(200, { lease: await leaseView(lease) })
      }
      log('Pool is full: no NAME has a zone and room for another scene')
      throw new Refused(503, 'pool-full')
    })
  }

  async function sign(wallet: string, body: Uint8Array) {
    mustBeAllowed(wallet)
    const lease = mustHoldLease(wallet)
    let request: { entity?: unknown; bytes?: unknown }
    try {
      request = JSON.parse(new TextDecoder().decode(body)) as typeof request
    } catch {
      throw new Refused(400, 'invalid-json')
    }
    if (typeof request.entity !== 'string') throw new Refused(400, 'no-entity')
    const declared = request.bytes
    if (typeof declared !== 'number' || !Number.isSafeInteger(declared) || declared < 0) throw new Refused(400, 'invalid-size')
    if (declared > limits.maxSceneBytes) throw new Refused(413, 'scene-too-large', { limit: limits.maxSceneBytes })

    const at = now()
    for (const [window, limit] of [[signsPerMinute, limits.signsPerMinute], [signsPerDay, limits.signsPerDay]] as const) {
      const wait = window.take(wallet, at, limit)
      if (wait > 0) throw new Refused(429, 'rate-limited', { retryAfter: wait })
    }
    const owner = await ownerOf(lease.name)
    return lock(`owner:${owner}`, async () => {
      for (const sign of pending.values()) if (at - sign.at > limits.pendingSeconds * 1000) pending.delete(sign.entityId)
      if (pending.size >= limits.pendingDeploys) throw new Refused(429, 'pool-busy', { retryAfter: 30 })

      const checked = await checkEntity(new TextEncoder().encode(request.entity as string), {
        world: lease.name, worldConfiguration: await worldConfiguration(lease.name)
      }, at)
      if ('error' in checked) throw new Refused(400, checked.error)
      const zone = { ...lease.zone, size: grid.size }
      if (!checked.parcels.every((parcel) => grid.contains(lease.zone, parcel))) throw new Refused(400, 'outside-zone', { zone })

      const standing = await worlds.scenesOn(lease.name, checked.parcels)
      // never sign over a scene that is not this guest's: Worlds would replace it without a word
      const foreign = standing.filter((s) => s.deployer !== signer.address || !s.parcels.every((parcel) => grid.contains(lease.zone, parcel)))
      if (foreign.length > 0) throw new Refused(409, 'parcels-taken')
      // the scenes this one replaces give their space back
      const credited = standing.reduce((sum, s) => sum + s.bytes, 0)
      if (!quotaExempt(lease.name) && declared > (await freeSpace(owner)) + credited) throw new Refused(507, 'pool-full')

      pending.set(checked.entityId, { ...checked, wallet, name: lease.name, owner, bytes: declared, at })
      return json(200, { world: lease.name, entityId: checked.entityId, authChain: signer.signEntity(checked.entityId) })
    })
  }

  // What landed for a signature: the scene is recorded, or, when it is larger than allowed
  // or than the guest said, taken down and the wallet blocked.
  async function settle(sign: Pending): Promise<'landed' | 'waiting' | 'missing' | 'refused'> {
    const lease = state.leases[sign.wallet]
    const landed: StandingScene | undefined = (await worlds.scenesOn(sign.name, [sign.base])).find((s) => s.entityId === sign.entityId)
    if (landed === undefined) {
      if (now() - sign.at <= limits.pendingSeconds * 1000) return 'waiting'
      pending.delete(sign.entityId)
      return 'missing'
    }
    pending.delete(sign.entityId)
    spaces(sign.owner, () => worlds.space(sign.owner)).catch(() => {})
    if (landed.bytes > limits.maxSceneBytes || landed.bytes > sign.bytes + DECLARED_SLACK_BYTES) {
      await worlds.undeploy(sign.name, sign.base)
      state.blocked[sign.wallet] = { reason: `declared ${sign.bytes} bytes, deployed ${landed.bytes}`, at: now() }
      if (lease !== undefined) lease.scene = null
      await file.save()
      log(`Pool scene of ${sign.wallet} taken down: ${landed.bytes} bytes against ${sign.bytes} declared`)
      return 'refused'
    }
    if (lease !== undefined && lease.name === sign.name) {
      // a scene moved within the zone leaves the last one standing beside it: one scene per guest
      for (const old of await worlds.scenesOn(sign.name, grid.parcels(lease.zone))) {
        if (old.entityId !== sign.entityId && old.deployer === signer.address) await worlds.undeploy(sign.name, old.parcels[0])
      }
      lease.scene = { entityId: sign.entityId, parcels: sign.parcels, base: sign.base, title: sign.title, bytes: landed.bytes, publishedAt: now() }
      await file.save()
    }
    return 'landed'
  }

  async function published(wallet: string, body: Uint8Array) {
    let entityId: unknown
    try {
      entityId = (JSON.parse(new TextDecoder().decode(body)) as { entityId?: unknown }).entityId
    } catch {
      throw new Refused(400, 'invalid-json')
    }
    const sign = typeof entityId === 'string' ? pending.get(entityId) : undefined
    if (sign === undefined || sign.wallet !== wallet) {
      // already settled by the sweep
      const current = state.leases[wallet]?.scene ?? null
      if (current !== null && current.entityId === entityId) return json(200, { scene: scene(current) })
      throw new Refused(404, 'not-signed')
    }
    const outcome = await settle(sign)
    if (outcome === 'waiting') return json(202, { waiting: true })
    if (outcome === 'missing') throw new Refused(404, 'not-deployed')
    if (outcome === 'refused') throw new Refused(403, 'pool-blocked')
    const lease = mustHoldLease(wallet)
    return json(200, { scene: lease.scene === null ? null : scene(lease.scene) })
  }

  async function remove(wallet: string) {
    const lease = mustHoldLease(wallet)
    return lock('leases', async () => {
      const standing = await worlds.scenesOn(lease.name, grid.parcels(lease.zone))
      let removed = 0
      for (const s of standing) {
        if (s.deployer !== signer.address || !s.parcels.every((parcel) => grid.contains(lease.zone, parcel))) continue
        await worlds.undeploy(lease.name, s.parcels[0])
        removed++
      }
      delete state.leases[wallet]
      await file.save()
      return json(200, { removed })
    })
  }

  async function route(request: PoolRequest): Promise<Response> {
    const { method, path, wallet } = request
    if (path === '/pool' && method === 'GET') {
      const lease = state.leases[wallet]
      return json(200, {
        available: !blocked(wallet) && (options.wallets === null || options.wallets.has(wallet)),
        worldsContent: options.worldsContent,
        zoneSize: grid.size,
        maxSceneBytes: limits.maxSceneBytes,
        lease: lease === undefined ? null : await leaseView(lease)
      })
    }
    if (path === '/pool/lease' && method === 'POST') return lease(wallet, request.ip)
    if (path === '/pool/sign' && method === 'POST') return sign(wallet, request.body)
    if (path === '/pool/published' && method === 'POST') return published(wallet, request.body)
    if (path === '/pool/scene' && method === 'DELETE') return remove(wallet)
    return json(404, { error: 'not-found' })
  }

  return {
    async handle(request) {
      try {
        return await route(request)
      } catch (error) {
        if (error instanceof Refused) {
          const retryAfter = error.detail.retryAfter
          return json(error.status, { error: error.code, ...error.detail }, typeof retryAfter === 'number' ? { 'retry-after': String(retryAfter) } : {})
        }
        log(`Pool request failed: ${error instanceof Error ? error.message : String(error)}`)
        return json(502, { error: 'worlds-unavailable' })
      }
    },
    async status() {
      const at = now()
      return {
        signer: signer.address,
        worldsContent: options.worldsContent,
        limits,
        names: await Promise.all(names.map(async (name) => {
          const owner = await ownerOf(name).catch(() => null)
          const space = owner === null ? null : await spaces(owner, () => worlds.space(owner)).catch(() => null)
          return {
            name,
            owner,
            canDeploy: await canDeploy(name).catch(() => null),
            whitelisted: quotaExempt(name),
            leases: leasesOn(name).length,
            usedSpace: space?.used ?? null,
            allowedSpace: space?.allowed ?? null
          }
        })),
        leases: Object.values(state.leases).map((lease) => ({
          wallet: lease.wallet, name: lease.name, zone: lease.zone, leasedAt: new Date(lease.leasedAt).toISOString(),
          scene: lease.scene === null ? null : scene(lease.scene)
        })),
        pending: [...pending.values()].filter((sign) => at - sign.at <= limits.pendingSeconds * 1000).length,
        blocked: Object.entries(state.blocked).map(([wallet, block]) => ({ wallet, reason: block.reason, at: new Date(block.at).toISOString() }))
      }
    },
    async sweep() {
      for (const sign of [...pending.values()]) {
        await lock(`owner:${sign.owner}`, () => settle(sign)).catch((error: unknown) =>
          log(`Pool could not check ${sign.entityId}: ${error instanceof Error ? error.message : String(error)}`))
      }
      const at = now()
      const waiting = new Set([...pending.values()].map((sign) => sign.wallet))
      await lock('leases', async () => {
        let freed = 0
        for (const lease of Object.values(state.leases)) {
          if (lease.scene !== null || waiting.has(lease.wallet) || at - lease.leasedAt < limits.idleLeaseHours * HOUR) continue
          delete state.leases[lease.wallet]
          freed++
        }
        if (freed > 0) await file.save()
      })
    }
  }
}

