import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setThreeWorker, startThreeWorker } from './client'

describe('3D worker startup', () => {
  const port = () => ({ onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn(), close: vi.fn() })
  let ports: { port1: ReturnType<typeof port>; port2: ReturnType<typeof port> }
  const terminate = vi.fn()
  const construct = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    setThreeWorker(async () => 'worker source')
    ports = { port1: port(), port2: port() }
    vi.stubGlobal('MessageChannel', class { port1 = ports.port1; port2 = ports.port2 })
    vi.stubGlobal('Worker', class { constructor() { construct() } terminate = terminate; postMessage = vi.fn() })
    vi.spyOn(URL, 'revokeObjectURL')
  })
  afterEach(() => { setThreeWorker(null); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

  it('stops while loading source without creating a worker later', async () => {
    let release = (_: string) => {}
    setThreeWorker(() => new Promise((resolve) => { release = resolve }))
    const controller = new AbortController()
    const result = expect(startThreeWorker('view', controller.signal)).rejects.toThrow('Stopped')
    controller.abort(new Error('Stopped'))
    await result
    release('late source')
    await vi.advanceTimersByTimeAsync(0)
    expect(construct).not.toHaveBeenCalled()
  })

  it.each(['abort', 'timeout'] as const)('disposes a worker that never becomes ready on %s', async (failure) => {
    const controller = new AbortController()
    const result = expect(startThreeWorker('view', controller.signal)).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    if (failure === 'abort') controller.abort()
    else await vi.advanceTimersByTimeAsync(15_000)
    await result
    expect(terminate).toHaveBeenCalledOnce()
    expect(ports.port1.close).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the startup deadline when ready and transfers lifecycle ownership to the caller', async () => {
    const pending = startThreeWorker('view')
    await vi.advanceTimersByTimeAsync(0)
    ports.port1.onmessage?.({ data: { kind: 'ready' } } as MessageEvent)
    const worker = await pending
    expect(vi.getTimerCount()).toBe(0)
    expect(terminate).not.toHaveBeenCalled()
    worker.terminate()
    expect(terminate).toHaveBeenCalledOnce()
  })
})
