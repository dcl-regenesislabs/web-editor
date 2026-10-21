import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const override = process.argv[2] ?? process.env.MOBILE_PREVIEW_EXPORT
const source = override ?? fileURLToPath(new URL('./', import.meta.resolve('@dcl-regenesislabs/mobile-preview-runtime/manifest.json')))
if (!override) execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('@dcl-regenesislabs/mobile-preview-runtime/check'))], { stdio: 'inherit' })
const required = ['index.html', 'index.js', 'index.wasm', 'index.side.wasm', 'index.pck', 'dclgodot.wasm', 'scene-comms.js', 'pulse.js', 'livekit-client.umd.js', 'livekit-LICENSE.txt']
const names = (await fs.readdir(source)).filter(name => /^(index\.(html|js|wasm|side\.wasm|pck|png|icon\.png|apple-touch-icon\.png|audio\.[a-z.]+\.js)|dclgodot\.wasm|scene-comms\.js|pulse\.js|livekit-client\.umd\.js|livekit-LICENSE\.txt|libsentry\.[a-z0-9.]+\.wasm)$/.test(name))
for (const name of required) if (!names.includes(name)) throw new Error(`Missing runtime artifact: ${name}`)
let html = (await fs.readFile(path.join(source, 'index.html'), 'utf8')).replace(/\r\n/g, '\n')
if (!html.includes('await initWebGPU()') || !html.includes('localPreviewReady')) throw new Error('Export does not support the local preview protocol.')
html = html.replace('<head>', '<head>\n<script src="realm-fetch.js"></script>\n<script src="bridge.js"></script>\n<script src="capture.js"></script>')
html = html.replace(/<script src="sentry-bundle\.js"[^>]*><\/script>/, '')
html = html.replace('device = await initWebGPU();', 'await window.previewTransportReady;\n    device = await initWebGPU();')
const oldCapture = "await new Promise(requestAnimationFrame);\n    const source = document.getElementById('canvas');"
if (!html.includes(oldCapture)) throw new Error('Export capture protocol changed; update the runtime adapter.')
html = html.replace(oldCapture, "const source = await window.captureMobilePreviewFrame(device.queue, document.getElementById('canvas'));")
const dist = path.join(root, 'dist')
await fs.rm(dist, { recursive: true, force: true })
await fs.mkdir(dist, { recursive: true })
for (const name of names) await fs.copyFile(path.join(source, name), path.join(dist, name))
await fs.writeFile(path.join(dist, 'index.html'), html)
for (const name of ['bridge.js', 'realm-fetch.js', 'capture.js']) await fs.copyFile(path.join(root, 'src', name), path.join(dist, name))
const manifest = { version: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version, files: {} }
if (!override) {
  const runtime = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'))
  manifest.runtime = { version: runtime.version, source: runtime.source }
}
for (const name of await fs.readdir(dist)) {
  const bytes = await fs.readFile(path.join(dist, name))
  manifest.files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
await fs.writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Prepared ${Object.keys(manifest.files).length} runtime files in ${dist}`)
