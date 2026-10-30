import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Authenticator } from '@dcl/crypto'
import type { AuthChain } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { afterAll, describe, expect, it } from 'vitest'
import { contentCid } from '../../../contract/src/cid.ts'
import { createRateLimiter, createUploadGate } from '../config.ts'
import type { Env } from '../config.ts'
import { handle } from '../handler.ts'
import { createLock, createMemoryStore } from '../store.ts'
import { createTestWallet } from '../testing/wallet.ts'
import { createPoolService } from './pool.ts'
import type { PoolLimits, PoolRequest } from './pool.ts'
import { createPoolSigner } from './signer.ts'
import type { StandingScene, WorldsClient } from './worlds.ts'

const NAME = 'pool.dcl.eth'
const OWNER = '0x1111111111111111111111111111111111111111'
const GUEST = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const MB = 1024 * 1024
const CONFIG = { name: NAME, skyboxConfig: { fixedTime: 0 } }

// the fields these tests read; the service answers plain JSON
interface Reply {
  error?: string
  lease: { zone: { x: number; y: number }; scene: unknown }
  scene: unknown
  entityId?: string
  authChain: AuthChain
  removed?: number
}

const temp: string[] = []
afterAll(() => Promise.all(temp.map((dir) => rm(dir, { recursive: true, force: true }))))

// A Worlds server in memory: the NAME's own scene at 0,0 and whatever the pool deploys.
function fakeWorlds(signerAddress: string, allowed = 300 * MB) {
  const scenes = new Map<string, StandingScene>()
  scenes.set('owner-scene', { entityId: 'owner-scene', deployer: OWNER, parcels: ['0,0'], bytes: 10 * MB, worldConfiguration: CONFIG })
  const undeployed: string[] = []
  const worlds: WorldsClient = {
    scenesOn: async (_world, parcels) => [...scenes.values()].filter((s) => s.parcels.some((p) => parcels.includes(p))),
    firstScenes: async () => [...scenes.values()],
    permissions: async () => ({ owner: OWNER, deployers: [signerAddress] }),
    space: async () => ({ used: [...scenes.values()].reduce((sum, s) => sum + s.bytes, 0), allowed }),
    undeploy: async (_world, parcel) => {
      undeployed.push(parcel)
      for (const [id, s] of scenes) if (s.parcels.includes(parcel)) scenes.delete(id)
    }
  }
  // what POST /entities does with a deployment the pool signed: replaces what stands on its parcels
  const deploy = (entityId: string, parcels: string[], bytes: number, deployer = signerAddress) => {
    for (const [id, s] of scenes) if (s.parcels.some((p) => parcels.includes(p))) scenes.delete(id)
    scenes.set(entityId, { entityId, deployer, parcels, bytes, worldConfiguration: CONFIG })
  }
  return { worlds, scenes, deploy, undeployed }
}

async function setup(limits: Partial<PoolLimits> = {}, extra: { wallets?: ReadonlySet<string> | null; allowed?: number; whitelisted?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dcl-editor-pool-'))
  temp.push(dir)
  let now = Date.now()
  const signer = createPoolSigner(createUnsafeIdentity())
  const fake = fakeWorlds(signer.address, extra.allowed)
  const pool = await createPoolService({
    names: [NAME], signer, worlds: fake.worlds, worldsContent: 'https://worlds.test', stateDir: dir,
    wallets: extra.wallets ?? null, whitelisted: extra.whitelisted ? [NAME] : [], limits, now: () => now
  })
  const call = async (wallet: string, method: string, route: string, body: unknown = null, ip: string | null = '10.0.0.1') => {
    const request: PoolRequest = { method, path: route, wallet, ip, body: new TextEncoder().encode(body === null ? '' : JSON.stringify(body)) }
    const response = await pool.handle(request)
    return { status: response.status, body: (await response.json()) as Reply, headers: response.headers }
  }
  const entity = async (parcels: string[], options: { config?: Record<string, unknown>; timestamp?: number } = {}) => {
    const text = JSON.stringify({
      version: 'v3', type: 'scene', pointers: parcels, timestamp: options.timestamp ?? now, content: [],
      metadata: { display: { title: 'guest scene' }, scene: { base: parcels[0], parcels }, worldConfiguration: options.config ?? CONFIG }
    })
    return { text, entityId: await contentCid(new TextEncoder().encode(text)) }
  }
  return { pool, signer, fake, call, entity, dir, advance: (ms: number) => void (now += ms) }
}

const zoneParcels = (zone: { x: number; y: number }, ...offsets: Array<[number, number]>) => offsets.map(([dx, dy]) => `${zone.x + dx},${zone.y + dy}`)

describe('name pool', () => {
  it('lends a zone far from the NAME\'s own scenes, with the world settings the NAME uses, once per wallet', async () => {
    const { call } = await setup()
    const first = await call(GUEST, 'POST', '/pool/lease')
    expect(first.status).toBe(200)
    expect(first.body.lease).toMatchObject({ world: NAME, zone: { x: -150, y: -150, size: 10 }, worldConfiguration: CONFIG, scene: null })
    expect((await call(GUEST, 'POST', '/pool/lease')).body.lease.zone).toEqual(first.body.lease.zone)
    expect((await call(OTHER, 'POST', '/pool/lease')).body.lease.zone).toMatchObject({ x: -140, y: -150 })
  })

  it('signs an entity inside the zone, and records the scene once it landed', async () => {
    const { call, entity, fake, signer } = await setup()
    const { zone } = (await call(GUEST, 'POST', '/pool/lease')).body.lease
    const parcels = zoneParcels(zone, [0, 0], [1, 0])
    const { text, entityId } = await entity(parcels)
    const signed = await call(GUEST, 'POST', '/pool/sign', { entity: text, bytes: 2 * MB })
    expect(signed.status).toBe(200)
    expect(signed.body).toMatchObject({ world: NAME, entityId })
    const chain = signed.body.authChain
    expect(chain[0].payload.toLowerCase()).toBe(signer.address)
    expect(chain[chain.length - 1].payload).toBe(entityId)
    expect((await Authenticator.validateSignature(entityId, signed.body.authChain, null)).ok).toBe(true)

    expect((await call(GUEST, 'POST', '/pool/published', { entityId })).status).toBe(202)
    fake.deploy(entityId, parcels, 2 * MB)
    const published = await call(GUEST, 'POST', '/pool/published', { entityId })
    expect(published.status).toBe(200)
    expect(published.body.scene).toMatchObject({ base: parcels[0], bytes: 2 * MB, title: 'guest scene' })
    expect((await call(GUEST, 'GET', '/pool')).body.lease.scene).toMatchObject({ bytes: 2 * MB })
  })

  it('refuses what the entity file says rather than what the caller does', async () => {
    const { call, entity } = await setup({ signsPerMinute: 100 })
    const { zone } = (await call(GUEST, 'POST', '/pool/lease')).body.lease
    const sign = async (parcels: string[], options: Parameters<typeof entity>[1] = {}, bytes = MB) =>
      call(GUEST, 'POST', '/pool/sign', { entity: (await entity(parcels, options)).text, bytes })
    expect((await sign(['0,0'])).body.error).toBe('outside-zone')
    expect((await sign(zoneParcels(zone, [0, 0], [10, 0]))).body.error).toBe('outside-zone')
    expect((await sign(zoneParcels(zone, [0, 0]), { config: { ...CONFIG, skyboxConfig: { fixedTime: 12 } } })).body.error).toBe('world-configuration')
    expect((await sign(zoneParcels(zone, [0, 0]), { config: { name: 'other.dcl.eth' } })).body.error).toBe('wrong-world')
    expect((await sign(zoneParcels(zone, [0, 0]), { timestamp: Date.now() - 10 * 60_000 })).body.error).toBe('entity-timestamp')
    const large = await sign(zoneParcels(zone, [0, 0]), {}, 51 * MB)
    expect(large).toMatchObject({ status: 413, body: { error: 'scene-too-large' } })
  })

  it('keeps one scene per guest: a scene moved within the zone replaces the last one', async () => {
    const { call, entity, fake } = await setup()
    const { zone } = (await call(GUEST, 'POST', '/pool/lease')).body.lease
    for (const parcels of [zoneParcels(zone, [0, 0]), zoneParcels(zone, [5, 5], [5, 6])]) {
      const { text, entityId } = await entity(parcels)
      expect((await call(GUEST, 'POST', '/pool/sign', { entity: text, bytes: MB })).status).toBe(200)
      fake.deploy(entityId, parcels, MB)
      expect((await call(GUEST, 'POST', '/pool/published', { entityId })).status).toBe(200)
    }
    expect([...fake.scenes.values()].map((s) => s.parcels)).toEqual([['0,0'], zoneParcels(zone, [5, 5], [5, 6])])
  })

  it('never signs over a scene that is not the guest\'s', async () => {
    const { call, entity, fake } = await setup()
    const { zone } = (await call(GUEST, 'POST', '/pool/lease')).body.lease
    const parcels = zoneParcels(zone, [0, 0])
    fake.deploy('someone-else', parcels, MB, OWNER)
    const signed = await call(GUEST, 'POST', '/pool/sign', { entity: (await entity(parcels)).text, bytes: MB })
    expect(signed).toMatchObject({ status: 409, body: { error: 'parcels-taken' } })
  })

  it('limits how often a wallet signs, and says when to come back', async () => {
    const { call, entity } = await setup({ signsPerMinute: 2 })
    const { zone } = (await call(GUEST, 'POST', '/pool/lease')).body.lease
    const body = { entity: (await entity(zoneParcels(zone, [0, 0]))).text, bytes: MB }
    expect((await call(GUEST, 'POST', '/pool/sign', body)).status).toBe(200)
    expect((await call(GUEST, 'POST', '/pool/sign', body)).status).toBe(200)
    const third = await call(GUEST, 'POST', '/pool/sign', body)
    expect(third).toMatchObject({ status: 429, body: { error: 'rate-limited' } })
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('holds back signatures while Worlds has as many pool uploads pending as it takes', async () => {
    const { call, entity, advance } = await setup({ pendingDeploys: 1, pendingSeconds: 60 })
    const guest = (await call(GUEST, 'POST', '/pool/lease')).body.lease.zone
    const other = (await call(OTHER, 'POST', '/pool/lease')).body.lease.zone
    expect((await call(GUEST, 'POST', '/pool/sign', { entity: (await entity(zoneParcels(guest, [0, 0]))).text, bytes: MB })).status).toBe(200)
    const busy = await call(OTHER, 'POST', '/pool/sign', { entity: (await entity(zoneParcels(other, [0, 0]))).text, bytes: MB })
    expect(busy).toMatchObject({ status: 429, body: { error: 'pool-busy' } })
    advance(61_000)
    expect((await call(OTHER, 'POST', '/pool/sign', { entity: (await entity(zoneParcels(other, [0, 0]))).text, bytes: MB })).status).toBe(200)
  })

  it('takes down a scene larger than the guest said, and blocks the wallet', async () => {
    const { call, entity, fake, pool } = await setup()
    const { zone } = (await call(GUEST, 'POST', '/pool/lease')).body.lease
    const parcels = zoneParcels(zone, [0, 0])
    const { text, entityId } = await entity(parcels)
    expect((await call(GUEST, 'POST', '/pool/sign', { entity: text, bytes: MB })).status).toBe(200)
    fake.deploy(entityId, parcels, 40 * MB)
    expect((await call(GUEST, 'POST', '/pool/published', { entityId })).body.error).toBe('pool-blocked')
    expect(fake.undeployed).toEqual([parcels[0]])
    expect((await call(GUEST, 'POST', '/pool/sign', { entity: text, bytes: MB })).body.error).toBe('pool-blocked')
    expect((await pool.status()).blocked).toEqual([expect.objectContaining({ wallet: GUEST })])
  })

  it('keeps a lease to the wallets allowed, and new leases to a few per address', async () => {
    const allowed = await setup({}, { wallets: new Set([GUEST]) })
    expect((await allowed.call(OTHER, 'POST', '/pool/lease')).body.error).toBe('pool-not-allowed')

    const { call } = await setup({ leasesPerAddressPerDay: 2 })
    const wallets = ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555', '0x6666666666666666666666666666666666666666']
    expect((await call(wallets[0], 'POST', '/pool/lease')).status).toBe(200)
    expect((await call(wallets[1], 'POST', '/pool/lease')).status).toBe(200)
    expect((await call(wallets[2], 'POST', '/pool/lease')).status).toBe(429)
    expect((await call(wallets[2], 'POST', '/pool/lease', null, '10.0.0.2')).status).toBe(200)
  })

  it('says the pool is full when the owner has no room for another scene', async () => {
    const { call } = await setup({}, { allowed: 50 * MB })
    expect((await call(GUEST, 'POST', '/pool/lease')).body.error).toBe('pool-full')
  })

  it('ignores the owner allowance for a whitelisted NAME (the Worlds whitelist exempts it)', async () => {
    // owner allowance (20 MB, 10 used) leaves 10 MB free: a non-whitelisted NAME would refuse
    // both the lease (free < maxSceneBytes) and a 40 MB sign (free + credited < declared).
    const { call, entity } = await setup({}, { allowed: 20 * MB, whitelisted: true })
    const leased = await call(GUEST, 'POST', '/pool/lease')
    expect(leased.status).toBe(200)
    const parcels = zoneParcels(leased.body.lease.zone, [0, 0])
    const big = await entity(parcels)
    const signed = await call(GUEST, 'POST', '/pool/sign', { entity: big.text, bytes: 40 * MB })
    expect(signed.status).toBe(200)
    expect(signed.body.entityId).toBe(big.entityId)
  })

  it('removes the guest\'s scene and gives the zone back', async () => {
    const { call, entity, fake } = await setup()
    const { zone } = (await call(GUEST, 'POST', '/pool/lease')).body.lease
    const parcels = zoneParcels(zone, [0, 0])
    const { text, entityId } = await entity(parcels)
    await call(GUEST, 'POST', '/pool/sign', { entity: text, bytes: MB })
    fake.deploy(entityId, parcels, MB)
    expect((await call(GUEST, 'DELETE', '/pool/scene')).body).toEqual({ removed: 1 })
    expect(fake.scenes.has(entityId)).toBe(false)
    expect(fake.scenes.has('owner-scene')).toBe(true)
    expect((await call(GUEST, 'GET', '/pool')).body.lease).toBeNull()
  })

  it('remembers leases across restarts and frees the ones that never got a scene', async () => {
    const first = await setup({ idleLeaseHours: 1 })
    await first.call(GUEST, 'POST', '/pool/lease')
    const again = await createPoolService({
      names: [NAME], signer: first.signer, worlds: first.fake.worlds, worldsContent: 'https://worlds.test', stateDir: first.dir,
      wallets: null, limits: { idleLeaseHours: 1 }, now: () => Date.now() + 2 * 3_600_000
    })
    expect((await again.status()).leases).toHaveLength(1)
    await again.sweep()
    expect((await again.status()).leases).toHaveLength(0)
  })
})

describe('the pool routes', () => {
  const ORIGIN = 'http://localhost:5230'
  const env = (pool?: Env['pool']): Env => ({
    store: createMemoryStore(), allowedOrigins: [ORIGIN], ticketSecret: 'test-secret-test-secret-test-secret',
    rateLimiter: createRateLimiter(), uploads: createUploadGate(), lock: createLock(), pool, clientIpHeader: 'x-real-ip'
  })

  it('takes the signed wallet and the proxy\'s client address, and answers 503 while the pool is off', async () => {
    const seen: PoolRequest[] = []
    const pool = { handle: async (request: PoolRequest) => { seen.push(request); return Response.json({ ok: true }) }, status: async () => { throw new Error('unused') }, sweep: async () => {} }
    const wallet = await createTestWallet({ origin: ORIGIN })
    const request = (target: Env) => new Request('http://storage.test/pool/lease', {
      method: 'POST', headers: { ...wallet.headers('POST', 'http://storage.test/pool/lease'), 'x-real-ip': '203.0.113.9, 10.0.0.1' }
    })
    expect((await handle(request(env(pool)), env(pool))).status).toBe(200)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/pool/lease', wallet: wallet.address, ip: '203.0.113.9' })
    expect((await handle(request(env()), env())).status).toBe(503)
    expect((await handle(new Request('http://storage.test/pool', { headers: { origin: ORIGIN } }), env(pool))).status).toBe(401)
  })
})
