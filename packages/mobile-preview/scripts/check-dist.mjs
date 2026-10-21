import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
const dist = new URL('../dist/', import.meta.url)
const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', dist), 'utf8'))
const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (manifest.version !== pkg.version) throw new Error('Rebuild the runtime after changing its version.')
const required = ['index.html', 'index.js', 'index.wasm', 'index.side.wasm', 'index.pck', 'dclgodot.wasm', 'scene-comms.js', 'pulse.js', 'livekit-client.umd.js', 'livekit-LICENSE.txt', 'bridge.js', 'realm-fetch.js', 'capture.js']
const allowed = /^(index\.(html|js|wasm|side\.wasm|pck|png|icon\.png|apple-touch-icon\.png|audio\.[a-z.]+\.js)|dclgodot\.wasm|scene-comms\.js|pulse\.js|livekit-client\.umd\.js|livekit-LICENSE\.txt|libsentry\.[a-z0-9.]+\.wasm|bridge\.js|realm-fetch\.js|capture\.js)$/
if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Invalid runtime manifest')
for (const name of required) if (!Object.hasOwn(manifest.files, name)) throw new Error(`Missing runtime artifact: ${name}`)
for (const name of Object.keys(manifest.files)) if (!allowed.test(name)) throw new Error(`Unexpected runtime artifact: ${name}`)
for (const name of await fs.readdir(dist)) {
  if (name !== 'manifest.json' && !Object.hasOwn(manifest.files, name)) throw new Error(`Unlisted runtime artifact: ${name}`)
  if (!(await fs.lstat(new URL(name, dist))).isFile()) throw new Error(`Runtime artifact must be a regular file: ${name}`)
}
for (const [file, entry] of Object.entries(manifest.files)) {
  const bytes = await fs.readFile(new URL(file, dist))
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Runtime artifact changed: ${file}`)
}
