import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewCodeModel } from './model-preview'
import { startThreeWorker, type ThreeWorker } from '../three/client'
import { dataLayerReadFileBytes } from '../engine/datalayer'

vi.mock('../three/client', () => ({ startThreeWorker: vi.fn() }))
vi.mock('../engine/datalayer', () => ({ dataLayerReadFileBytes: vi.fn() }))

describe('model preview lifecycle', () => {
  let worker: ThreeWorker
  const bytes = new Uint8Array([1, 2, 3])
  beforeEach(() => {
    vi.useFakeTimers()
    worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null }
    vi.mocked(startThreeWorker).mockResolvedValue(worker)
    vi.mocked(dataLayerReadFileBytes).mockResolvedValue(new Uint8Array([4, 5]))
  })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('sends shared textures and returns the preview, then terminates the worker', async () => {
    const signal = new AbortController().signal
    const result = previewCodeModel(bytes, ['materials/wood.jpg'], signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(startThreeWorker).toHaveBeenCalledWith('view', signal)
    expect(dataLayerReadFileBytes).toHaveBeenCalledWith('models/materials/wood.jpg')
    expect(worker.postMessage).toHaveBeenCalledWith({ kind: 'preview', bytes: bytes.buffer, files: { 'materials/wood.jpg': new Uint8Array([4, 5]).buffer } })
    const preview = { mimeType: 'image/jpeg' as const, image: 'AAAA', width: 1152, height: 384 }
    worker.onmessage?.({ data: { kind: 'previewed', preview } } as MessageEvent)
    await expect(result).resolves.toEqual(preview)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'abort', 'failed', 'unexpected'] as const)('cleans up after %s', async (failure) => {
    const controller = new AbortController()
    const result = expect(previewCodeModel(bytes, [], controller.signal)).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(8000)
    else if (failure === 'abort') controller.abort()
    else worker.onmessage?.({ data: failure === 'failed' ? { kind: 'failed', error: 'No geometry' } : { kind: 'shown' } } as MessageEvent)
    await result
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
