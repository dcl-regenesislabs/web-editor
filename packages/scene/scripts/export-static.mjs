// Builds the editor scene and exports it as the static realm a host page spawns it from:
//   <out>/about    names the scene entity
//   <out>/<hash>   the entity and each content file, named by content hash
//
//   node scripts/export-static.mjs [--out <dir>]
//
// `about` names no host: the page stages the entity's files itself and serves them from its own
// realm, so one export works from any origin, port or CDN directory.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


const sceneDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const sdkCommands = path.join(path.dirname(require.resolve('@dcl/sdk-commands/package.json')), 'dist/index.js')

function arg(name) {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

function fail(message) {
  console.error(`export-static: ${message}`)
  process.exit(1)
}

function sdk(...args) {
  const run = spawnSync(process.execPath, [sdkCommands, ...args], {
    cwd: sceneDir,
    stdio: 'inherit',
    env: { ...process.env, DCL_DISABLE_ANALYTICS: 'true' }
  })
  if (run.status !== 0) fail(`sdk-commands ${args[0]} exited with ${run.status}`)
}

if (arg('--editor-base') !== undefined || process.env.EDITOR_BASE_URL !== undefined) {
  console.warn('export-static: --editor-base / EDITOR_BASE_URL is ignored, the export no longer names a host')
}
const out = path.resolve(arg('--out') ?? path.join(sceneDir, '../web/dist/scene'))

sdk('build', '--production', '--skip-install')
rmSync(out, { recursive: true, force: true })
// a fixed timestamp: the entity id then depends on the content alone
sdk('export-static', '--destination', out, '--timestamp', '1970-01-01T00:00:00Z')

function readEntity(file) {
  try {
    const json = JSON.parse(readFileSync(path.join(out, file), 'utf8'))
    return json?.type === 'scene' && json.version === 'v3' && Array.isArray(json.content) ? json : null
  } catch {
    return null
  }
}
const entityIds = readdirSync(out).filter((file) => readEntity(file) !== null)
if (entityIds.length !== 1) fail(`expected one scene entity in the export, found ${entityIds.length}`)
const [entityId] = entityIds
// no content url on purpose: an engine pointed straight at this realm fails instead of
// fetching the scene from a catalyst
const about = {
  healthy: true,
  acceptingUsers: true,
  configurations: { networkId: 0, globalScenesUrn: [], scenesUrn: [`urn:decentraland:entity:${entityId}`], realmName: 'editor-scene' },
  comms: { healthy: true, protocol: 'v3', fixedAdapter: 'offline:offline' }
}
writeFileSync(path.join(out, 'about'), JSON.stringify(about, null, 2))

const entity = readEntity(entityId)
const missing = entity.content.filter((c) => !existsSync(path.join(out, c.hash)))
if (missing.length > 0) fail(`content missing from the export: ${missing.map((c) => c.file).join(', ')}`)
// unpkg, which the explorer loads the package from, answers 500 for an empty file, and one
// failed file keeps the editor scene from spawning
const empty = entity.content.filter((c) => statSync(path.join(out, c.hash)).size === 0)
if (empty.length > 0) fail(`empty files in the export (add them to .dclignore): ${empty.map((c) => c.file).join(', ')}`)
if (!entity.content.some((c) => c.file === entity.metadata.main)) fail(`the entity has no ${entity.metadata.main}`)

console.log(`\neditor scene ${entityId}`)
for (const c of entity.content) console.log(`  ${c.hash}  ${c.file}`)
console.log(`  ${readdirSync(out).length} files in ${out}`)
