// Real provider + production editor tools + Bevy. Each run owns a disposable scene and browser tab.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { build as bundle } from 'esbuild'
import { build as viteBuild } from 'vite'
import { chromium } from 'playwright-core'
import { serveBevyWeb } from '../../desktop/src/servers.ts'

const { values } = parseArgs({ options: {
  auth: { type: 'string' }, cdp: { type: 'string' }, sdk: { type: 'string' },
  variant: { type: 'string', default: 'current' }, baseline: { type: 'string', default: 'HEAD' },
  cases: { type: 'string', default: 'tree,chair,shed,cartoon' },
  source: { type: 'string', default: 'code' },
  effort: { type: 'string' },
  'follow-up': { type: 'string' },
  out: { type: 'string', default: '/tmp/model-assistant' }, 'skip-build': { type: 'boolean' }, 'build-only': { type: 'boolean' }
} })
if (!values.auth || !values.cdp || !values.sdk || !['baseline', 'current'].includes(values.variant) || !['code', 'catalog', 'auto'].includes(values.source)) {
  throw new Error('Use --auth OAUTH_PATH --cdp LOCAL_URL --sdk INSTALLED_SCENE_DIR --variant baseline|current [--source code|catalog|auto] [--cases tree,chair,shed,cartoon] [--baseline GIT_REF] [--out DIR]')
}
if (values.effort !== undefined && !['low', 'medium', 'high'].includes(values.effort)) throw new Error('Use --effort low|medium|high')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(import.meta.url)
const variant = values.variant
const out = path.resolve(values.out, variant)
const built = path.join(repo, '.data/model-assistant/dist', `${variant}${values.effort ? `-${values.effort}` : ''}`)
const sdk = path.resolve(values.sdk)
const baseRef = execFileSync('git', ['rev-parse', '--verify', values.baseline], { cwd: repo, encoding: 'utf8' }).trim()
const previous = (file) => execFileSync('git', ['show', `${baseRef}:${file}`], { cwd: repo, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' })
const replaced = new Set([
  'packages/ui/src/ai/scene.ts', 'packages/ui/src/ai/code-model.ts', 'packages/ui/src/assets.ts', 'packages/ui/src/three/worker.ts', 'packages/ui/src/three/library-glb.ts',
  'packages/ui/src/three/protocol.ts', 'packages/contract/src/assistant.ts', 'packages/contract/src/assistant-prompt.ts', 'packages/contract/src/editor-tools.ts',
  'packages/service/src/ai/pi.ts', 'packages/service/src/adapters/skills.ts'
])
const cases = {
  tree: { prompt: 'Create a 5 metre broadleaf tree for a park.', camera: [23, 4, 8], target: [16, 2.5, 16] },
  chair: { prompt: 'Create an oak dining chair with a curved backrest and a padded cream seat, sized for a person.', camera: [17.7, 1.25, 14], target: [16, 0.55, 16] },
  shed: { prompt: 'Create a small brick garden shed, 4 metres wide and 3 metres deep, with a pitched roof, an open arched doorway and a framed window.', camera: [22, 4, 9], target: [16, 1.5, 16] },
  cartoon: { prompt: 'Create a deliberately chunky, cartoon treasure chest, one metre wide, with a curved red lid and oversized gold bands.', camera: [17.7, 1.2, 14], target: [16, 0.5, 16] }
}
const chosen = values.cases.split(',')
for (const name of chosen) if (!cases[name]) throw new Error(`Unknown benchmark case: ${name}`)
await fs.mkdir(built, { recursive: true })
await fs.mkdir(out, { recursive: true })

const injected = `
import {runEditorTool as probeRun} from './ai/editor-tools';
import {buildContext as probeContext} from './ai/context';
import {dataLayerListFiles as probeFiles} from './engine/datalayer';
import {setThreeWorker as probeWorker} from './three/client';
import {setLibraryBytes as probeLibrary} from './ai/library-bytes';
import {materialFile as probeMaterial} from './three/materials';
probeWorker(()=>fetch('/assets/model-worker.js').then(r=>r.text()));
probeLibrary({material:async(name,map)=>new Uint8Array(await fetch('/assets/'+probeMaterial(name,map)).then(r=>r.arrayBuffer())),sound:async()=>{throw new Error('No sound requested in this model benchmark.')}});
window.__modelProbe={run:(name,args)=>probeRun(name,args,new AbortController().signal),context:async()=>probeContext(null,null,await probeFiles())};
`
if (!values['skip-build']) {
  const baselinePlugin = {
    name: 'model-baseline', enforce: 'pre',
    load(id) {
      const relative = path.relative(repo, id).split(path.sep).join('/')
      if (variant === 'baseline' && replaced.has(relative)) return previous(relative)
    },
    transform(code, id) { if (id === path.join(repo, 'packages/ui/src/main-embed.tsx')) return code + injected }
  }
  await viteBuild({ configFile: path.join(repo, 'packages/ui/vite.config.ts'), plugins: [baselinePlugin],
    build: { outDir: path.join(built, 'ui'), emptyOutDir: true }, logLevel: 'warn' })
  const sourcePlugin = { name: 'model-baseline', setup(builder) {
    builder.onLoad({ filter: /\.(ts|tsx)$/ }, async ({ path: file }) => {
      const relative = path.relative(repo, file).split(path.sep).join('/')
      const policy = relative === 'packages/contract/src/assistant.ts'
      const overrideEffort = policy && values.effort !== undefined
      const useBaseline = variant === 'baseline' && replaced.has(relative)
      if (!useBaseline && !overrideEffort) return undefined
      let contents = useBaseline ? previous(relative) : await fs.readFile(file, 'utf8')
      if (relative === 'packages/service/src/adapters/skills.ts') contents = contents.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href))
      if (overrideEffort) {
        const declaration = /export const ASSISTANT_EFFORT = '[^']+'/g
        if ([...contents.matchAll(declaration)].length !== 1) throw new Error('Cannot override benchmark effort')
        contents = contents.replace(declaration, `export const ASSISTANT_EFFORT = '${values.effort}'`)
      }
      return { contents, loader: file.endsWith('tsx') ? 'tsx' : 'ts' }
    })
  } }
  await bundle({ entryPoints: [path.join(repo, 'packages/ui/src/three/worker.ts')], bundle: true, format: 'iife',
    outfile: path.join(built, 'ui/assets/model-worker.js'), plugins: [sourcePlugin] })
  await fs.cp(path.join(repo, 'packages/ui/src/three/materials'), path.join(built, 'ui/assets/materials'), { recursive: true })
  await bundle({ entryPoints: [path.join(repo, 'packages/web/validate/model-agent-turn.ts')], bundle: true, format: 'esm',
    platform: 'node', packages: 'external', outfile: path.join(built, 'turn.mjs'), plugins: [sourcePlugin, {
      name: 'packaged-resources', setup(builder) {
        builder.onLoad({ filter: /\/(skills|thumbnail)\.ts$/ }, async ({ path: file }) => ({
          contents: (await fs.readFile(file, 'utf8')).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href)), loader: 'ts'
        }))
      }
    }] })
}
if (values['build-only']) process.exit(0)

const children = new Set()
const logs = []
function start(command, args, cwd, logFile) {
  const stream = fs.open(logFile, 'w').then((file) => file.createWriteStream())
  logs.push(stream)
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  children.add(child)
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (chunk) => { void stream.then((output) => output.write(chunk)) })
  child.once('exit', () => children.delete(child))
  return child
}
function stop(child) {
  if (child.exitCode !== null) return
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM') } catch { child.kill() }
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}: ${url}`)
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Server did not start: ${url}`)
}
async function serverArgs(cli, port, dataLayer = false) {
  const source = await fs.readFile(path.join(path.dirname(cli), 'commands/start/index.js'), 'utf8')
  return [cli, 'start', '--port', String(port), '--no-browser', '--bevy-web',
    ...(source.includes("'--no-client'") ? ['--no-client'] : []), ...(dataLayer ? ['--data-layer'] : [])]
}
const port = 3021, scenePort = 8024, systemPort = 8025
const engine = path.join(repo, 'node_modules/@dcl-regenesislabs/bevy-explorer-web')
let browser, page, server
try {
  server = await serveBevyWeb(engine, path.join(built, 'ui'), port)
  if (!server) throw new Error(`Benchmark port ${port} is already in use.`)
  const systemCli = path.join(path.dirname(require.resolve('@dcl/sdk-commands/package.json', { paths: [path.join(repo, 'packages/scene')] })), 'dist/index.js')
  const systemServer = start(process.execPath, await serverArgs(systemCli, systemPort), path.join(repo, 'packages/scene'), path.join(out, 'system.log'))
  await ready(`http://127.0.0.1:${systemPort}/about`, systemServer)
  browser = await chromium.connectOverCDP(values.cdp)
  for (const name of chosen) {
    const resultDir = path.join(out, name)
    const project = path.join(resultDir, 'project')
    // Never overwrite an earlier result or a user project.
    await fs.mkdir(resultDir)
    await fs.mkdir(project)
    await fs.mkdir(path.join(project, 'src'))
    await fs.mkdir(path.join(project, 'assets/scene'), { recursive: true })
    for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) await fs.copyFile(path.join(sdk, file), path.join(project, file))
    await fs.cp(path.join(sdk, 'vendor'), path.join(project, 'vendor'), { recursive: true })
    // The SDK uses lstat on node_modules and reinstalls if the directory itself is a link.
    await fs.mkdir(path.join(project, 'node_modules'))
    for (const entry of await fs.readdir(path.join(sdk, 'node_modules'))) {
      const source = path.join(sdk, 'node_modules', entry)
      await fs.symlink(source, path.join(project, 'node_modules', entry), (await fs.stat(source)).isDirectory() ? 'dir' : 'file')
    }
    const scene = JSON.parse(await fs.readFile(path.join(sdk, 'scene.json'), 'utf8'))
    scene.display.title = `${variant} ${name}`
    await fs.writeFile(path.join(project, 'scene.json'), JSON.stringify(scene))
    await fs.copyFile(path.join(repo, 'packages/desktop/templates/blank/assets/scene/main.composite'), path.join(project, 'assets/scene/main.composite'))
    await fs.writeFile(path.join(project, 'src/index.ts'), `import {engine,Transform,MeshRenderer,MeshCollider,Material} from '@dcl/sdk/ecs';
export function main(){const e=engine.addEntity();Transform.create(e,{position:{x:16,y:-0.1,z:16},scale:{x:31.5,y:0.2,z:31.5}});MeshRenderer.setBox(e);MeshCollider.setBox(e);Material.setPbrMaterial(e,{albedoColor:{r:0.45,g:0.45,b:0.45,a:1},roughness:1,metallic:0});}`)
    const sceneCli = path.join(sdk, 'node_modules/@dcl/sdk-commands/dist/index.js')
    const sceneServer = start(process.execPath, await serverArgs(sceneCli, scenePort, true), project, path.join(resultDir, 'scene.log'))
    await ready(`http://127.0.0.1:${scenePort}/about`, sceneServer)
    if (!(await fs.lstat(path.join(project, 'node_modules/@dcl'))).isSymbolicLink()) throw new Error('The SDK replaced the benchmark dependency links.')
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const url = `http://127.0.0.1:${port}/editor-app.html?realm=http://127.0.0.1:${scenePort}&systemScene=http://127.0.0.1:${systemPort}&position=0,0&editorDebug`
    page.on('pageerror', (error) => console.warn(`page: ${error.message.slice(0, 300)}`))
    page.on('console', (message) => {
      if (message.text().includes('[crash watchdog]')) console.warn(`engine: ${message.text().slice(0, 500)}`)
    })
    await page.goto(url)
    await page.waitForFunction(() => window.__eui?.status === 'ready' && window.__modelProbe, null, { timeout: 180000 })
    for (const log of [path.join(out, 'system.log'), path.join(resultDir, 'scene.log')]) {
      if (/Desktop client:|Decentraland Desktop Client failed/.test(await fs.readFile(log, 'utf8'))) {
        throw new Error(`The SDK attempted a native Explorer launch: ${log}`)
      }
    }
    const spec = cases[name]
    const method = values.source === 'code' ? 'Build it in code and place it' : values.source === 'catalog' ? 'Use an existing catalog model and place it' : 'Place it'
    const config = { auth: path.resolve(values.auth), cdp: values.cdp, url, out: resultDir, variant, source: values.source, timeoutMs: 240000,
      prompt: `${spec.prompt} ${method} at x=16, y=0, z=16. Make the decisions yourself.` }
    const configFile = path.join(resultDir, 'config.json')
    await fs.writeFile(configFile, JSON.stringify(config))
    console.log(`START ${variant} ${name}`)
    const turn = start(process.execPath, [path.join(built, 'turn.mjs'), configFile], repo, path.join(resultDir, 'agent.log'))
    const code = await new Promise((resolve) => turn.once('exit', resolve))
    const capture = async (file) => {
      await page.evaluate(({ camera, target }) => {
        const ch = new BroadcastChannel('dcl-editor-bus')
        for (const msg of [{ type: 'set-selection', selected: [], active: null }, { type: 'camera-hold' },
          { type: 'camera-pose', position: { x: camera[0], y: camera[1], z: camera[2] }, lookAt: { x: target[0], y: target[1], z: target[2] } }]) ch.postMessage({ to: 'scene', msg })
        ch.close()
      }, spec)
      await page.waitForTimeout(1200)
      await page.screenshot({ path: file, timeout: 20000 })
    }
    await capture(path.join(resultDir, 'bevy.png'))
    const frames = await page.evaluate(async () => {
      const engineWindow = document.querySelector('#editor-ui-host').shadowRoot.querySelector('iframe').contentWindow
      const original = engineWindow.__engineHeartbeat
      if (typeof original !== 'function') return null
      const stamps = []
      const counted = function (...args) { stamps.push(engineWindow.performance.now()); return original.apply(this, args) }
      engineWindow.__engineHeartbeat = counted
      try { await new Promise((resolve) => setTimeout(resolve, 5000)) }
      finally { if (engineWindow.__engineHeartbeat === counted) engineWindow.__engineHeartbeat = original }
      const gaps = stamps.slice(1).map((time, index) => time - stamps[index]).sort((a, b) => a - b)
      return { samples: gaps.length, frameMs: gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length, p95Ms: gaps[Math.floor(gaps.length * 0.95)] }
    })
    await fs.writeFile(path.join(resultDir, 'frames.json'), JSON.stringify(frames, null, 2))
    await fs.writeFile(path.join(resultDir, 'revision.json'), JSON.stringify({ baseline: baseRef, variant, assistantExitCode: code }))
    if (code !== 0) process.exitCode = 1
    console.log(`FINISH ${variant} ${name}: assistant exit ${code}`)
    if (code === 0 && values['follow-up']) {
      const revision = path.join(resultDir, 'revision')
      await fs.mkdir(revision)
      const revisionConfig = path.join(revision, 'config.json')
      await fs.writeFile(revisionConfig, JSON.stringify({ ...config, out: revision, prompt: values['follow-up'] }))
      console.log(`START ${variant} ${name} revision`)
      const revise = start(process.execPath, [path.join(built, 'turn.mjs'), revisionConfig], repo, path.join(revision, 'agent.log'))
      const reviseCode = await new Promise((resolve) => revise.once('exit', resolve))
      await capture(path.join(revision, 'bevy.png'))
      if (reviseCode !== 0) process.exitCode = 1
      console.log(`FINISH ${variant} ${name} revision: assistant exit ${reviseCode}`)
    }
    await page.close()
    page = undefined
    stop(sceneServer)
    await new Promise((resolve) => sceneServer.exitCode !== null ? resolve() : sceneServer.once('exit', resolve))
  }
} finally {
  if (page) await page.close()
  if (browser) await browser.close()
  server?.close()
  for (const child of children) stop(child)
  for (const stream of logs) (await stream).end()
}
