import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hashV1 } from '@dcl/hashing'
import { afterAll, describe, expect, it } from 'vitest'
import { contentCid } from '../../contract/src/cid.ts'
import { createRateLimiter, createUploadGate } from './config.ts'
import type { Env, Limits } from './config.ts'
import { createFsStore } from './fs-store.ts'
import { handle } from './handler.ts'
import { purge } from './purge.ts'
import { createLock, createMemoryStore } from './store.ts'
import type { BlobStore, Clock } from './store.ts'
import { createTestWallet } from './testing/wallet.ts'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import type { SignOverrides, TestWallet } from './testing/wallet.ts'

const ORIGIN = 'http://localhost:5230'
const BASE = 'http://storage.test'
const DAY = 24 * 60 * 60 * 1000

const temp: string[] = []
afterAll(() => Promise.all(temp.map((dir) => rm(dir, { recursive: true, force: true }))))

async function fsStore(): Promise<BlobStore> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dcl-editor-service-'))
  temp.push(dir)
  return createFsStore(dir)
}

function setup(limits: Partial<Limits> = {}, store?: BlobStore) {
  let now = Date.now()
  const clock: Clock = { now: () => now }
  const env: Env = {
    store: store ?? createMemoryStore(clock),
    allowedOrigins: [ORIGIN],
    ticketSecret: 'test-secret-test-secret-test-secret',
    clock,
    limits,
    rateLimiter: createRateLimiter(),
    uploads: createUploadGate(),
    lock: createLock()
  }
  const send = (request: Request) => handle(request, env)
  return {
    env,
    send,
    advance: (ms: number) => void (now += ms),
    wallet: () => createTestWallet({ origin: ORIGIN, now: clock.now, fetch: send, validMinutes: 30 * 24 * 60 })
  }
}

const bytesOf = (size: number, seed: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251)

type Files = Record<string, Uint8Array<ArrayBuffer>>

async function describeFiles(files: Files) {
  const entries = await Promise.all(
    Object.entries(files).map(async ([file, bytes]) => [file, { hash: await hashV1(bytes), size: bytes.length }] as const)
  )
  return Object.fromEntries(entries)
}

/** Ask for upload urls and PUT each blob; answers the PUT statuses by hash. */
async function upload(wallet: TestWallet, send: (r: Request) => Promise<Response>, id: string, files: Files) {
  const described = await describeFiles(files)
  const response = await wallet.signedFetch(`${BASE}/projects/${id}/uploads`, {
    method: 'POST',
    body: JSON.stringify({ files: Object.values(described) })
  })
  expect(response.status).toBe(200)
  const { uploads } = (await response.json()) as { uploads: Array<{ hash: string; url: string; method: string }> }
  const statuses: Record<string, number> = {}
  for (const target of uploads) {
    const bytes = Object.entries(described).find(([, file]) => file.hash === target.hash)
    const put = await send(new Request(target.url, { method: target.method, body: files[bytes![0]] }))
    statuses[target.hash] = put.status
  }
  return { described, statuses }
}

function putManifest(wallet: TestWallet, id: string, files: unknown, baseVersion: number | null) {
  return wallet.signedFetch(`${BASE}/projects/${id}/manifest`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'My scene', files, baseVersion })
  })
}

async function save(ctx: ReturnType<typeof setup>, wallet: TestWallet, id: string, files: Files, baseVersion: number | null) {
  const { described } = await upload(wallet, ctx.send, id, files)
  return putManifest(wallet, id, described, baseVersion)
}

const error = async (response: Response) => [response.status, ((await response.json()) as { error: string }).error]

describe.each([
  ['memory', async () => undefined],
  ['filesystem', fsStore]
])('project storage on the %s store', (_name, makeStore) => {
  it('syncs a project to a second device of the same wallet', async () => {
    const ctx = setup({}, await makeStore())
    const wallet = await ctx.wallet()
    const files = { 'src/index.ts': bytesOf(1200, 1), 'assets/model.glb': bytesOf(300_000, 2) }

    const saved = await save(ctx, wallet, 'my-scene', files, null)
    expect([saved.status, await saved.json()]).toEqual([200, { version: 1, updatedAt: expect.any(Number) }])

    const device = await wallet.anotherDevice()
    const listed = (await (await device.signedFetch(`${BASE}/projects`)).json()) as { projects: unknown[] }
    expect(listed.projects).toEqual([expect.objectContaining({ id: 'my-scene', name: 'My scene', version: 1, bytes: 301_200 })])

    const manifest = (await (await device.signedFetch(`${BASE}/projects/my-scene/manifest`)).json()) as {
      files: Record<string, { hash: string; size: number }>
    }
    expect(manifest.files).toEqual(await describeFiles(files))
    expect(manifest.files['assets/model.glb'].hash).toMatch(/^bafybei/)

    const blob = await device.signedFetch(`${BASE}/projects/my-scene/files/${manifest.files['assets/model.glb'].hash}`)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(files['assets/model.glb'])
    expect(Object.fromEntries(blob.headers)).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'access-control-allow-origin': ORIGIN
    })

    const again = await upload(device, ctx.send, 'my-scene', files)
    expect(again.statuses).toEqual({})
  })

  it('rejects a save made from a stale version and reports the current one', async () => {
    const ctx = setup({}, await makeStore())
    const wallet = await ctx.wallet()
    await save(ctx, wallet, 'my-scene', { 'a.ts': bytesOf(10, 1) }, null)
    const second = await save(ctx, wallet, 'my-scene', { 'a.ts': bytesOf(10, 2) }, 1)
    expect(second.status).toBe(200)

    const stale = await save(ctx, wallet, 'my-scene', { 'a.ts': bytesOf(10, 3) }, 1)
    expect([stale.status, await stale.json()]).toEqual([409, { error: 'stale', version: 2, updatedAt: expect.any(Number) }])
    const recreated = await save(ctx, wallet, 'my-scene', { 'a.ts': bytesOf(10, 3) }, null)
    expect(recreated.status).toBe(409)
  })
})

describe('who may call', () => {
  const sceneMetadata = {
    origin: 'https://realm.example',
    sceneId: 'bafkreiscene',
    parcel: '0,0',
    tld: 'org',
    network: 'mainnet',
    isGuest: false,
    realm: { hostname: 'https://realm.example', protocol: 'v3', serverName: 'main' },
    signer: 'decentraland-kernel-scene'
  }
  const editor = { intent: 'dcl:editor:projects', signer: 'dcl:editor', origin: ORIGIN }

  it.each<[string, SignOverrides, number, string]>([
    ['a scene signed fetch', { metadata: sceneMetadata }, 403, 'scene-signed'],
    ['editor metadata carrying a scene id', { metadata: { ...editor, sceneId: 'bafkreiscene' } }, 403, 'scene-signed'],
    ['no intent', { metadata: { signer: editor.signer, origin: ORIGIN } }, 403, 'wrong-intent'],
    ['the comms intent', { metadata: { ...editor, intent: 'dcl:explorer:comms-handshake' } }, 403, 'wrong-intent'],
    ['the explorer as signer', { metadata: { ...editor, signer: 'dcl:explorer' } }, 403, 'wrong-signer'],
    ['a timestamp two minutes old', { timestamp: Date.now() - 2 * 60 * 1000 }, 401, 'timestamp-out-of-window'],
    ['a signature for another path', { pathname: '/projects/other/manifest' }, 401, 'invalid-signature'],
    ['metadata signed for another origin', { metadata: { ...editor, origin: 'https://evil.example' } }, 403, 'origin-not-allowed']
  ])('refuses %s', async (_case, overrides, status, code) => {
    const ctx = setup()
    const wallet = await ctx.wallet()
    const url = `${BASE}/projects/my-scene/manifest`
    const response = await ctx.send(new Request(url, { headers: wallet.headers('GET', url, overrides) }))
    expect(await error(response)).toEqual([status, code])
  })

  it('refuses a request whose query was changed after signing', async () => {
    const ctx = setup()
    const wallet = await ctx.wallet()
    const url = `${BASE}/projects?prefix=other`
    const response = await ctx.send(new Request(url, { headers: wallet.headers('GET', url, { pathname: '/projects' }) }))
    expect(await error(response)).toEqual([401, 'invalid-signature'])
  })

  it('refuses a page on an origin that is not allowed, and gives it no CORS grant', async () => {
    const ctx = setup()
    const wallet = await ctx.wallet()
    const url = `${BASE}/projects`
    const response = await ctx.send(new Request(url, { headers: { ...wallet.headers('GET', url), origin: 'https://evil.example' } }))
    expect(await error(response)).toEqual([403, 'origin-not-allowed'])
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses a chain that carries the expected text but no signature', async () => {
    const ctx = setup()
    const url = `${BASE}/projects`
    const metadata = JSON.stringify(editor)
    const timestamp = String(Date.now())
    const payload = `get:/projects:${timestamp}:${metadata}`
    const response = await ctx.send(
      new Request(url, {
        headers: {
          'x-identity-auth-chain-0': JSON.stringify({ type: 'SIGNER', payload, signature: '' }),
          'x-identity-timestamp': timestamp,
          'x-identity-metadata': metadata
        }
      })
    )
    expect(await error(response)).toEqual([401, 'invalid-chain'])
  })

  it('accepts only an expiring login key between the wallet and the request', async () => {
    const ctx = setup()
    const owner = createUnsafeIdentity()
    const attacker = createUnsafeIdentity()
    const url = `${BASE}/projects`
    const metadata = JSON.stringify(editor)
    const timestamp = String(Date.now())
    const payload = `get:/projects:${timestamp}:${metadata}`
    // one personal_sign of a bare address, with no expiry, would hand the wallet over
    const bareDelegation = [
      { type: 'SIGNER', payload: owner.address, signature: '' },
      { type: 'ECDSA_SIGNED_ENTITY', payload: attacker.address.toLowerCase(), signature: Authenticator.createSignature(owner, attacker.address.toLowerCase()) },
      { type: 'ECDSA_SIGNED_ENTITY', payload, signature: Authenticator.createSignature(attacker, payload) }
    ]
    const headers: Record<string, string> = { 'x-identity-timestamp': timestamp, 'x-identity-metadata': metadata }
    bareDelegation.forEach((link, index) => (headers[`x-identity-auth-chain-${index}`] = JSON.stringify(link)))
    expect(await error(await ctx.send(new Request(url, { headers })))).toEqual([401, 'invalid-chain'])

    const longLived = await createTestWallet({ origin: ORIGIN, fetch: ctx.send, validMinutes: 60 * 24 * 60 })
    expect(await error(await longLived.signedFetch(url))).toEqual([401, 'delegation-too-long'])
    const expired = await createTestWallet({ origin: ORIGIN, fetch: ctx.send, validMinutes: -1 })
    expect(await error(await expired.signedFetch(url))).toEqual([401, 'delegation-expired'])
  })

  it('answers the preflight for the signed-fetch headers of an allowed origin only', async () => {
    const ctx = setup()
    const preflight = (origin: string) =>
      ctx.send(
        new Request(`${BASE}/projects/my-scene/manifest`, {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'PUT',
            'access-control-request-headers': 'x-identity-auth-chain-0, x-identity-auth-chain-2, x-identity-timestamp, x-identity-metadata, content-type, cookie'
          }
        })
      )
    const allowed = await preflight(ORIGIN)
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(allowed.headers.get('access-control-allow-headers')).toBe(
      'x-identity-auth-chain-0, x-identity-auth-chain-2, x-identity-timestamp, x-identity-metadata, content-type'
    )
    expect(allowed.headers.get('access-control-allow-methods')).toContain('PUT')
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull()
  })

  it('slows a wallet down past its requests per minute', async () => {
    const ctx = setup({ requestsPerMinute: 2 })
    const wallet = await ctx.wallet()
    await wallet.signedFetch(`${BASE}/projects`)
    await wallet.signedFetch(`${BASE}/projects`)
    const third = await wallet.signedFetch(`${BASE}/projects`)
    expect(third.status).toBe(429)
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})

describe('assistant routes', () => {
  it('spend their own budget, take no body, and refuse what projects refuse', async () => {
    const ctx = setup({ requestsPerMinute: 2, assistantRequestsPerMinute: 1 })
    ctx.env.assistant = { handle: async () => new Response('{}') }
    const wallet = await ctx.wallet()
    const url = `${BASE}/assistant/providers`
    const scene = { intent: 'dcl:editor:projects', signer: 'dcl:editor', origin: ORIGIN, sceneId: 'bafkreiscene' }
    expect(await error(await ctx.send(new Request(url, { headers: wallet.headers('GET', url, { metadata: scene }) })))).toEqual([403, 'scene-signed'])

    const connect = `${BASE}/assistant/connect`
    const withBody = await ctx.send(new Request(connect, { method: 'POST', headers: wallet.headers('POST', connect), body: 'x' }))
    expect(await error(withBody)).toEqual([413, 'body-too-large'])
    expect(await error(await wallet.signedFetch(url))).toEqual([429, 'rate-limited'])
    expect((await wallet.signedFetch(`${BASE}/projects`)).status).toBe(200)
    expect((await wallet.signedFetch(`${BASE}/projects`)).status).toBe(200)
  })
})

describe('what a wallet may store and read', () => {
  it('keeps a wallet from referencing a blob only another wallet uploaded', async () => {
    const ctx = setup()
    const [alice, mallory] = [await ctx.wallet(), await ctx.wallet()]
    const files = { 'secret.ts': bytesOf(64, 9) }
    await save(ctx, alice, 'my-scene', files, null)

    const stolen = await putManifest(mallory, 'copy', await describeFiles(files), null)
    expect([stolen.status, await stolen.json()]).toEqual([
      422,
      { error: 'missing-blobs', missing: [(await describeFiles(files))['secret.ts'].hash], count: 1 }
    ])
  })

  it("hides one wallet's projects and files from another", async () => {
    const ctx = setup()
    const [alice, mallory] = [await ctx.wallet(), await ctx.wallet()]
    const files = { 'secret.ts': bytesOf(64, 9) }
    await save(ctx, alice, 'my-scene', files, null)
    const { hash } = (await describeFiles(files))['secret.ts']

    expect((await mallory.signedFetch(`${BASE}/projects/my-scene/manifest`)).status).toBe(404)
    expect((await mallory.signedFetch(`${BASE}/projects/my-scene/files/${hash}`)).status).toBe(404)
    expect(((await (await mallory.signedFetch(`${BASE}/projects`)).json()) as { projects: unknown[] }).projects).toEqual([])
  })

  it('refuses an upload whose bytes are not the ticketed hash, and any second use of a ticket', async () => {
    const ctx = setup()
    const wallet = await ctx.wallet()
    const described = await describeFiles({ 'a.ts': bytesOf(100, 1) })
    const ticketed = async () => {
      // a ticket is named by its expiry, so each one here is asked for a moment later
      ctx.advance(1)
      const response = await wallet.signedFetch(`${BASE}/projects/my-scene/uploads`, {
        method: 'POST',
        body: JSON.stringify({ files: Object.values(described) })
      })
      return ((await response.json()) as { uploads: Array<{ url: string }> }).uploads[0].url
    }

    const wrong = await ctx.send(new Request(await ticketed(), { method: 'PUT', body: bytesOf(100, 2) }))
    expect(await error(wrong)).toEqual([422, 'hash-mismatch'])
    const longer = await ctx.send(new Request(await ticketed(), { method: 'PUT', body: bytesOf(101, 1) }))
    expect(await error(longer)).toEqual([422, 'size-mismatch'])
    const url = await ticketed()
    const forged = await ctx.send(new Request(url.replace(/.$/, '0').replace(/\.\d+\.(\d+)\./, '.999.$1.'), { method: 'PUT', body: bytesOf(999, 1) }))
    expect(await error(forged)).toEqual([403, 'invalid-ticket'])
    expect((await putManifest(wallet, 'my-scene', described, null)).status).toBe(422)

    expect((await ctx.send(new Request(url, { method: 'PUT', body: bytesOf(100, 1) }))).status).toBe(201)
    expect(await error(await ctx.send(new Request(url, { method: 'PUT', body: bytesOf(100, 1) })))).toEqual([403, 'ticket-used'])
  })

  it('holds a wallet to a few uploads in flight', async () => {
    const ctx = setup({ uploadsPerWallet: 1 })
    const wallet = await ctx.wallet()
    const files = { a: bytesOf(10, 1), b: bytesOf(10, 2) }
    const described = await describeFiles(files)
    const response = await wallet.signedFetch(`${BASE}/projects/my-scene/uploads`, {
      method: 'POST',
      body: JSON.stringify({ files: Object.values(described) })
    })
    const [first, second] = ((await response.json()) as { uploads: Array<{ url: string; hash: string }> }).uploads
    let finish = () => {}
    let reading = () => {}
    const started = new Promise<void>((resolve) => (reading = resolve))
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(first.hash === described.a.hash ? files.a : files.b)
          controller.close()
        }
      },
      pull() {
        reading()
      }
    }, { highWaterMark: 0 })
    const pending = ctx.send(new Request(first.url, { method: 'PUT', body: slow, duplex: 'half' } as RequestInit))
    // the first upload holds the slot once its body is being read
    await started
    const blocked = await ctx.send(new Request(second.url, { method: 'PUT', body: files.b }))
    expect(await error(blocked)).toEqual([429, 'too-many-uploads'])
    finish()
    expect((await pending).status).toBe(201)
  })

  it('drops an upload whose body stalls and frees its slot', async () => {
    const ctx = setup({ uploadsPerWallet: 1, uploadTimeoutSeconds: 1 })
    const wallet = await ctx.wallet()
    const files = { a: bytesOf(10, 1), b: bytesOf(10, 2) }
    const described = await describeFiles(files)
    const response = await wallet.signedFetch(`${BASE}/projects/my-scene/uploads`, {
      method: 'POST',
      body: JSON.stringify({ files: Object.values(described) })
    })
    const uploads = ((await response.json()) as { uploads: Array<{ url: string; hash: string }> }).uploads
    const stalled = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1)) } })
    const late = await ctx.send(new Request(uploads[0].url, { method: 'PUT', body: stalled, duplex: 'half' } as RequestInit))
    expect(await error(late)).toEqual([408, 'upload-timeout'])
    const next = uploads[1]
    const body = next.hash === described.a.hash ? files.a : files.b
    expect((await ctx.send(new Request(next.url, { method: 'PUT', body }))).status).toBe(201)
  })

  it.each([
    '.env',
    'src/.env.local',
    'node_modules/pkg/index.js',
    '.git/config',
    '/etc/passwd',
    '../outside.ts',
    'src/../../outside.ts',
    'src\\index.ts',
    'src//index.ts'
  ])('refuses the path %s', async (bad) => {
    const ctx = setup()
    const wallet = await ctx.wallet()
    const { described } = await upload(wallet, ctx.send, 'my-scene', { 'a.ts': bytesOf(10, 1) })
    const response = await putManifest(wallet, 'my-scene', { [bad]: described['a.ts'] }, null)
    expect(await error(response)).toEqual([400, 'invalid-path'])
  })

  it('refuses a project id outside the contract', async () => {
    const ctx = setup()
    const wallet = await ctx.wallet()
    expect(await error(await wallet.signedFetch(`${BASE}/projects/My_Scene/manifest`))).toEqual([400, 'invalid-project-id'])
  })

  it('holds a wallet to its quota, at the upload request and again at the upload', async () => {
    const ctx = setup({ maxWalletBytes: 1000, maxFileBytes: 800 })
    const wallet = await ctx.wallet()
    const ask = async (files: Files) =>
      wallet.signedFetch(`${BASE}/projects/my-scene/uploads`, {
        method: 'POST',
        body: JSON.stringify({ files: Object.values(await describeFiles(files)) })
      })

    expect(await error(await ask({ a: bytesOf(600, 1), b: bytesOf(600, 2) }))).toEqual([413, 'quota-exceeded'])
    expect(await error(await ask({ a: bytesOf(801, 1) }))).toEqual([413, 'file-too-large'])

    // two requests that each fit, made before either upload lands
    const [first, second] = await Promise.all(
      [bytesOf(600, 1), bytesOf(600, 2)].map(async (bytes) => {
        const { uploads } = (await (await ask({ a: bytes })).json()) as { uploads: Array<{ url: string }> }
        return () => ctx.send(new Request(uploads[0].url, { method: 'PUT', body: bytes }))
      })
    )
    expect((await first()).status).toBe(201)
    expect(await error(await second())).toEqual([413, 'quota-exceeded'])
  })
})

describe('trash and history', () => {
  it('soft deletes, restores, and purges a project left in the trash for 30 days', async () => {
    const ctx = setup()
    const wallet = await ctx.wallet()
    await save(ctx, wallet, 'my-scene', { 'a.ts': bytesOf(10, 1) }, null)

    expect((await wallet.signedFetch(`${BASE}/projects/my-scene`, { method: 'DELETE' })).status).toBe(200)
    expect(await error(await wallet.signedFetch(`${BASE}/projects/my-scene/manifest`))).toEqual([404, 'deleted'])
    const listed = (await (await wallet.signedFetch(`${BASE}/projects`)).json()) as { projects: Array<{ deletedAt?: number }> }
    expect(listed.projects[0].deletedAt).toEqual(expect.any(Number))

    expect((await wallet.signedFetch(`${BASE}/projects/my-scene/restore`, { method: 'POST' })).status).toBe(200)
    expect((await wallet.signedFetch(`${BASE}/projects/my-scene/manifest`)).status).toBe(200)

    await wallet.signedFetch(`${BASE}/projects/my-scene`, { method: 'DELETE' })
    ctx.advance(29 * DAY)
    expect(await purge(ctx.env)).toMatchObject({ projects: 0, references: 0 })
    ctx.advance(2 * DAY)
    expect(await purge(ctx.env)).toMatchObject({ projects: 1, references: 1 })
    const later = await wallet.anotherDevice()
    expect((await later.signedFetch(`${BASE}/projects/my-scene/restore`, { method: 'POST' })).status).toBe(404)
    const after = (await (await later.signedFetch(`${BASE}/projects`)).json()) as { usage: { bytes: number } }
    expect(after.usage.bytes).toBe(0)
  })

  it('purges a bounded number of wallets per run and carries on where it stopped', async () => {
    const ctx = setup({ purgeWalletsPerRun: 1 })
    for (const wallet of [await ctx.wallet(), await ctx.wallet()]) {
      await save(ctx, wallet, 'my-scene', { 'a.ts': bytesOf(10, 1) }, null)
      await wallet.signedFetch(`${BASE}/projects/my-scene`, { method: 'DELETE' })
    }
    ctx.advance(31 * DAY)
    expect(await purge(ctx.env)).toMatchObject({ projects: 1, wallets: 1, done: false })
    expect(await purge(ctx.env)).toMatchObject({ projects: 1, wallets: 1, done: true })
  })

  it('keeps only the last versions of a manifest', async () => {
    const ctx = setup({ historyVersions: 2 })
    const wallet = await ctx.wallet()
    for (let version = 0; version < 4; version++) {
      await save(ctx, wallet, 'my-scene', { 'a.ts': bytesOf(10, version) }, version === 0 ? null : version)
    }
    const history = await ctx.env.store.list(`wallets/${wallet.address}/projects/my-scene/history/`)
    expect(history.map((key) => key.split('/').pop())).toEqual(['3.json', '4.json'])
  })
})

describe('personal prefab library', () => {
  async function savePrefab(ctx: ReturnType<typeof setup>, wallet: TestWallet, name: string, files: Files) {
    const described = await describeFiles(files)
    const asked = await wallet.signedFetch(`${BASE}/prefabs/${name}/uploads`, {
      method: 'POST',
      body: JSON.stringify({ files: Object.values(described) })
    })
    if (asked.status !== 200) return asked
    const { uploads } = (await asked.json()) as { uploads: Array<{ hash: string; url: string; method: string }> }
    for (const target of uploads) {
      const [path] = Object.entries(described).find(([, file]) => file.hash === target.hash) ?? []
      await ctx.send(new Request(target.url, { method: target.method, body: files[path!] }))
    }
    return wallet.signedFetch(`${BASE}/prefabs/${name}/manifest`, { method: 'PUT', body: JSON.stringify({ files: described }) })
  }
  const listed = async (wallet: TestWallet) =>
    ((await (await wallet.signedFetch(`${BASE}/prefabs`)).json()) as { prefabs: Array<{ name: string; files: Record<string, { hash: string }> }> }).prefabs

  it('answers no one who has not signed', async () => {
    const ctx = setup()
    for (const [method, path] of [['GET', '/prefabs'], ['PUT', '/prefabs/door/manifest'], ['DELETE', '/prefabs/door'], ['POST', '/prefabs/door/uploads']]) {
      expect(await error(await ctx.send(new Request(`${BASE}${path}`, { method, headers: { origin: ORIGIN } })))).toEqual([401, 'unsigned'])
    }
  })

  it("keeps one wallet's prefabs from another", async () => {
    const ctx = setup()
    const [alice, mallory] = [await ctx.wallet(), await ctx.wallet()]
    const files = { 'data.json': bytesOf(40, 1), 'door.glb': bytesOf(500, 2) }
    expect((await savePrefab(ctx, alice, 'door', files)).status).toBe(200)
    const { hash } = (await describeFiles(files))['door.glb']

    expect(await listed(mallory)).toEqual([])
    expect((await mallory.signedFetch(`${BASE}/prefabs/door/files/${hash}`)).status).toBe(404)
    expect((await mallory.signedFetch(`${BASE}/prefabs/door`, { method: 'DELETE' })).status).toBe(404)
    // nor can it name alice's blob in a prefab of its own
    const stolen = await mallory.signedFetch(`${BASE}/prefabs/door/manifest`, { method: 'PUT', body: JSON.stringify({ files: await describeFiles(files) }) })
    expect(await error(stolen)).toEqual([422, 'missing-blobs'])

    expect((await listed(alice)).map((prefab) => prefab.name)).toEqual(['door'])
    const blob = await (await alice.anotherDevice()).signedFetch(`${BASE}/prefabs/door/files/${hash}`)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(files['door.glb'])
  })

  it('saves a name once, and deletes it for good', async () => {
    const ctx = setup()
    const wallet = await ctx.wallet()
    expect((await savePrefab(ctx, wallet, 'door', { 'data.json': bytesOf(40, 1) })).status).toBe(200)
    expect(await error(await savePrefab(ctx, wallet, 'door', { 'data.json': bytesOf(40, 2) }))).toEqual([409, 'exists'])
    expect(await error(await wallet.signedFetch(`${BASE}/prefabs/Door!/manifest`, { method: 'PUT', body: '{}' }))).toEqual([400, 'invalid-prefab-name'])

    expect((await wallet.signedFetch(`${BASE}/prefabs/door`, { method: 'DELETE' })).status).toBe(200)
    expect(await listed(wallet)).toEqual([])
    expect((await savePrefab(ctx, wallet, 'door', { 'data.json': bytesOf(40, 2) })).status).toBe(200)
  })

  it('counts prefabs against the wallet quota and its prefab limit', async () => {
    const ctx = setup({ maxWalletBytes: 2500, maxPrefabs: 1 })
    const wallet = await ctx.wallet()
    await save(ctx, wallet, 'my-scene', { 'a.ts': bytesOf(1200, 1) }, null)
    expect(await error(await savePrefab(ctx, wallet, 'door', { 'door.glb': bytesOf(1500, 2) }))).toEqual([413, 'quota-exceeded'])

    expect((await savePrefab(ctx, wallet, 'door', { 'door.glb': bytesOf(300, 2) })).status).toBe(200)
    expect(await error(await savePrefab(ctx, wallet, 'chair', { 'data.json': bytesOf(10, 3) }))).toEqual([413, 'too-many-prefabs'])
    const usage = ((await (await wallet.signedFetch(`${BASE}/prefabs`)).json()) as { usage: { bytes: number } }).usage
    expect(usage.bytes).toBeGreaterThan(1500)
  })

  it("keeps a prefab's files through the purge until the prefab is deleted", async () => {
    const ctx = setup()
    const wallet = await ctx.wallet()
    const files = { 'door.glb': bytesOf(500, 2) }
    await savePrefab(ctx, wallet, 'door', files)
    const { hash } = (await describeFiles(files))['door.glb']
    ctx.advance(2 * DAY)
    expect(await purge(ctx.env)).toMatchObject({ references: 0 })
    expect((await wallet.signedFetch(`${BASE}/prefabs/door/files/${hash}`)).status).toBe(200)

    await wallet.signedFetch(`${BASE}/prefabs/door`, { method: 'DELETE' })
    expect(await purge(ctx.env)).toMatchObject({ references: 1 })
  })
})

describe('content hash', () => {
  it.each([0, 262_144, 262_145, 174 * 262_144 + 1])('matches @dcl/hashing for %d bytes', async (size) => {
    const bytes = bytesOf(size, 5)
    expect(await contentCid(bytes)).toBe(await hashV1(bytes))
  })
})
