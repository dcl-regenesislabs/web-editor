import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const TYPES: Record<string, string> = { html: 'text/html', js: 'text/javascript', json: 'application/json', wasm: 'application/wasm', png: 'image/png' }
export function createMobilePreviewHandler(directory = new URL('../dist/', import.meta.url), prefix = '/mobile-preview/') {
  const manifest = readFile(new URL('manifest.json', directory), 'utf8').then(text => {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || !('files' in parsed) || typeof parsed.files !== 'object' || parsed.files === null) throw new Error('Invalid mobile runtime manifest')
    return new Set([...Object.keys(parsed.files), 'manifest.json'])
  }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) console.error('Mobile runtime manifest:', error)
    return null
  })
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const name = url.pathname.slice(prefix.length)
    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Document-Isolation-Policy': 'isolate-and-credentialless',
      'Origin-Agent-Cluster': '?1',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache'
    })
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers })
    const allowed = await manifest
    if (!allowed) return new Response('Mobile preview runtime is not installed. Build or install its npm package.', { status: 503, headers })
    if (!url.pathname.startsWith(prefix) || !allowed.has(name) || name.includes('/') || name.includes('..')) return new Response(null, { status: 404, headers })
    const file = new URL(name, directory)
    try {
      const info = await stat(file)
      headers.set('Content-Type', TYPES[name.split('.').at(-1) ?? ''] ?? 'application/octet-stream')
      headers.set('Content-Length', String(info.size))
      headers.set('ETag', `"${info.size}-${info.mtimeMs}"`)
      if (request.headers.get('If-None-Match') === headers.get('ETag')) return new Response(null, { status: 304, headers })
      const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(fileURLToPath(file))) as ReadableStream<Uint8Array>
      return new Response(body, { headers })
    } catch {
      return new Response('Mobile runtime artifact is missing', { status: 503, headers })
    }
  }
}
