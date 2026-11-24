// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewCatalogModels } from './catalog-preview'
import type { ModelAsset } from '../assets'

const model = (thumbnailUrl = 'https://models.dclregenesislabs.xyz/tree.jpg'): ModelAsset => ({
  id: 'tree', name: 'Tree', filename: 'tree.glb', url: '', collection: '', category: 'nature', tags: [], thumbnailUrl
})

describe('catalog previews', () => {
  const close = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))))
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close })))
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn() } }
      async convertToBlob() { return new Blob(['jpeg'], { type: 'image/jpeg' }) }
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

  it('limits thumbnails to eight and rejects foreign origins before fetching', async () => {
    const preview = await previewCatalogModels([model('https://example.com/tree.jpg'), ...Array.from({ length: 10 }, () => model())], new AbortController().signal)
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(preview).toMatchObject({ mimeType: 'image/jpeg', width: 1024, height: 608 })
    expect(close).toHaveBeenCalledTimes(7)
  })

  it('cancels the body of an HTTP error without decoding it', async () => {
    const cancel = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503 }))
    await expect(previewCatalogModels([model()], new AbortController().signal)).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it.each(['header', 'body'])('rejects oversized thumbnails from the %s and cancels their stream', async (from) => {
    const cancel = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) }, cancel }),
      from === 'header' ? { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } } : {}))
    await expect(previewCatalogModels([model()], new AbortController().signal)).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('closes decoded bitmaps when stopped before drawing', async () => {
    const controller = new AbortController()
    vi.mocked(createImageBitmap).mockImplementationOnce(async () => {
      controller.abort(new Error('Stopped'))
      return { close } as unknown as ImageBitmap
    })
    await expect(previewCatalogModels([model()], controller.signal)).rejects.toThrow('Stopped')
    expect(close).toHaveBeenCalledOnce()
  })
})
