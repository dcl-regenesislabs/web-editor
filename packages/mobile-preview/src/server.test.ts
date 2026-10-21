import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMobilePreviewHandler } from './server.ts'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture(ready = true) {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-preview-'))
  directories.push(dir)
  await writeFile(join(dir, 'index.wasm'), new Uint8Array([0, 97, 115, 109]))
  await writeFile(join(dir, 'private.txt'), 'unlisted')
  if (ready) await writeFile(join(dir, 'manifest.json'), JSON.stringify({ files: { 'index.wasm': {} } }))
  return createMobilePreviewHandler(pathToFileURL(dir + '/'))
}

it('streams runtime assets with isolation, correct MIME, HEAD and revalidation', async () => {
  const handle = await fixture()
  const url = 'http://127.0.0.1:8788/mobile-preview/index.wasm'
  const response = await handle(new Request(url))
  expect(response.status).toBe(200)
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 97, 115, 109])
  expect(response.headers.get('Content-Type')).toBe('application/wasm')
  expect(response.headers.get('Document-Isolation-Policy')).toBe('isolate-and-credentialless')
  expect(response.headers.has('Cross-Origin-Opener-Policy')).toBe(false)
  const head = await handle(new Request(url, { method: 'HEAD' }))
  expect(await head.text()).toBe('')
  expect(head.headers.get('Content-Length')).toBe('4')
  const cached = await handle(new Request(url, { headers: { 'If-None-Match': response.headers.get('ETag') ?? '' } }))
  expect(cached.status).toBe(304)
})

it('rejects files outside the manifest and unavailable runtime installs', async () => {
  const handle = await fixture()
  for (const path of ['private.txt', '../private.txt', '%2e%2e%2fprivate.txt', 'missing.js']) {
    expect((await handle(new Request('http://local/mobile-preview/' + path))).status).toBe(404)
  }
  expect((await handle(new Request('http://local/mobile-preview/index.wasm', { method: 'POST' }))).status).toBe(405)
  const absent = await fixture(false)
  expect((await absent(new Request('http://local/mobile-preview/index.html'))).status).toBe(503)
})
