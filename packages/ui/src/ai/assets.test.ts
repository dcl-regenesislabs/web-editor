import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssetRequests } from './assets'
import { state } from '@scene/state'

const { copy } = vi.hoisted(() => ({
  copy: vi.fn(async () => ({ folder: 'custom/game_flow', reused: false }))
}))
vi.mock('@scene/state', () => ({ state: { frozen: true } }))
vi.mock('../prefabs/library', () => ({
  listLibrary: async () => [{ ref: 'builtin:game-flow', scope: 'builtin', data: { id: 'flow', name: 'Game Flow', tags: ['round'], requiresSdk: 'auth-server' } }],
  copyLibraryPrefabIntoProject: copy
}))

function setup() {
  const files = new Map<string, Uint8Array>()
  const write = vi.fn(async (path: string, bytes: Uint8Array, expected: Uint8Array | null, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (expected !== null || files.has(path)) throw new Error('File changed.')
    files.set(path, bytes)
  })
  const run = createAssetRequests({ files: () => files })
  return { files, write, run: (request: Record<string, unknown>, signal = new AbortController().signal) => run(request, signal) }
}

afterEach(() => { vi.clearAllMocks(); state.frozen = true })

describe('assistant asset workflow', () => {
  it('discovers library behavior before copying it without placing an entity', async () => {
    const { run, files } = setup()
    expect(await run({ action: 'search_prefabs', query: 'round' })).toMatchObject({ total: 1, results: [{ ref: 'builtin:game-flow', requiresSdk: 'auth-server' }] })
    files.set('custom/game_flow/ai.md', new TextEncoder().encode('Guide'))
    expect(await run({ action: 'import_prefab', ref: 'builtin:game-flow' })).toMatchObject({ folder: 'custom/game_flow', guide: 'custom/game_flow/ai.md' })
    expect(copy).toHaveBeenCalledWith('builtin:game-flow')
    await expect(run({ action: 'import_prefab', ref: 'invented' })).rejects.toThrow('exact prefab ref')
  })

  it('allows searching in Play but refuses imports and non-model inspection paths', async () => {
    const { run } = setup()
    state.frozen = false
    await expect(run({ action: 'search_prefabs', query: 'round' })).resolves.toMatchObject({ total: 1 })
    await expect(run({ action: 'import_prefab', ref: 'builtin:game-flow' })).rejects.toThrow('Stop Play')
    for (const path of ['../model.glb', 'models/.hidden.glb', 'src/index.ts']) {
      await expect(run({ action: 'inspect_model', path })).rejects.toThrow('model path')
    }
  })
})
