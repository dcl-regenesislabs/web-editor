import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contentCid } from '@dcl-editor/contract/cid'
import { memoryProfile } from '../store/memory-backend'
import { ProjectStore } from '../store/project-store'
import { type SignedFetch, createProjectsApi } from './api'
import { PUSH_DEBOUNCE_MS, RETRY_BASE_MS, type SyncEngine, createSyncEngine } from './engine'
import { type FakeService, createFakeService } from './fake-service'

const BASE = 'https://projects.test/v1'
const WALLET = '0x' + 'a'.repeat(40)

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

function bytesOf(body: BodyInit | null | undefined): Uint8Array | undefined {
  if (typeof body === 'string') return text(body)
  return body instanceof Uint8Array ? body : undefined
}

// One browser: its own store, talking to the shared service as `wallet` (null: a guest).
function device(service: FakeService, signer: string | null = WALLET, store = new ProjectStore(memoryProfile())) {
  const net = { down: false, requests: 0 }
  const who = { wallet: signer }
  const send = async (signer: string | null, url: string, init?: Parameters<SignedFetch>[1]): Promise<Response> => {
    net.requests++
    if (net.down) throw new TypeError('Failed to fetch')
    const answer = await service.handle({
      method: init?.method ?? 'GET',
      path: url.slice(BASE.length),
      wallet: signer,
      body: bytesOf(init?.body)
    })
    return new Response((answer.bytes as Uint8Array<ArrayBuffer> | undefined) ?? JSON.stringify(answer.json), { status: answer.status })
  }
  const api = createProjectsApi(
    BASE,
    (url, init) => (who.wallet === null ? Promise.reject(new Error('not-signed-in')) : send(who.wallet, url, init)),
    (url, init) => send(null, String(url), { method: init?.method, body: init?.body })
  )
  const engine = createSyncEngine({
    store,
    session: () => (who.wallet === null ? null : { api, wallet: who.wallet }),
    account: () => (who.wallet === null ? 'guest' : 'on'),
    hash: contentCid,
    title: async (id) => id,
    duplicate: async (id) => (await store.duplicate(id, `${id} copy`)).id
  })
  const edit = async (id: string, path: string, value: string): Promise<void> => {
    await store.write(id, path, text(value))
    engine.touched(id, path)
  }
  const read = async (id: string, path: string): Promise<string> => new TextDecoder().decode(await store.read(id, path))
  return { store, engine, net, who, edit, read }
}

async function after(ms: number, ...engines: SyncEngine[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (const engine of engines) await engine.idle()
}

// A project made on `a`, copied to the account, and opened on `b`.
async function shared(a: ReturnType<typeof device>, b: ReturnType<typeof device>): Promise<string> {
  const { id } = await a.store.create('Scene', [
    ['scene.json', text('{}')],
    ['src/index.ts', text('v1')]
  ])
  await a.engine.refresh(true)
  await after(0, a.engine)
  await b.engine.refresh(true)
  await b.engine.prepareOpen(id)
  return id
}

describe('project sync', () => {
  let service: FakeService
  beforeEach(() => {
    vi.useFakeTimers()
    service = createFakeService({ hash: contentCid, baseUrl: BASE })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores the content before the manifest, and afterwards only what changed', async () => {
    const a = device(service)
    const { id } = await a.store.create('Scene', [
      ['scene.json', text('{}')],
      ['src/index.ts', text('v1')]
    ])
    await a.engine.refresh(true)
    await after(0, a.engine)
    expect(service.log).toEqual([
      'GET /projects 200',
      `POST /projects/${id}/uploads 200`,
      `PUT /uploads/${await contentCid(text('{}'))} 201`,
      `PUT /uploads/${await contentCid(text('v1'))} 201`,
      `PUT /projects/${id}/manifest 200`
    ])
    expect(a.engine.status().projects[id].state).toBe('synced')

    service.log.length = 0
    await a.edit(id, 'src/index.ts', 'v2')
    await after(PUSH_DEBOUNCE_MS - 1, a.engine)
    expect(service.log).toEqual([])
    await after(1, a.engine)
    expect(service.log).toEqual([
      `POST /projects/${id}/uploads 200`,
      `PUT /uploads/${await contentCid(text('v2'))} 201`,
      `PUT /projects/${id}/manifest 200`
    ])
  })

  it('a list asked while the first upload is still landing does not make it a conflict', async () => {
    let land = (): void => {}
    const landed = new Promise<void>((resolve) => (land = resolve))
    const slow: FakeService = {
      log: service.log,
      handle: async (request) => {
        if (request.method === 'PUT' && request.path.endsWith('/manifest')) await landed
        return service.handle(request)
      }
    }
    const a = device(slow)
    const { id } = await a.store.create('Scene', [['src/index.ts', text('v1')]])
    await a.engine.refresh(true)
    await vi.advanceTimersByTimeAsync(0)
    // the home asks again while the manifest is in flight: the account has nothing yet
    const listing = a.engine.refresh(true)
    await vi.advanceTimersByTimeAsync(0)
    land()
    await listing
    await after(PUSH_DEBOUNCE_MS, a.engine)
    expect(service.log.filter((line) => line.includes('/manifest'))).toEqual([`PUT /projects/${id}/manifest 200`])
    expect(a.engine.status().projects[id].state).toBe('synced')
  })

  it('a push the service took whose answer was lost is not a conflict when the scene opens again', async () => {
    let loseNext = false
    const lossy: FakeService = {
      log: service.log,
      handle: async (request) => {
        const answer = await service.handle(request)
        if (loseNext && request.method === 'PUT' && request.path.endsWith('/manifest')) {
          loseNext = false
          throw new TypeError('Failed to fetch')
        }
        return answer
      }
    }
    const a = device(lossy)
    const { id } = await a.store.create('Scene', [['src/index.ts', text('v1')]])
    await a.engine.refresh(true)
    await after(0, a.engine)
    loseNext = true
    await a.edit(id, 'src/index.ts', 'v2')
    await after(PUSH_DEBOUNCE_MS, a.engine)
    await a.engine.prepareOpen(id)
    expect(a.engine.status().projects[id].state).toBe('synced')
  })

  it('on a shared browser, another wallet’s edits and trash never reach the account that synced the scene', async () => {
    const a = device(service)
    const { id } = await a.store.create('Scene', [['src/index.ts', text('v1')]])
    await a.engine.refresh(true)
    await after(0, a.engine)
    const b = device(service, '0x' + 'b'.repeat(40), a.store)
    await b.engine.refresh(true)
    expect(b.engine.status().projects[id]).toEqual({ state: 'local', otherAccount: true })
    service.log.length = 0
    const aSignsIn = async (): Promise<void> => {
      await a.engine.refresh(true)
      await after(PUSH_DEBOUNCE_MS, a.engine)
    }
    await b.edit(id, 'src/index.ts', 'edited by b')
    await after(PUSH_DEBOUNCE_MS, b.engine)
    await aSignsIn()
    await b.store.trash(id)
    b.engine.trashed(id)
    await after(0, b.engine)
    await aSignsIn()
    expect(service.log).toEqual(['GET /projects 200', 'GET /projects 200'])
  })

  it('edits made while signed out are not pushed when the wallet signs back in', async () => {
    const a = device(service)
    const { id } = await a.store.create('Scene', [['src/index.ts', text('v1')]])
    await a.engine.refresh(true)
    await after(0, a.engine)
    const signedOut = device(service, null, a.store)
    await signedOut.engine.refresh(true)
    await signedOut.edit(id, 'src/index.ts', 'edited while signed out')
    await after(PUSH_DEBOUNCE_MS, signedOut.engine)
    service.log.length = 0
    const again = device(service, WALLET, a.store)
    await again.engine.refresh(true)
    await after(PUSH_DEBOUNCE_MS, again.engine)
    expect(service.log).toEqual(['GET /projects 200'])
  })

  it('says the scenes are loading until the account’s list has been read, not that they are synced', async () => {
    const a = device(service)
    const { id } = await a.store.create('Scene', [['src/index.ts', text('v1')]])
    await a.engine.refresh(true)
    await after(0, a.engine)

    const b = device(service)
    expect(b.engine.status()).toMatchObject({ loading: true, state: 'synced' })
    expect(b.engine.remoteOnly()).toEqual([])
    await b.engine.refresh(true)
    expect(b.engine.status().loading).toBeUndefined()
    expect(b.engine.remoteOnly().map((project) => project.id)).toEqual([id])

    const offline = device(service)
    offline.net.down = true
    await offline.engine.refresh(true)
    expect(offline.engine.status()).toMatchObject({ state: 'offline' })
    expect(offline.engine.status().loading).toBeUndefined()

    expect(device(service, null).engine.status().loading).toBeUndefined()
  })

  it('says the scenes are loading again after signing out and back in as the same account', async () => {
    const a = device(service)
    const { id } = await a.store.create('Scene', [['src/index.ts', text('v1')]])
    await a.engine.refresh(true)
    await after(0, a.engine)

    const b = device(service)
    await b.engine.refresh(true)
    expect(b.engine.remoteOnly().map((project) => project.id)).toEqual([id])

    b.who.wallet = null
    await b.engine.refresh(true)
    expect(b.engine.remoteOnly()).toEqual([])

    b.who.wallet = WALLET
    expect(b.engine.status().loading).toBe(true)
    await b.engine.refresh(true)
    expect(b.engine.status().loading).toBeUndefined()
    expect(b.engine.remoteOnly().map((project) => project.id)).toEqual([id])
  })

  it('a second device lists the project, downloads it, and follows when the first moves on', async () => {
    const a = device(service)
    const b = device(service)
    const { id } = await a.store.create('Scene', [['src/index.ts', text('v1')]])
    await a.engine.refresh(true)
    await after(0, a.engine)

    await b.engine.refresh(true)
    expect(b.engine.remoteOnly().map((project) => project.id)).toEqual([id])
    await b.engine.prepareOpen(id)
    expect(await b.read(id, 'src/index.ts')).toBe('v1')

    await a.edit(id, 'src/index.ts', 'v2')
    await a.edit(id, 'assets/new.txt', 'new')
    await a.store.remove(id, 'src/index.ts')
    a.engine.touched(id, 'src/index.ts')
    await after(PUSH_DEBOUNCE_MS, a.engine)

    await b.engine.prepareOpen(id)
    expect(await b.store.paths(id)).toEqual(['assets/new.txt'])
    expect(b.engine.status().projects[id].state).toBe('synced')
  })

  it('when both devices changed a project nothing is merged or lost, and the creator decides', async () => {
    const a = device(service)
    const b = device(service)
    const id = await shared(a, b)

    await a.edit(id, 'src/index.ts', 'from a')
    await after(PUSH_DEBOUNCE_MS, a.engine)
    await b.edit(id, 'src/index.ts', 'from b')
    await after(PUSH_DEBOUNCE_MS, b.engine)
    expect(b.engine.status().projects[id]).toEqual({ state: 'conflict' })
    expect(b.engine.status().state).toBe('conflict')
    expect(await b.read(id, 'src/index.ts')).toBe('from b')

    // keep both: this device's version becomes a new scene, the scene takes the other one
    await b.engine.resolve(id, 'keep-both')
    await after(0, b.engine)
    const copy = (await b.store.list()).map((project) => project.id).find((other) => other !== id) as string
    expect(await b.read(copy, 'src/index.ts')).toBe('from b')
    expect(await b.read(id, 'src/index.ts')).toBe('from a')
    expect(b.engine.status().projects[id].state).toBe('synced')
    await a.engine.refresh(true)
    expect(a.engine.remoteOnly().map((project) => project.id)).toEqual([copy])

    // keep this device's: the account takes it, and the other device follows
    await a.edit(id, 'src/index.ts', 'a again')
    await after(PUSH_DEBOUNCE_MS, a.engine)
    await b.edit(id, 'src/index.ts', 'b again')
    await after(PUSH_DEBOUNCE_MS, b.engine)
    expect(b.engine.status().projects[id].state).toBe('conflict')
    await b.engine.resolve(id, 'keep-local')
    await a.engine.prepareOpen(id)
    expect(await a.read(id, 'src/index.ts')).toBe('b again')
  })

  it('a scene that only shares its id with one on the account is told apart from a changed one', async () => {
    const a = device(service)
    const b = device(service)
    await a.store.create('My scene', [['scene.json', text('{"from":"a"}')]], { id: 'my-scene' })
    await a.engine.refresh(true)
    await after(0, a.engine)
    await b.store.create('My scene', [['scene.json', text('{"from":"b"}')]], { id: 'my-scene' })
    await b.engine.refresh(true)
    expect(b.engine.status().projects['my-scene']).toEqual({ state: 'conflict', unrelated: true })
    expect(await b.read('my-scene', 'scene.json')).toBe('{"from":"b"}')
  })

  it('offline, a change is kept and retried with a growing delay until it goes through', async () => {
    const a = device(service)
    const id = await shared(a, device(service))
    a.net.down = true
    a.net.requests = 0
    await a.edit(id, 'src/index.ts', 'offline edit')
    await after(PUSH_DEBOUNCE_MS, a.engine)
    expect(a.net.requests).toBe(1)
    expect(a.engine.status().projects[id].state).toBe('offline')

    await after(RETRY_BASE_MS - 1, a.engine)
    expect(a.net.requests).toBe(1)
    await after(1, a.engine)
    expect(a.net.requests).toBe(2)
    await after(RETRY_BASE_MS * 2 - 1, a.engine)
    expect(a.net.requests).toBe(2)

    a.net.down = false
    await after(1, a.engine)
    expect(a.engine.status().projects[id].state).toBe('synced')
    expect(a.engine.status().state).toBe('synced')
  })

  it('a guest’s projects stay on the device: no request is made', async () => {
    const guest = device(service, null)
    const { id } = await guest.store.create('Scene', [['scene.json', text('{}')]])
    await guest.engine.refresh(true)
    await guest.edit(id, 'scene.json', '{"a":1}')
    await after(60_000, guest.engine)
    expect(guest.net.requests).toBe(0)
    expect(service.log).toEqual([])
    expect(guest.engine.status()).toMatchObject({ account: 'guest', state: 'local', projects: { [id]: { state: 'local' } } })
  })

  it('the trash and a restore reach the account and the other device', async () => {
    const a = device(service)
    const b = device(service)
    const id = await shared(a, b)

    await a.store.trash(id)
    a.engine.trashed(id)
    await a.engine.idle()
    await b.engine.refresh(true)
    expect((await b.store.trashed()).map((project) => project.id)).toEqual([id])

    await a.store.restore(id)
    a.engine.restored(id)
    await a.engine.idle()
    await b.engine.refresh(true)
    expect((await b.store.list()).map((project) => project.id)).toEqual([id])
  })

  it('what the service refuses is shown in words, and the project stays as it is', async () => {
    service = createFakeService({ hash: contentCid, baseUrl: BASE, quotaBytes: 4 })
    const a = device(service)
    const { id } = await a.store.create('Scene', [['src/index.ts', text('too large')]])
    await a.engine.refresh(true)
    await after(0, a.engine)
    const { state, message } = a.engine.status().projects[id]
    expect(state).toBe('error')
    expect(message).toMatch(/storage is full/)
    expect(await a.read(id, 'src/index.ts')).toBe('too large')
  })
})
