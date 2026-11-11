// Builds dist/: editor.js (+ editor.css, chunks/, assets/), scene-compiler/ copied
// from @dcl-editor/scene-compiler, and prefabs/ from the desktop app's built-ins.
// dist/scene/ belongs to the editor scene's static export and is left alone.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { build } from 'vite'
import { sri, writePrefabCatalog } from './prefab-catalog.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(root, '../..')
const dist = path.join(root, 'dist')
const sceneCompilerDist = path.join(repo, 'packages/scene-compiler/dist')
const SCENE_COMPILER_FILES = ['index.js', 'worker.js', 'esbuild.wasm', 'sdk-snapshot.json']

// Windows: npm is npm.cmd, which Node only executes through a shell
const sceneCompiler = spawnSync('npm', ['run', 'build', '-w', '@dcl-editor/scene-compiler'], {
  cwd: repo,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
if (sceneCompiler.status !== 0) process.exit(sceneCompiler.status ?? 1)

fs.mkdirSync(dist, { recursive: true })
for (const entry of fs.readdirSync(dist)) {
  if (entry !== 'scene') fs.rmSync(path.join(dist, entry), { recursive: true, force: true })
}

// Every file editor.js fetches is pinned by a sha384 written into editor.js, so
// the one integrity a host checks on editor.js covers them all (workers.ts).
const SENTINEL = '"@@EDITOR_FILE_INTEGRITY@@"'
const integrity = {}
for (const file of ['worker.js', 'esbuild.wasm', 'sdk-snapshot.json']) {
  integrity[`scene-compiler/${file}`] = sri(fs.readFileSync(path.join(sceneCompilerDist, file)))
}

// three.js lives only in this worker, fetched the first time a model is built or previewed
await bundle({
  entryPoints: [path.join(repo, 'packages/ui/src/three/worker.ts')],
  outfile: path.join(dist, 'three/worker.js'),
  bundle: true, minify: true, format: 'iife', target: 'es2022', legalComments: 'none', logLevel: 'warning'
})
integrity['three/worker.js'] = sri(fs.readFileSync(path.join(dist, 'three/worker.js')))

const catalog = writePrefabCatalog(path.join(repo, 'packages/desktop/prefabs'), dist)
integrity[catalog.file] = catalog.integrity

// the shared materials buildModel and the sounds addSound write into a project, fetched only when used
for (const [folder, source, ext] of [['materials', 'packages/ui/src/three/materials', '.jpg'], ['sounds', 'packages/ui/src/sounds', '.mp3']]) {
  fs.mkdirSync(path.join(dist, folder), { recursive: true })
  for (const file of fs.readdirSync(path.join(repo, source)).filter((f) => f.endsWith(ext))) {
    const rel = `${folder}/${file}`
    fs.copyFileSync(path.join(repo, source, file), path.join(dist, rel))
    integrity[rel] = sri(fs.readFileSync(path.join(dist, rel)))
  }
}
// the icon catalog findIcons searches and addIcon copies from: the index whole, the pack by byte range
fs.mkdirSync(path.join(dist, 'icons'), { recursive: true })
for (const file of ['icons.index.json', 'icons.pack']) {
  fs.copyFileSync(path.join(repo, 'packages/ui/src/icon-library', file), path.join(dist, 'icons', file))
  integrity[`icons/${file}`] = sri(fs.readFileSync(path.join(dist, 'icons', file)))
}

const pinFetchedFiles = {
  name: 'pin-fetched-files',
  enforce: 'post',
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type === 'chunk' && output.fileName !== 'editor.js') this.error(`${output.fileName}: a separate chunk could not be pinned`)
      if (output.type === 'asset' && output.fileName !== 'editor.css') this.error(`${output.fileName}: a separate asset could not be pinned`)
      if (output.type === 'asset') integrity[output.fileName] = sri(output.source)
    }
    const entry = bundle['editor.js']
    if (entry?.type !== 'chunk' || entry.code.split(SENTINEL).length !== 2) this.error('editor.js must hold the file hashes placeholder exactly once')
    entry.code = entry.code.replace(SENTINEL, JSON.stringify(integrity))
  }
}
await build({
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'warn',
  plugins: [pinFetchedFiles],
  define: { __EDITOR_FILE_INTEGRITY__: SENTINEL }
})

fs.mkdirSync(path.join(dist, 'scene-compiler'), { recursive: true })
for (const file of SCENE_COMPILER_FILES) fs.copyFileSync(path.join(sceneCompilerDist, file), path.join(dist, 'scene-compiler', file))
for (const [file, expected] of Object.entries(integrity)) {
  if (sri(fs.readFileSync(path.join(dist, file))) !== expected) throw new Error(`dist/${file} does not match the hash written into editor.js`)
}
fs.mkdirSync(path.join(dist, 'scene'), { recursive: true })

function list(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? list(full) : [full]
  })
}
const sizes = new Map()
for (const file of list(dist).sort()) {
  const bytes = fs.readFileSync(file)
  const name = path.relative(dist, file).split(path.sep).join('/')
  // one line for the prefabs: they are hundreds of small files
  const key = name.startsWith('prefabs/') ? 'prefabs/' : name
  const [raw, gzip] = sizes.get(key) ?? [0, 0]
  sizes.set(key, [raw + bytes.length, gzip + zlib.gzipSync(bytes).length])
}
for (const [name, [raw, gzip]] of sizes) {
  console.log(`${name.padEnd(44)} ${String(raw).padStart(9)} bytes  ${String(gzip).padStart(8)} gzip`)
}

// dist/scene is only re-exported on request, so a hosted editor keeps running the
// old editor scene (gizmo, selection, play behaviour) after a scene change
function newest(dir) {
  if (!fs.existsSync(dir)) return 0
  return Math.max(0, ...list(dir).map((file) => fs.statSync(file).mtimeMs))
}
const sceneExport = path.join(dist, 'scene')
if (fs.readdirSync(sceneExport).length > 0 && newest(path.join(repo, 'packages/scene/src')) > newest(sceneExport)) {
  console.warn('⚠ dist/scene is older than packages/scene/src: run `npm run export-static -w @dcl-editor/scene`')
}
