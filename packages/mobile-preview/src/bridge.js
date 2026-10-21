(() => {
  const params = new URLSearchParams(location.search)
  const session = params.get('previewSession')
  const instance = params.get('previewInstance')
  const editorOrigin = params.get('editorOrigin')
  const host = params.get('previewDetached') === '1' ? window.parent.opener : window.parent
  const workers = new Map()
  const channels = new Set()
  const NativeChannel = window.BroadcastChannel
  const send = (message, transfer = []) => host.postMessage({ ...message, session, instance }, editorOrigin, transfer)
  const realm = new URL(`realm/${session}/${instance}`, location.href).href
  const receive = self.installMobileRealmFetch(realm, message => send(message, message.body ? [message.body] : []))
  const blobs = new Map()
  const createObjectURL = URL.createObjectURL.bind(URL)
  const revokeObjectURL = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = blob => {
    const url = createObjectURL(blob)
    if (blob instanceof Blob && /javascript/.test(blob.type)) blobs.set(url, blob)
    return url
  }
  URL.revokeObjectURL = url => { blobs.delete(url); revokeObjectURL(url) }
  const NativeWorker = window.Worker
  const helper = new URL('realm-fetch.js', location.href).href
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      const blob = blobs.get(String(url))
      if (!blob || !options?.name?.startsWith('scene-')) { super(url, options); return }
      const prelude = `importScripts(${JSON.stringify(helper)});
        const receivePreviewResource = self.installMobileRealmFetch(${JSON.stringify(realm)}, message => self.postMessage(message, message.body ? [message.body] : []));
        self.addEventListener('message', event => {
          if (event.data?.type !== 'realm-response') return;
          event.stopImmediatePropagation(); receivePreviewResource(event.data);
        });\n`
      const wrapped = createObjectURL(new Blob([prelude, blob], { type: 'text/javascript' }))
      super(wrapped, options)
      revokeObjectURL(wrapped)
      this.addEventListener('message', event => {
        if (event.data?.type !== 'realm-request') return
        event.stopImmediatePropagation()
        const message = event.data
        const timeout = setTimeout(() => workers.delete(message.requestId), 30_000)
        workers.set(message.requestId, { worker: this, timeout })
        send(message, message.body ? [message.body] : [])
      })
    }
    terminate() {
      for (const [id, pending] of workers) if (pending.worker === this) { clearTimeout(pending.timeout); workers.delete(id) }
      super.terminate()
    }
  }
  window.BroadcastChannel = class extends EventTarget {
    constructor(name) {
      super()
      if (name !== 'dcl-phone-preview') return new NativeChannel(name)
      this.onmessage = null
      channels.add(this)
    }
    postMessage(message) { send(message) }
    close() { channels.delete(this) }
  }
  window.addEventListener('message', event => {
    const message = event.data
    if (event.source !== host || event.origin !== editorOrigin || message?.session !== session || message?.instance !== instance) return
    if (message.type === 'realm-response') {
      const pending = workers.get(message.requestId)
      if (pending) {
        workers.delete(message.requestId)
        clearTimeout(pending.timeout)
        pending.worker.postMessage(message, message.body instanceof ArrayBuffer ? [message.body] : [])
      } else receive(message)
      return
    }
    for (const channel of channels) {
      const received = new MessageEvent('message', { data: message })
      channel.onmessage?.(received)
      channel.dispatchEvent(received)
    }
  })
  window.previewTransportReady = (async () => {
    if (!host || !session || !instance || !editorOrigin) throw new Error('Open this mobile preview from the editor.')
    send({ type: 'connect' })
  })()
  window.previewTransportReady.catch(error => console.error('Mobile preview transport:', error))
})()
