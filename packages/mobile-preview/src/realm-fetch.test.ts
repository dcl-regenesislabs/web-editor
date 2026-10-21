import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./realm-fetch.js', import.meta.url), 'utf8')
const realm = 'http://runtime.test/mobile-preview/realm/session/instance'
type Reply = { requestId: string; status?: number; headers?: Record<string, string>; body?: ArrayBuffer; error?: string }
afterEach(() => vi.useRealTimers())
function setup() {
  vi.useFakeTimers()
  const native = vi.fn(async () => new Response('external'))
  const send = vi.fn()
  const scope: { fetch: typeof fetch; installMobileRealmFetch?: (realm: string, dispatch: typeof send) => (reply: Reply) => void } = { fetch: native }
  vm.runInNewContext(source, { self: scope, Request, Response, crypto, URL, Map, Error, setTimeout, clearTimeout })
  const receive = scope.installMobileRealmFetch?.(realm, send)
  if (!receive) throw new Error('Missing relay installer')
  return { scope, native, send, receive }
}

it('relays scene requests while leaving external requests on native fetch', async () => {
  const { scope, native, send, receive } = setup()
  const pending = scope.fetch(realm + '/about')
  const message = send.mock.calls[0][0] as { requestId: string }
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ path: '/about', method: 'GET' }))
  receive({ ...message, status: 200, headers: { 'Content-Type': 'text/plain' }, body: new TextEncoder().encode('local').buffer })
  const response = await pending
  expect(response.url).toBe(realm + '/about')
  expect(await response.text()).toBe('local')
  expect(await (await scope.fetch('https://content.example/file')).text()).toBe('external')
  expect(native).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('forwards POST bytes and handles HEAD without a response body', async () => {
  const { scope, send, receive } = setup()
  const post = scope.fetch(realm + '/content/query', { method: 'POST', body: '{"pointers":["0,0"]}' })
  await vi.advanceTimersByTimeAsync(0)
  const request = send.mock.calls[0][0] as { requestId: string; body: ArrayBuffer }
  expect(new TextDecoder().decode(request.body)).toBe('{"pointers":["0,0"]}')
  receive({ requestId: request.requestId, status: 200, body: new ArrayBuffer(0) })
  expect((await post).status).toBe(200)
  // the transport buffers every reply, so a HEAD or 304 arrives with an empty body the Response constructor would reject
  const head = scope.fetch(realm + '/about', { method: 'HEAD' })
  receive({ requestId: send.mock.calls[1][0].requestId as string, status: 304, body: new ArrayBuffer(0) })
  expect(await (await head).text()).toBe('')
})

it('cleans up aborted and timed out requests', async () => {
  const { scope, send, receive } = setup()
  const controller = new AbortController()
  const pending = expect(scope.fetch(realm + '/content/file', { signal: controller.signal })).rejects.toThrow('cancelled')
  controller.abort(new Error('cancelled'))
  await pending
  receive({ requestId: send.mock.calls[0][0].requestId as string, status: 200 })
  expect(vi.getTimerCount()).toBe(0)
  const timeout = expect(scope.fetch(realm + '/about')).rejects.toThrow('did not answer')
  await vi.advanceTimersByTimeAsync(30_000)
  await timeout
  expect(vi.getTimerCount()).toBe(0)
})
