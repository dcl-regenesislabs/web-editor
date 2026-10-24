import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveThumbnail } from '@ui/ai/thumbnail'
import { applyAssistantSettings, type RawSceneJson } from '../shell/scene-json'

afterEach(() => { vi.unstubAllGlobals() })

// the browser's canvas, as far as the thumbnail uses it: a 1536×1024 painting, and jpgs over Worlds' 1 MB at the first quality
function stubCanvas() {
  const draws: unknown[][] = []
  const encodes: Array<{ width: number; height: number; quality: number }> = []
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1536, height: 1024, close: () => {} }))
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(readonly width: number, readonly height: number) {}
    getContext() { return { imageSmoothingQuality: 'low', drawImage: (...args: unknown[]) => { draws.push(args.slice(1)) } } }
    async convertToBlob({ quality }: { quality: number }) {
      encodes.push({ width: this.width, height: this.height, quality })
      return new Blob([new Uint8Array(quality > 0.85 ? 1_200_000 : 700_000)])
    }
  })
  return { draws, encodes }
}

describe('saveThumbnail', () => {
  it('saves the painting as the next centred 1920×1080 jpg under 1 MB and points scene.json at it', async () => {
    const { draws, encodes } = stubCanvas()
    const files = new Map<string, Uint8Array>([['assets/images/thumbnail-1.jpg', new Uint8Array(1)], ['assets/images/thumbnail.jpg', new Uint8Array(1)]])
    let scene: RawSceneJson = { display: { title: 'Roof Runner' }, scene: { parcels: ['0,0'], base: '0,0' } }

    const saved = await saveThumbnail({ image: btoa('painted'), mimeType: 'image/png' }, {
      files: async () => [...files.keys()],
      save: async (path, bytes) => { files.set(path, bytes) },
      setThumbnail: async (path) => { scene = applyAssistantSettings(scene, { thumbnailPath: path }) }
    }, new AbortController().signal)

    expect(draws[0]).toEqual([0, 80, 1536, 864, 0, 0, 1920, 1080])
    expect(encodes).toEqual([{ width: 1920, height: 1080, quality: 0.88 }, { width: 1920, height: 1080, quality: 0.8 }])
    expect(saved).toEqual({ path: 'assets/images/thumbnail-2.jpg', version: 2, width: 1920, height: 1080, bytes: 700_000 })
    expect(files.get('assets/images/thumbnail-2.jpg')?.length).toBe(700_000)
    expect(files.get('assets/images/thumbnail-1.jpg')?.length).toBe(1)
    expect(scene.display).toEqual({ title: 'Roof Runner', navmapThumbnail: 'assets/images/thumbnail-2.jpg' })
  })

  it('refuses anything that is not an image model picture', async () => {
    const save = vi.fn()
    await expect(saveThumbnail({ image: 'not base64!', mimeType: 'image/png' }, { files: async () => [], save, setThumbnail: vi.fn() }, new AbortController().signal))
      .rejects.toThrow('saveThumbnail')
    expect(save).not.toHaveBeenCalled()
  })
})
