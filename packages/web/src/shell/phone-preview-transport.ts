import { object } from '@dcl-editor/contract'

const MAX_BUFFERED_BYTES = 64 * 1024 * 1024
const MAX_JSON_BYTES = 4 * 1024 * 1024

function allowedResource(path: string, method: unknown): boolean {
  if (path.length > 8192) return false
  if (method === 'POST') return path === '/content/entities/active'
  if (method !== 'GET' && method !== 'HEAD') return false
  return path === '/about' || path === '/scene.json' ||
    /^\/content\/contents\/(?:b64-[A-Za-z0-9+/=]+|[A-Za-z0-9]+)$/.test(decodeURIComponent(path))
}

export function createPreviewTransport(entry: string | null, session: string, receive: (message: Record<string, unknown>) => void) {
  const origin = entry === null ? null : new URL(entry).origin
  let instance = ''
  let target: Window | null = null
  let realm = ''
  let relayRealm = ''
  let pending = new AbortController()
  let requests = 0
  let bufferedBytes = 0

  const send = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    if (target !== null && origin !== null) target.postMessage({ ...message, session, instance }, origin, transfer)
  }
  const relay = async (message: Record<string, unknown>): Promise<void> => {
    if (typeof message.requestId !== 'string' || message.requestId.length > 128 || typeof message.path !== 'string') return
    const requestId = message.requestId
    if (requests >= 64) {
      send({ type: 'realm-response', requestId, error: 'Too many preview resource requests' })
      return
    }
    const controller = pending
    const source = target
    const request = new AbortController()
    const timeout = setTimeout(() => request.abort(new Error('Preview resource timed out')), 30_000)
    let buffered = 0
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    requests++
    try {
      const url = new URL(realm + message.path)
      // Scene workers must never borrow the editor window's access to realm storage.
      if (!url.href.startsWith(realm + '/') || !allowedResource(message.path, message.method)) throw new Error('Invalid preview resource')
      if (message.body !== undefined && (!(message.body instanceof ArrayBuffer) || message.body.byteLength > 1024 * 1024)) throw new Error('Invalid preview request body')
      const response = await fetch(url, {
        method: String(message.method), credentials: 'omit', redirect: 'error', signal: AbortSignal.any([controller.signal, request.signal]),
        headers: { 'Content-Type': 'application/json' },
        body: message.method === 'POST' ? message.body as ArrayBuffer | undefined : undefined
      })
      const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream'
      const limit = contentType.includes('application/json') ? MAX_JSON_BYTES : MAX_BUFFERED_BYTES
      reader = response.body?.getReader()
      if (Number(response.headers.get('Content-Length')) > limit) throw new Error('Preview resource exceeds the memory limit')
      const chunks: Uint8Array[] = []
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffered += value.byteLength
          bufferedBytes += value.byteLength
          if (buffered > limit || bufferedBytes > MAX_BUFFERED_BYTES) throw new Error('Preview resource exceeds the memory limit')
          chunks.push(value)
        }
      }
      const bytes = new Uint8Array(buffered)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      chunks.length = 0
      let body = bytes.buffer
      if (message.method !== 'HEAD' && body.byteLength > 0 && contentType.includes('application/json')) {
        const json: unknown = JSON.parse(new TextDecoder().decode(body))
        const rewrite = (value: unknown): unknown => {
          if (typeof value === 'string') return value.startsWith(realm + '/') || value === realm ? relayRealm + value.slice(realm.length) : value
          if (Array.isArray(value)) return value.map(rewrite)
          if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]))
          return value
        }
        body = new TextEncoder().encode(JSON.stringify(rewrite(json))).buffer
      }
      if (!controller.signal.aborted && source === target) send({ type: 'realm-response', requestId, status: response.status, headers: { 'Content-Type': contentType }, body }, [body])
    } catch (error) {
      if (!controller.signal.aborted && source === target) send({ type: 'realm-response', requestId, error: error instanceof Error ? error.message : String(error) })
    } finally {
      clearTimeout(timeout)
      request.abort()
      if (reader !== undefined) void reader.cancel().catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'AbortError')) console.warn('Preview stream cleanup:', error)
      })
      bufferedBytes -= buffered
      requests--
    }
  }
  const onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data
    if (event.origin !== origin || !object(message) || message.session !== session || message.instance !== instance || instance === '') return
    if (message.type === 'connect' && target === null && event.source !== null && 'postMessage' in event.source) target = event.source as Window
    if (event.source !== target || target === null) return
    if (message.type === 'realm-request') void relay(message)
    else receive(message)
  }
  window.addEventListener('message', onMessage)
  return {
    send,
    reset: (nextInstance = '', nextRealm = '', nextRelayRealm = ''): void => {
      pending.abort()
      pending = new AbortController()
      target = null
      instance = nextInstance
      realm = nextRealm
      relayRealm = nextRelayRealm
    },
    dispose: (): void => { pending.abort(); window.removeEventListener('message', onMessage) }
  }
}
