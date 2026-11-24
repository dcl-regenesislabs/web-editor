import type { ThreeReply, ThreeRequest } from './protocol'

// Builds run assistant code, so in a sandboxed frame of its own origin whose policy (inherited by the
// worker) allows no network. The preview runs none, and three's renderer hangs in that frame.
const POLICY = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src blob: data:; img-src blob: data:"
const FRAME = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><script>onmessage=(e)=>{const w=new Worker(URL.createObjectURL(new Blob([e.data],{type:'text/javascript'})));w.postMessage('build',[e.ports[0]])}</script>`

export interface ThreeWorker {
  postMessage: (request: ThreeRequest, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent<ThreeReply>) => void) | null
  terminate: () => void
}

let source: (() => Promise<string>) | null = null

export function setThreeWorker(load: (() => Promise<string>) | null): void {
  source = load
}

export function threeAvailable(): boolean {
  return source !== null
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

export async function startThreeWorker(use: 'build' | 'view', signal?: AbortSignal): Promise<ThreeWorker> {
  if (source === null) throw new Error('3D tools are not available in this editor.')
  signal?.throwIfAborted()
  const timeout = new AbortController()
  const startup = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])
  const timer = setTimeout(() => timeout.abort(new Error('The 3D worker did not start.')), 15_000)
  let stop = () => {}
  let channel: MessageChannel | undefined
  try {
    const code = await abortable(source(), startup)
    const ports = new MessageChannel()
    channel = ports
    let hand: (port: MessagePort) => void
    if (use === 'build') {
      const frame = document.createElement('iframe')
      frame.sandbox.add('allow-scripts')
      frame.hidden = true
      frame.srcdoc = FRAME
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
      stop = () => frame.remove()
      document.body.appendChild(frame)
      await abortable(loaded, startup)
      hand = (port) => frame.contentWindow?.postMessage(code, '*', [port])
    } else {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      stop = () => URL.revokeObjectURL(url)
      const worker = new Worker(url)
      stop = () => { worker.terminate(); URL.revokeObjectURL(url) }
      hand = (port) => worker.postMessage('view', [port])
    }
    const ready = new Promise<void>((resolve) => {
      ports.port1.onmessage = (event: MessageEvent<ThreeReply>) => { if (event.data.kind === 'ready') resolve() }
    })
    hand(ports.port2)
    await abortable(ready, startup)
    const worker: ThreeWorker = {
      postMessage: (request, transfer = []) => ports.port1.postMessage(request, transfer),
      onmessage: null,
      terminate: () => {
        ports.port1.close()
        ports.port2.close()
        stop()
      }
    }
    ports.port1.onmessage = (event: MessageEvent<ThreeReply>) => worker.onmessage?.(event)
    return worker
  } catch (error) {
    channel?.port1.close()
    channel?.port2.close()
    stop()
    throw error
  } finally {
    clearTimeout(timer)
  }
}
