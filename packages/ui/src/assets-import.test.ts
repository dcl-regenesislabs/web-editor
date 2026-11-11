import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEntities } from '@scene/inspector'
import { ensureContentMapped, importFiles, placeLocalSound } from './assets'
import { cmd } from './engine/cmd'

const saved = vi.hoisted((): string[] => [])
vi.mock('./engine/datalayer', () => ({
  dataLayerAvailable: () => true,
  dataLayerListFiles: async () => ['assets/images/brick.png'],
  dataLayerSaveFileBytes: async (path: string) => { saved.push(path) }
}))
vi.mock('./engine/cmd', () => ({ cmd: { sceneContent: vi.fn() } }))
vi.mock('./engine/bus', () => ({ sceneRpc: async () => null }))
vi.mock('@scene/inspector', () => ({ createEntities: vi.fn(async () => []) }))
vi.mock('@scene/state', () => ({ state: { snapshot: {} }, setSelected: () => {} }))
vi.mock('./panels/reveal', () => ({ revealInTree: () => {} }))
vi.mock('@scene/custom-components', () => ({ NAME_COMPONENT: 'core-schema::Name' }))

describe('making an imported file available to Bevy', () => {
  afterEach(() => { vi.useRealTimers(); vi.mocked(cmd.sceneContent).mockReset() })

  it('finishes with a saved-file error when the engine never answers', async () => {
    vi.useFakeTimers()
    vi.mocked(cmd.sceneContent).mockImplementation(() => new Promise<string[]>(() => {}))
    let outcome = 'pending'
    void ensureContentMapped('models/tree.glb').then(() => { outcome = 'mapped' }, (error: Error) => { outcome = error.message })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(outcome).toContain('saved')
    expect(outcome).toContain('models/tree.glb')
    expect(cmd.sceneContent).toHaveBeenCalledTimes(1)
  })

  it('retries a transient engine error and confirms the imported path', async () => {
    vi.useFakeTimers()
    vi.mocked(cmd.sceneContent).mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce([]).mockResolvedValueOnce(['Models/Tree.glb'])
    const pending = ensureContentMapped('models/tree.glb')
    await vi.advanceTimersByTimeAsync(500)
    await expect(pending).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not report success when the engine never lists the saved file', async () => {
    vi.useFakeTimers()
    vi.mocked(cmd.sceneContent).mockResolvedValue([])
    const result = ensureContentMapped('models/tree.glb').then(() => 'mapped', (error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await result).toContain('saved')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('importing files', () => {
  it('adds images, sounds, videos and data files without a model, never over an existing file, and says what it left out', async () => {
    const big = new File([new Uint8Array(1)], 'huge.png')
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 })
    const result = await importFiles(
      [new File(['x'], 'Brick.png'), new File(['{}'], 'manifest.json'), new File(['x'], 'Door Creak.mp3'), new File(['x'], 'intro.mp4'), new File(['x'], 'song.flac'), big],
      { x: 8, y: 0, z: 8 }
    )

    expect(result.placed).toBeNull()
    const added = ['assets/images/brick-2.png', 'assets/data/manifest.json', 'assets/audio/door-creak.mp3', 'assets/video/intro.mp4']
    expect(result.added).toEqual(added)
    expect(saved).toEqual(added)
    expect(result.skipped).toEqual(['huge.png (over 50 MB, which Worlds refuse)', 'song.flac (not a model, image, sound, video or data file)'])
    expect(createEntities).not.toHaveBeenCalled()
  })
})

describe('placing a sound', () => {
  it('adds an entity whose AudioSource plays the file, looping, so it counts as used', async () => {
    vi.mocked(createEntities).mockClear()
    await placeLocalSound('assets/audio/lobby-drift.mp3', 'lobby-drift', { x: 8, y: 1, z: 8 })
    const [entity] = vi.mocked(createEntities).mock.calls[0][0]
    expect(entity).toMatchObject({
      Transform: { position: { x: 8, y: 1, z: 8 } },
      AudioSource: { audioClipUrl: 'assets/audio/lobby-drift.mp3', playing: true, loop: true }
    })
    expect(entity).not.toHaveProperty('GltfContainer')
  })
})
