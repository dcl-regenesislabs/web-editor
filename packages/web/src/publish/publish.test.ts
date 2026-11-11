import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import { hashV1 } from '@dcl/hashing'
import type { AuthChain } from '@ui/engine/hosted'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type FakeWorlds, createFakeWorlds } from '../../validate/fake-worlds-server.mjs'
import { buildDeployment } from './entity'
import { PublishError, refusal } from './errors'
import { createPublisher } from './publish'
import { type PoolClient, type SharedLease, placeInZone } from './shared'
import { uploadDeployment } from './upload'

const SERVER = 'http://worlds.test'
const WORLD = 'fixture.dcl.eth'
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

const sceneJson = {
  ecs7: true,
  runtimeVersion: '7',
  display: { title: 'Fixture', navmapThumbnail: 'images/Thumb.png' },
  main: 'bin/index.js',
  scene: { parcels: ['0,0', '1,0'], base: '0,0' },
  worldConfiguration: { name: WORLD }
}

const project = (): Map<string, Uint8Array> =>
  new Map([
    ['scene.json', text(JSON.stringify(sceneJson, null, 2))],
    ['.dclignore', text('drafts\n*.psd\n')],
    ['src/index.ts', text('export function main() {}')],
    ['package.json', text('{"dependencies":{"color":"^4.0.0"}}')],
    ['dcl-editor.lock.json', text('{"lockfileVersion":1}')],
    ['tsconfig.json', text('{}')],
    ['README.md', text('# notes')],
    ['drafts/idea.glb', text('not ready')],
    ['images/layers.psd', text('layers')],
    ['images/Thumb.png', text('png')],
    ['assets/scene/main.composite', text('{"components":[]}')],
    // over 256 KiB: the hash is a tree's root, not one block's
    ['models/big.glb', new Uint8Array(300_000).fill(7)]
  ])
const outputs = (): Map<string, Uint8Array> => new Map([['bin/index.js', text('console.log(1)')], ['main.crdt', new Uint8Array([1, 2, 3])]])

// what a host's signDeployment answers: the identity's chain, ending in the signed entity id
async function signer(): Promise<{ address: string; sign: (entityId: string) => AuthChain }> {
  const wallet = createUnsafeIdentity()
  const identity = await Authenticator.initializeAuthChain(wallet.address, createUnsafeIdentity(), 10, async (message) =>
    Authenticator.createSignature(wallet, message)
  )
  const sign = (entityId: string): AuthChain =>
    Authenticator.signPayload(identity, entityId).map((link) => ({ type: link.type, payload: link.payload, signature: link.signature ?? '' }))
  return { address: wallet.address, sign }
}

function serveWith(fake: FakeWorlds, first?: (url: string) => Response | undefined): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => first?.(url) ?? fake.handle(new Request(url, init)))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('publishing to a world', () => {
  it('builds the entity the Worlds server would: the files the ignore rules leave, named by their content hashes', async () => {
    const deployment = await buildDeployment({ files: project(), outputs: outputs(), world: WORLD, sdkVersion: '7.25.1', timestamp: 1790000000000 })
    const all = new Map([...project(), ...outputs()])
    const deployed = ['assets/scene/main.composite', 'bin/index.js', 'images/Thumb.png', 'main.crdt', 'models/big.glb', 'scene.json']
    const content = await Promise.all(deployed.map(async (file) => ({ file, hash: await hashV1(all.get(file)!) })))

    expect(deployment.entity.content).toEqual(content)
    expect(content.find((item) => item.file === 'models/big.glb')?.hash).toMatch(/^bafybei/)
    const entityFile = deployment.files.get(deployment.entityId)!
    expect(await hashV1(entityFile)).toBe(deployment.entityId)
    // byte for byte what dcl-catalyst-client's DeploymentBuilder writes
    expect(new TextDecoder().decode(entityFile)).toBe(
      JSON.stringify({
        version: 'v3',
        type: 'scene',
        pointers: ['0,0', '1,0'],
        timestamp: 1790000000000,
        content,
        metadata: { sdkVersion: '7.25.1', ...sceneJson }
      })
    )
    expect([...deployment.files.keys()].sort()).toEqual([deployment.entityId, ...content.map((item) => item.hash)].sort())
    expect([deployment.fileCount, deployment.bytes]).toEqual([6, deployed.reduce((sum, file) => sum + all.get(file)!.length, 0)])
  })

  it('is refused before signing past the 10,000 files a World takes', async () => {
    const files = project()
    // with the 6 the fixture deploys, all a World takes
    for (let i = 0; i < 9994; i++) files.set(`assets/data/${i}.txt`, text(String(i)))
    const build = () => buildDeployment({ files, outputs: outputs(), world: WORLD, sdkVersion: '7.25.1', timestamp: 1790000000000 })
    await expect(build()).resolves.toMatchObject({ fileCount: 10_000 })
    files.set('assets/data/one-more.txt', text('one more'))
    await expect(build()).rejects.toMatchObject({ reason: 'invalid-scene', message: expect.stringContaining('10,001 files') })
  })

  it('is accepted when signed by a wallet that may deploy there, served as a world, and refused in words for any other wallet', async () => {
    const owner = await signer()
    const stranger = await signer()
    const fake = createFakeWorlds({ worlds: { [WORLD]: { owner: owner.address } } })
    serveWith(fake)
    const deployment = await buildDeployment({ files: project(), outputs: outputs(), world: WORLD, sdkVersion: '7.25.1', timestamp: Date.now() })

    const refused = uploadDeployment({ server: SERVER, world: WORLD, deployment, authChain: stranger.sign(deployment.entityId) })
    await expect(refused).rejects.toMatchObject({ reason: 'permission', retryable: false, message: expect.stringContaining(`can't publish to ${WORLD}`) })
    expect(fake.log.filter((line) => line.startsWith('POST /entities'))).toEqual(['POST /entities 400'])

    const said = await uploadDeployment({ server: SERVER, world: WORLD, deployment, authChain: owner.sign(deployment.entityId) })
    expect(said).toContain(`deployed to World "${WORLD}"`)
    const about = (await (await fetch(`${SERVER}/world/${WORLD}/about`)).json()) as { configurations: { scenesUrn: string[] } }
    expect(about.configurations.scenesUrn).toEqual([`urn:decentraland:entity:${deployment.entityId}?=&baseUrl=${SERVER}/contents/`])
    const bundle = deployment.entity.content.find((item) => item.file === 'bin/index.js')!
    expect(new Uint8Array(await (await fetch(`${SERVER}/contents/${bundle.hash}`)).arrayBuffer())).toEqual(outputs().get('bin/index.js'))
  })

  it('links the published scene at its own parcel, since a world holds several', async () => {
    const owner = await signer()
    serveWith(createFakeWorlds({ worlds: { [WORLD]: { owner: owner.address } } }))
    const host = {
      services: { worldsContent: SERVER },
      pageDir: 'https://decentraland.zone/bevy-web/',
      identity: () => ({ address: owner.address, isGuest: false }),
      signDeployment: async ({ entityId }: { entityId: string }) => owner.sign(entityId)
    } as unknown as Parameters<typeof createPublisher>[0]['host']
    const publisher = createPublisher({
      host,
      setWorld: async () => {},
      files: async () => project(),
      build: async () => ({ ok: true, outputs: outputs(), diagnostics: [], events: [], sdkVersion: '7.25.1' }) as unknown as Awaited<ReturnType<Parameters<typeof createPublisher>[0]['build']>>,
      published: async () => {}
    })
    const result = await publisher.publish('p1', WORLD, () => {})
    expect(result.ok && result.published.url).toBe(`https://decentraland.zone/bevy-web/?realm=${encodeURIComponent(`${SERVER}/world/${WORLD}`)}&position=0%2C0`)
  })

  it('tries again when the server is down, and not when it refuses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const owner = await signer()
    const fake = createFakeWorlds({ worlds: { [WORLD]: { owner: owner.address } } })
    let down = 2
    serveWith(fake, (url) => (url.endsWith('/entities') && down-- > 0 ? new Response('upstream', { status: 503 }) : undefined))
    const deployment = await buildDeployment({ files: project(), outputs: outputs(), world: WORLD, sdkVersion: '7.25.1', timestamp: Date.now() })
    const retries: number[] = []

    const upload = uploadDeployment({
      server: SERVER,
      world: WORLD,
      deployment,
      authChain: owner.sign(deployment.entityId),
      onRetry: (attempt) => retries.push(attempt)
    })
    await vi.runAllTimersAsync()
    await upload
    expect(retries).toEqual([2, 3])
    expect(fake.entities(WORLD).map((entity) => entity.id)).toEqual([deployment.entityId])
  })

  it('says what the server refused in words', () => {
    const cases: [number, string, PublishError['reason'], boolean][] = [
      [400, 'Deployment failed: The deployment is too big. The maximum total size allowed is 104857600 bytes for scenes. You can upload up to 104857600 bytes but you tried to upload 209715200.', 'too-large', false],
      [400, 'Deployment failed: Max allowed scene dimensions is 4 parcels.', 'too-large', false],
      [400, 'Deployment failed: Deployment was created 420.5 secs ago. Max allowed: 300 secs.', 'expired', true],
      [400, "Deployment failed: Scene thumbnail 'a.png' must be a file included in the deployment.", 'invalid-scene', false],
      [400, 'Deployment failed: scene.json needs to specify a worldConfiguration section with a valid name inside.', 'invalid-scene', false],
      [409, 'The world changed during the deployment', 'changed', true],
      [503, 'busy', 'busy', true]
    ]
    for (const [status, message, reason, retryable] of cases) {
      const error = refusal(status, JSON.stringify({ error: 'Bad request', message }), WORLD)
      expect([message, error.reason, error.retryable]).toEqual([message, reason, retryable])
    }
    expect(refusal(400, JSON.stringify({ message: cases[0][1] }), WORLD).message).toBe(
      `This scene is 200 MB and ${WORLD} has room for 100 MB. Remove or shrink files (models, textures, sounds), or free space in your other worlds.`
    )
  })
})

describe('publishing to a shared world', () => {
  const POOL_WORLD = 'pool.dcl.eth'
  const lease: SharedLease = { world: POOL_WORLD, zone: { x: -150, y: -140, size: 10 }, maxSceneBytes: 50 * 1024 * 1024, worldConfiguration: { name: POOL_WORLD, skyboxConfig: { fixedTime: 0 } } }

  it('moves the published copy of the scene into the lent zone, as one block, under the pool\'s world settings', () => {
    const scene = { ...sceneJson, scene: { parcels: ['3,4', '4,4', '4,5'], base: '4,4' } }
    const placed = JSON.parse(new TextDecoder().decode(placeInZone(text(JSON.stringify(scene)), lease))) as typeof sceneJson
    expect(placed.scene).toEqual({ parcels: ['-150,-140', '-149,-140', '-149,-139'], base: '-149,-140' })
    expect(placed.worldConfiguration).toEqual(lease.worldConfiguration)
    expect(placed.display).toEqual(sceneJson.display)
  })

  it('refuses a scene wider than the zone before anything is signed', () => {
    const scene = { ...sceneJson, scene: { parcels: ['0,0', '10,0'], base: '0,0' } }
    expect(() => placeInZone(text(JSON.stringify(scene)), lease)).toThrow(/fits in 10×10 parcels, and this one spans 11×1/)
  })

  it('has the pool sign the entity, uploads it as any publish, and tells the pool it landed', async () => {
    const pool = await signer()
    const creator = await signer()
    serveWith(createFakeWorlds({ worlds: { [POOL_WORLD]: { owner: '0x1111111111111111111111111111111111111111', deployers: [pool.address] } } }))
    const signed: Array<{ entity: string; bytes: number }> = []
    const landed: string[] = []
    const client: PoolClient = {
      lease: async () => lease,
      sign: async (entity, bytes) => {
        signed.push({ entity, bytes })
        return pool.sign(await hashV1(text(entity)))
      },
      published: async (entityId) => void landed.push(entityId)
    }
    const host = {
      services: { worldsContent: SERVER, projects: null },
      pageDir: 'https://decentraland.zone/bevy-web/',
      identity: () => ({ address: creator.address, isGuest: false }),
      signDeployment: async () => { throw new Error('the creator signs nothing') }
    } as unknown as Parameters<typeof createPublisher>[0]['host']
    let setWorld = 0
    const publisher = createPublisher({
      host,
      pool: client,
      setWorld: async () => void setWorld++,
      files: async () => project(),
      build: async () => ({ ok: true, outputs: outputs(), diagnostics: [], events: [], sdkVersion: '7.25.1' }) as unknown as Awaited<ReturnType<Parameters<typeof createPublisher>[0]['build']>>,
      published: async () => {}
    })
    const result = await publisher.publishShared!('p1', () => {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.published.world).toBe(POOL_WORLD)
    expect(result.published.url).toContain('&position=-150%2C-140')
    const entity = JSON.parse(signed[0].entity) as { pointers: string[]; metadata: { worldConfiguration: unknown } }
    expect(entity.pointers).toEqual(['-150,-140', '-149,-140'])
    expect(entity.metadata.worldConfiguration).toEqual(lease.worldConfiguration)
    expect(signed[0].bytes).toBe(result.published.bytes)
    expect(landed).toEqual([result.published.entityId])
    // the project keeps its own parcels and world
    expect(setWorld).toBe(0)
  })
})
