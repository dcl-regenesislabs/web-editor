import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureContentMapped } from './assets'

const { sceneContent } = vi.hoisted(() => ({ sceneContent: vi.fn<() => Promise<string[]>>() }))
vi.mock('./engine/cmd', () => ({ cmd: { sceneContent } }))
vi.mock('./engine/datalayer', () => ({ dataLayerAvailable: () => true, dataLayerListFiles: async () => [], dataLayerSaveFileBytes: async () => {} }))
vi.mock('./engine/bus', () => ({ sceneRpc: async () => null }))
vi.mock('@scene/inspector', () => ({ createEntities: async () => [] }))
vi.mock('@scene/state', () => ({ state: { snapshot: {} }, setSelected: () => {} }))
vi.mock('./panels/reveal', () => ({ revealInTree: () => {} }))
vi.mock('@scene/custom-components', () => ({ NAME_COMPONENT: 'core-schema::Name' }))
vi.mock('./log', () => ({ log: { warn: () => {}, debug: () => {}, error: () => {} } }))

const SOUND = 'assets/audio/library/coin.mp3'

describe('mapping new content into the running scene', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sceneContent.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers as soon as the content map lists the file', async () => {
    sceneContent.mockResolvedValueOnce([]).mockResolvedValue(['Assets/Audio/Library/Coin.mp3'])
    const mapped = ensureContentMapped(SOUND)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(mapped).resolves.toBe(true)
  })

  it('gives up within its time budget when each refresh of the map is slow', async () => {
    // the preview refreshes the map before answering: seconds per poll on a slow one
    sceneContent.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 5_500)))
    let settled: boolean | null = null
    void ensureContentMapped(SOUND).then((mapped) => { settled = mapped })
    await vi.advanceTimersByTimeAsync(11_000)
    expect(settled).toBe(false)
  })

  it('gives up when the engine never answers', async () => {
    sceneContent.mockImplementation(() => new Promise(() => {}))
    let settled: boolean | null = null
    void ensureContentMapped(SOUND).then((mapped) => { settled = mapped })
    await vi.advanceTimersByTimeAsync(11_000)
    expect(settled).toBe(false)
  })
})
