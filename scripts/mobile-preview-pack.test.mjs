import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const adapter = new URL('../packages/mobile-preview/', import.meta.url)
const directories = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })

// the runtime's index.html as build.mjs expects it, down to the capture lines it rewrites
const INDEX_HTML = [
  '<html><head></head><body><script>',
  'async function start() {',
  '    device = await initWebGPU();',
  '    localPreviewReady();',
  "    await new Promise(requestAnimationFrame);\n    const source = document.getElementById('canvas');",
  '}',
  '</script></body></html>'
].join('\n')

const EXPORT_FILES = ['index.html', 'index.js', 'index.wasm', 'index.side.wasm', 'index.pck', 'index.png', 'index.icon.png', 'index.apple-touch-icon.png',
  'index.audio.worklet.js', 'dclgodot.wasm', 'scene-comms.js', 'pulse.js', 'livekit-client.umd.js', 'livekit-LICENSE.txt', 'libsentry.1a2b3c.wasm',
  'sentry-bundle.js', 'manifest.json', 'notes.txt']

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'preview-pack-'))
  directories.push(dir)
  await mkdir(path.join(dir, 'scripts'))
  await mkdir(path.join(dir, 'src'))
  await mkdir(path.join(dir, 'export'))
  for (const name of ['scripts/build.mjs', 'scripts/check-dist.mjs', 'src/bridge.js', 'src/realm-fetch.js', 'src/capture.js']) {
    await copyFile(new URL(name, adapter), path.join(dir, name))
  }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }))
  for (const name of EXPORT_FILES) await writeFile(path.join(dir, 'export', name), name === 'index.html' ? INDEX_HTML : `export ${name}`)
  const run = (script, ...args) => execFileSync(process.execPath, [path.join(dir, 'scripts', script), ...args], { stdio: 'pipe' })
  const manifestPath = path.join(dir, 'dist/manifest.json')
  return {
    dir,
    build: () => run('build.mjs', path.join(dir, 'export')),
    check: () => run('check-dist.mjs'),
    manifest: async () => JSON.parse(await readFile(manifestPath, 'utf8')),
    save: (manifest) => writeFile(manifestPath, JSON.stringify(manifest))
  }
}

it('packages a runtime export that its own check then accepts, dropping files the editor does not serve', async () => {
  const { build, check, manifest } = await fixture()
  expect(build).not.toThrow()
  expect(check).not.toThrow()
  const packaged = Object.keys((await manifest()).files).sort()
  expect(packaged).toEqual([...EXPORT_FILES.filter((name) => !['sentry-bundle.js', 'manifest.json', 'notes.txt'].includes(name)), 'bridge.js', 'realm-fetch.js', 'capture.js'].sort())
})

it('rejects unlisted files, incomplete manifests, path escapes and modified artifacts', async () => {
  const { dir, build, check, manifest, save } = await fixture()
  build()
  await writeFile(path.join(dir, 'dist', 'private.txt'), 'not a runtime artifact')
  expect(check).toThrow(/Unlisted runtime artifact/)
  await rm(path.join(dir, 'dist', 'private.txt'))
  const built = await manifest()
  await save({ ...built, files: {} })
  expect(check).toThrow(/Missing runtime artifact/)
  await save({ ...built, files: { ...built.files, '../private.txt': built.files['index.js'] } })
  expect(check).toThrow(/Unexpected runtime artifact/)
  await save(built)
  await writeFile(path.join(dir, 'dist/index.js'), 'changed')
  expect(check).toThrow(/Runtime artifact changed/)
})
