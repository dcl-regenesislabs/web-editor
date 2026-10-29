// The web editor hosted in bevy-explorer's HUD, with a local project service, in one command:
//
//   npm run dev:web                                  # bevy-explorer next to this checkout
//   npm run dev:web -- --bevy ../bevy-explorer --world gate.eth
//   npm run dev:web -- --slot 1                      # a second stack beside the first: every port +100
//
// It builds the editor scene's export and packages/web once, starts the project service on
// :8787 (its data under .data/service), optionally a stand-in Worlds server on :8799 that lets
// the first wallet claim --world, and then bevy-explorer's react-web dev server with
// WEB_EDITOR_DIR set to this checkout. Ctrl+C stops all of them.
//
// The assistant shows only with a model session for the service: sign in once with
// `node packages/service/scripts/assistant-login.ts --provider claude --auth .data/assistant/.auth.json`,
// then add `--ai-auth .data/assistant/.auth.json`. Thumbnails need a ChatGPT session too:
// `npm run -w @dcl-editor/service image-login -- --out .data/assistant/image-auth.json`, then `--ai-image-auth` with it.
//
// Rebuild after editing the editor: `npm run build -w @dcl-editor/web`, then reload the page;
// after editing packages/scene, `npm run export-static -w @dcl-editor/scene` first.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    bevy: { type: 'string', default: process.env.BEVY_DIR ?? path.resolve(root, '..', 'bevy-explorer') },
    world: { type: 'string' },
    'ai-auth': { type: 'string' },
    'ai-image-auth': { type: 'string' },
    'no-build': { type: 'boolean', default: false },
    slot: { type: 'string', default: process.env.DEV_WEB_SLOT ?? '0' }
  }
})
const slot = Number(values.slot)
if (!Number.isInteger(slot) || slot < 0 || slot > 9) {
  console.error('--slot takes 0–9.')
  process.exit(1)
}
const PAGE_PORT = 5173 + slot * 100
const PAGE = `http://localhost:${PAGE_PORT}`
const SERVICE_PORT = 8787 + slot * 100
const WORLDS_PORT = 8799 + slot * 100
const MOBILE_PORT = 8788 + slot * 100
const BRIDGE_PORT = 8100 + slot * 100

const reactWeb = path.join(path.resolve(values.bevy), 'react-web')
if (!fs.existsSync(path.join(reactWeb, 'package.json'))) {
  console.error(`No bevy-explorer checkout at ${values.bevy}; pass --bevy <dir> or set BEVY_DIR.`)
  process.exit(1)
}
if (!fs.existsSync(path.join(reactWeb, '..', 'deploy', 'web', 'engine', 'pkg'))) {
  console.error(`bevy-explorer has no engine build; run \`just wasm\` in ${path.dirname(reactWeb)} first.`)
  process.exit(1)
}

if (slot !== 0 && !fs.readFileSync(path.join(reactWeb, 'vite.config.ts'), 'utf8').includes('BRIDGE_SCENE_PORT')) {
  console.error(`This explorer checkout cannot move its bridge scene off :8100, so --slot needs a newer one than ${values.bevy}.`)
  process.exit(1)
}
// a taken port would leave half a stack talking to another one's servers
const taken = await Promise.all([PAGE_PORT, SERVICE_PORT, MOBILE_PORT].map((port) => new Promise((resolve) => {
  const probe = net.createConnection({ port, host: '127.0.0.1' })
  probe.once('connect', () => { probe.destroy(); resolve(port) })
  probe.once('error', () => resolve(null))
}))).filter((port) => port !== null)
if (taken.length > 0) {
  console.error(`Port ${taken.join(', ')} is in use, probably by another stack; pass --slot ${slot + 1}.`)
  process.exit(1)
}

// the latest modification time under a directory; 0 when it doesn't exist
function newest(dir) {
  if (!fs.existsSync(dir)) return 0
  let latest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) latest = Math.max(latest, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs)
  }
  return latest
}

function run(command, args, cwd = root) {
  console.log(`▶ ${command} ${args.join(' ')}`)
  if (spawnSync(command, args, { cwd, stdio: 'inherit' }).status !== 0) process.exit(1)
}
if (!values['no-build']) {
  // re-exported whenever its sources changed: an old export silently serves the old editor scene
  if (newest(path.join(root, 'packages', 'scene', 'src')) > newest(path.join(root, 'packages', 'web', 'dist', 'scene'))) {
    run('npm', ['run', 'export-static', '-w', '@dcl-editor/scene'])
  }
  run('npm', ['run', 'build', '-w', '@dcl-editor/web'])
  // the phone preview is optional: without its runtime the stack starts with the menu entry hidden
  console.log('▶ npm run build -w @dcl-editor/mobile-preview')
  if (spawnSync('npm', ['run', 'build', '-w', '@dcl-editor/mobile-preview'], { cwd: root, stdio: 'inherit' }).status !== 0) {
    console.warn('[mobile] runtime build failed; starting without the phone preview')
  }
}

const children = []
function start(name, command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim() !== '') console.log(`[${name}] ${line}`)
    })
  }
  child.on('exit', (code) => {
    console.log(`[${name}] exited (${code})`)
    stop()
  })
  children.push(child)
}
function stop() {
  for (const child of children) if (child.exitCode === null) child.kill()
  process.exitCode = 0
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

const dataDir = path.join(root, '.data', 'service')
fs.mkdirSync(dataDir, { recursive: true })
if (fs.existsSync(path.join(root, 'packages/mobile-preview/dist/manifest.json'))) {
  start('mobile', process.execPath, ['packages/mobile-preview/scripts/serve.ts', String(MOBILE_PORT)])
}
start('service', process.execPath, [
  'packages/service/dev-server.ts',
  '--port',
  String(SERVICE_PORT),
  '--data',
  dataDir,
  '--origin',
  PAGE,
  ...(values['ai-auth'] === undefined ? [] : ['--ai-auth', path.resolve(values['ai-auth'])]),
  ...(values['ai-image-auth'] === undefined ? [] : ['--ai-image-auth', path.resolve(values['ai-image-auth'])])
])
// slot 0 keeps the defaults both sides assume; another slot names its own servers to the page
let query = slot === 0 ? '' : `&editor-projects=http://localhost:${SERVICE_PORT}&editor-mobile=http://127.0.0.1:${MOBILE_PORT}&bridgePort=${BRIDGE_PORT}`
if (values.world !== undefined) {
  start('worlds', process.execPath, ['packages/web/validate/fake-worlds-server.mjs', '--port', String(WORLDS_PORT), '--claim', values.world])
  query += `&editor-worlds=http://localhost:${WORLDS_PORT}`
}
start('bevy', 'npm', ['run', 'dev', '--', '--port', String(PAGE_PORT), '--strictPort'], {
  cwd: reactWeb,
  env: { ...process.env, WEB_EDITOR_DIR: root, BRIDGE_SCENE_PORT: String(BRIDGE_PORT) }
})

console.log(`\nOpen ${PAGE}/?editor${query} (projects sync to http://localhost:${SERVICE_PORT}, data in ${path.relative(root, dataDir)})\n`)
