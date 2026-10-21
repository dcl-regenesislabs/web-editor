import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPreviewTransport } from './phone-preview-transport'

let listener: (event: MessageEvent<unknown>) => void
const origin = 'http://127.0.0.1:8788'
const realm = 'http://localhost:5173/preview/scene'
const relayRealm = origin + '/mobile-preview/realm/session/instance'
beforeEach(() => {
  vi.stubGlobal('window', {
    addEventListener: (_type: string, fn: typeof listener) => { listener = fn },
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ content: { publicUrl: realm + '/content' } }), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function setup() {
  const receive = vi.fn()
  const target = { postMessage: vi.fn() }
  const transport = createPreviewTransport(origin + '/mobile-preview/index.html', 'session', receive)
  transport.reset('instance', realm, relayRealm)
  const message = (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => listener({
    origin, source: target, data: { session: 'session', instance: 'instance', ...data }, ...overrides
  } as unknown as MessageEvent<unknown>)
  return { target, transport, receive, message }
}

it('pins the connected window and rejects wrong origins, instances and sources', () => {
  const { target, transport, receive, message } = setup()
  message({ type: 'connect' }, { origin: 'https://untrusted.example' })
  transport.send({ type: 'capture' })
  expect(target.postMessage).not.toHaveBeenCalled()
  message({ type: 'connect' })
  receive.mockClear()
  message({ type: 'ready' }, { source: {} })
  message({ type: 'ready', instance: 'old' })
  expect(receive).not.toHaveBeenCalled()
  message({ type: 'ready' })
  expect(receive).toHaveBeenCalledOnce()
  transport.send({ type: 'visibility', visible: false })
  expect(target.postMessage).toHaveBeenCalledWith({ type: 'visibility', visible: false, session: 'session', instance: 'instance' }, origin, [])
  transport.dispose()
})

it('relays only the active realm, rewrites its URLs and never forwards credentials', async () => {
  const { target, transport, message } = setup()
  message({ type: 'connect' })
  message({ type: 'realm-request', requestId: 'about', path: '/about', method: 'GET' })
  await vi.waitFor(() => expect(target.postMessage).toHaveBeenCalledOnce())
  expect(fetch).toHaveBeenCalledWith(new URL(realm + '/about'), expect.objectContaining({ credentials: 'omit', redirect: 'error' }))
  const response = target.postMessage.mock.calls[0][0] as { body: ArrayBuffer }
  expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ content: { publicUrl: relayRealm + '/content' } })
  message({ type: 'realm-request', requestId: 'escape', path: '/../../projects', method: 'GET' })
  await vi.waitFor(() => expect(target.postMessage).toHaveBeenCalledTimes(2))
  expect(fetch).toHaveBeenCalledOnce()
  expect(target.postMessage.mock.calls[1][0]).toMatchObject({ requestId: 'escape', error: 'Invalid preview resource' })
  transport.dispose()
})

it('supports HEAD and cancels outstanding requests when the preview closes', async () => {
  const { transport, target, message } = setup()
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { headers: { 'Content-Type': 'application/json' } }))
  message({ type: 'connect' })
  message({ type: 'realm-request', requestId: 'head', path: '/about', method: 'HEAD' })
  await vi.waitFor(() => expect(target.postMessage).toHaveBeenCalledOnce())
  expect(target.postMessage.mock.calls[0][0]).toMatchObject({ status: 200 })
  let signal: AbortSignal | null | undefined
  vi.mocked(fetch).mockImplementationOnce((_url, init) => { signal = init?.signal; return new Promise(() => {}) })
  message({ type: 'realm-request', requestId: 'pending', path: '/content/contents/b64-ZmlsZQ==', method: 'GET' })
  transport.reset()
  expect(signal?.aborted).toBe(true)
  message({ type: 'ready' })
  transport.send({ type: 'capture' })
  expect(target.postMessage).toHaveBeenCalledOnce()
  transport.dispose()
})

it.each([
  ['/env/secret', 'GET'], ['/env/secret', 'HEAD'], ['/values', 'GET'],
  ['/players/player/values/key', 'GET'], ['/content/contents/../../env/secret', 'GET'],
  ['/content/contents/%2e%2e/%2e%2e/env/secret', 'GET'], ['/about?route=/env/secret', 'GET'],
  ['/about', 'POST'], ['/content/entities/active', 'GET'], ['/scene.json', 'DELETE'],
  ['/content/contents/b64-file', 'PUT'], ['//other.example/about', 'GET']
])('rejects privileged or malformed resource requests: %s %s', async (path, method) => {
  const { transport, target, message } = setup()
  message({ type: 'connect' })
  message({ type: 'realm-request', requestId: 'forbidden', path, method })
  await vi.waitFor(() => expect(target.postMessage).toHaveBeenCalledOnce())
  expect(fetch).not.toHaveBeenCalled()
  expect(target.postMessage.mock.calls[0][0]).toMatchObject({ error: 'Invalid preview resource' })
  transport.dispose()
})

it('bounds streamed responses even without a Content-Length header', async () => {
  const { transport, target, message } = setup()
  const cancel = vi.fn()
  vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(3 * 1024 * 1024)) }, cancel
  }), { headers: { 'Content-Type': 'application/json' } }))
  message({ type: 'connect' })
  message({ type: 'realm-request', requestId: 'large', path: '/about', method: 'GET' })
  await vi.waitFor(() => expect(target.postMessage).toHaveBeenCalledOnce())
  expect(target.postMessage.mock.calls[0][0]).toMatchObject({ error: 'Preview resource exceeds the memory limit' })
  expect(cancel).toHaveBeenCalledOnce()
  transport.dispose()
})

it('aborts hung resource requests and reports the timeout', async () => {
  vi.useFakeTimers()
  const { transport, target, message } = setup()
  vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }))
  message({ type: 'connect' })
  message({ type: 'realm-request', requestId: 'hung', path: '/about', method: 'GET' })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(target.postMessage.mock.calls[0][0]).toMatchObject({ error: 'Preview resource timed out' })
  transport.dispose()
})

it.each([
  ['/scene.json', 'GET'], ['/content/contents/b64-ZmlsZQ==', 'GET'],
  ['/content/contents/b64-Zm9vL/8%3D', 'HEAD'], ['/content/entities/active', 'POST']
])('allows scene assets and metadata: %s %s', async (path, method) => {
  const { transport, target, message } = setup()
  message({ type: 'connect' })
  message({ type: 'realm-request', requestId: 'asset', path, method })
  await vi.waitFor(() => expect(target.postMessage).toHaveBeenCalledOnce())
  expect(fetch).toHaveBeenCalledOnce()
  expect(target.postMessage.mock.calls[0][0]).toMatchObject({ status: 200 })
  transport.dispose()
})
