import { describe, expect, it } from 'vitest'
import { memoryProfile } from '../store/memory-backend'
import { ProjectStore } from '../store/project-store'
import type { SignedFetch } from '../sync/api'
import { createSharing, shareLink, sharedToken } from './share'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz234567'
const BASE = 'https://projects.test'
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })

// the service's answers for one shared project, and what the shell asked of it
function service(shared: boolean) {
  const calls: string[] = []
  const blobs: Record<string, string> = { h1: '{"display":{"title":"Shared"}}', h2: 'export function main() {}' }
  const signedFetch: SignedFetch = async (url, init) => {
    const path = url.slice(BASE.length)
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/projects/mine/share') {
      if (init?.method === 'DELETE') return json(200, { id: 'mine' })
      if (init?.method === 'PUT') return json(200, { token: TOKEN, createdAt: 1 })
      return shared ? json(200, { token: TOKEN, createdAt: 1 }) : json(404, { error: 'not-shared' })
    }
    if (path === '/projects/unsynced/share') return json(404, { error: 'not-found' })
    if (!shared) return json(404, { error: 'not-found' })
    if (path === `/shared/${TOKEN}`) {
      return json(200, { name: 'Shared scene', version: 3, updatedAt: 1, bytes: 10, files: { 'scene.json': { hash: 'h1', size: 1 }, 'src/index.ts': { hash: 'h2', size: 1 } } })
    }
    const file = /^\/shared\/[a-z2-7]+\/files\/(\w+)$/.exec(path)
    if (file !== null) return new Response(blobs[file[1]])
    return json(404, { error: 'not-found' })
  }
  return { calls, signedFetch }
}

function sharing(shared: boolean, wallet: string | null = '0xabc') {
  const store = new ProjectStore(memoryProfile())
  const touched: string[] = []
  const flushed: Array<string | undefined> = []
  const fake = service(shared)
  const parts = createSharing({
    base: BASE,
    signedFetch: fake.signedFetch,
    store,
    sync: { flush: async (id) => void flushed.push(id), remoteIds: () => [], touched: (id) => void touched.push(id) },
    wallet: () => wallet,
    install: async () => {},
    page: () => 'https://decentraland.zone/bevy-web/?baseDomain=decentraland.org&position=1,2&editor=my-scene'
  })
  return { ...parts, store, touched, flushed, calls: fake.calls }
}

describe('a share link', () => {
  it('opens this page on the copy, keeping only the environment and the service', () => {
    expect(shareLink(TOKEN, 'https://decentraland.zone/bevy-web/?baseDomain=decentraland.org&position=1,2&editor=x')).toBe(
      `https://decentraland.zone/bevy-web/?baseDomain=decentraland.org&editor=copy-${TOKEN}`
    )
    expect(shareLink(TOKEN, 'http://localhost:5173/?editor&editor-projects=http://localhost:8887')).toBe(
      `http://localhost:5173/?editor-projects=http%3A%2F%2Flocalhost%3A8887&editor=copy-${TOKEN}`
    )
    expect(shareLink(TOKEN, 'https://decentraland.org/play/?editor=x&editor-features=experimental,advanced&position=1,2')).toBe(
      `https://decentraland.org/play/?editor-features=experimental%2Cadvanced&editor=copy-${TOKEN}`
    )
  })

  it('rides on the explorer\'s ?editor=<projectId>, and no project id of the store reads as one', () => {
    // the explorer's own check (bevy-explorer react-web/src/features/editorHost/source.ts)
    expect(`copy-${TOKEN}`).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/)
    expect(sharedToken(`copy-${TOKEN}`)).toBe(TOKEN)
    expect(sharedToken('my-scene-ab12')).toBeNull()
    expect(sharedToken(`copy-${TOKEN}-ab12`)).toBeNull()
  })
})

describe('sharing a scene', () => {
  it('answers no link while the scene is not shared, and one once it is, after sending what was waiting', async () => {
    const s = sharing(false)
    expect(await s.shell.projectShareLink?.('mine')).toBeNull()
    const link = await s.shell.setProjectShared?.('mine', true)
    expect(link).toContain(`editor=copy-${TOKEN}`)
    expect(s.flushed).toEqual(['mine'])
    expect(await s.shell.setProjectShared?.('mine', false)).toBeNull()
    expect(s.calls).toEqual(['GET /projects/mine/share', 'PUT /projects/mine/share', 'DELETE /projects/mine/share'])
  })

  it('says why a scene the account does not hold yet cannot be shared', async () => {
    const s = sharing(false)
    await expect(s.shell.setProjectShared?.('unsynced', true)).rejects.toThrow(/not on your account yet/)
  })

  it('asks a guest to sign in, and asks the service nothing', async () => {
    const s = sharing(true, null)
    expect(await s.shell.projectShareLink?.('mine')).toBeNull()
    await expect(s.shell.setProjectShared?.('mine', true)).rejects.toThrow(/Sign in/)
    await expect(s.copyShared(TOKEN)).rejects.toThrow(/Sign in/)
    expect(s.calls).toEqual([])
  })
})

describe('copying a shared scene', () => {
  it('makes a new project of this account from the shared files, and sends it to the account', async () => {
    const s = sharing(true)
    const { id, created } = await s.copyShared(TOKEN)
    expect(created).toBe(true)
    expect(id).toMatch(/^shared-scene-/)
    expect(new TextDecoder().decode(await s.store.read(id, 'src/index.ts'))).toBe('export function main() {}')
    expect(await s.store.paths(id)).toEqual(['scene.json', 'src/index.ts'])
    expect(s.touched).toEqual([id])

    // the same link again, as a reload does: the copy already made
    expect(await s.copyShared(TOKEN)).toEqual({ id, created: false })
    expect(await s.store.list()).toHaveLength(1)
  })

  it('says the link no longer works when the owner stopped sharing', async () => {
    const s = sharing(false)
    await expect(s.copyShared(TOKEN)).rejects.toThrow(/no longer opens a scene/)
    expect(await s.store.list()).toEqual([])
  })
})
