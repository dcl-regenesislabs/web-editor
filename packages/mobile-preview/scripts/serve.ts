import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { createMobilePreviewHandler } from '../src/server.ts'

const port = Number(process.argv[2] ?? 8788)
const handle = createMobilePreviewHandler()
createServer(async (request, response) => {
  try {
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, String(value))
    const result = await handle(new Request(`http://127.0.0.1:${port}${request.url}`, { method: request.method, headers }))
    response.writeHead(result.status, Object.fromEntries(result.headers))
    if (result.body) {
      const body = Readable.from(result.body)
      body.on('error', (error) => { console.error(error); response.destroy(error) })
      body.pipe(response)
    } else response.end()
  } catch (error) {
    console.error(error)
    response.writeHead(500).end()
  }
}).listen(port, '127.0.0.1', () => console.log(`Mobile preview: http://127.0.0.1:${port}/mobile-preview/index.html`))
