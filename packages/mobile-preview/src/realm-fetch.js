self.installMobileRealmFetch = (realm, send) => {
  const nativeFetch = self.fetch.bind(self)
  const pending = new Map()
  self.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(realm + '/')) return nativeFetch(input, init)
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw new Error('Invalid preview request method')
    const body = request.method === 'POST' ? await request.arrayBuffer() : undefined
    if (body && body.byteLength > 1024 * 1024) throw new Error('Preview request is too large')
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const finish = () => {
        clearTimeout(timeout)
        pending.delete(requestId)
        request.signal.removeEventListener('abort', abort)
      }
      const abort = () => { finish(); reject(request.signal.reason) }
      const timeout = setTimeout(() => { finish(); reject(new Error('The editor did not answer the preview request')) }, 30_000)
      pending.set(requestId, message => {
        finish()
        if (message.error) reject(new Error(message.error))
        else {
          const response = new Response(request.method === 'HEAD' || [204, 205, 304].includes(message.status) ? null : message.body, { status: message.status, headers: message.headers })
          Object.defineProperty(response, 'url', { value: url })
          resolve(response)
        }
      })
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) { abort(); return }
      send({ type: 'realm-request', requestId, path: url.slice(realm.length), method: request.method, body })
    })
  }
  return message => pending.get(message.requestId)?.(message)
}
