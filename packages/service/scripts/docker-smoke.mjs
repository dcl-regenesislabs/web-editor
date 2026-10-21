import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { rawCid } from '../../contract/src/cid.ts'
import { createTestWallet } from '../src/testing/wallet.ts'

const image = process.argv[2] ?? 'dcl-editor-service:local'
const name = `dcl-editor-smoke-${process.pid}-${Date.now()}`
const volume = name + '-data'
const origin = 'https://editor.example'
const publicUrl = 'https://service.example/svc'
const metricsToken = 'smoke-only-metrics-token'
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 90_000 }).trim()
const address = () => `http://${docker('port', name, '8787/tcp')}`

async function ready(base) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(500) }).catch(() => null)
    if (response?.ok) return
    await setTimeout(250)
  }
  throw new Error('Container did not become ready')
}

docker('volume', 'create', volume)
try {
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::8787',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--memory', '1g', '--cpus', '2',
    '--tmpfs', '/tmp:size=64m,mode=1777,noexec,nosuid,nodev',
    '--mount', `source=${volume},target=/data`,
    '-e', `ALLOWED_ORIGINS=${origin}`,
    '-e', 'TICKET_SECRET=smoke-only-secret-smoke-only-secret',
    '-e', 'BASE_PATH=/svc',
    '-e', 'STORAGE_WALLETS=*',
    '-e', `PUBLIC_URL=${publicUrl}`,
    '-e', `WKC_METRICS_BEARER_TOKEN=${metricsToken}`, image)
  let base = address()
  await ready(base)
  assert.equal(docker('exec', name, 'id', '-u'), '1000')
  const runtime = await fetch(base + '/svc/mobile-preview/index.wasm', { method: 'HEAD' })
  assert.equal(runtime.status, 200)
  assert.equal(runtime.headers.get('content-type'), 'application/wasm')
  assert.ok(Number(runtime.headers.get('content-length')) > 0)
  assert.equal((await fetch(base + '/svc/mobile-preview/package.json')).status, 404)

  docker('exec', name, 'node', 'packages/service/scripts/healthcheck.mjs')
  docker('exec', name, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { createPiFactory } from './packages/service/src/ai/pi.ts'
    const require = createRequire(new URL('./packages/service/src/ai/pi.ts', import.meta.url))
    assert.equal(require('ws/package.json').version, require('./../../package.json').dependencies.ws)
    const factory = await createPiFactory('/tmp/synthetic-agent/.auth.json', undefined, 'sk-ant-oat-container-test-only')
    assert.equal((await factory.providers()).find(provider => provider.id === 'claude').available, true)
    const agent = await factory.create({ provider: 'claude', text: 'Never sent' }, async () => 'unused', () => {})
    await agent.abort()
    agent.dispose()
  `)
  const wallet = await createTestWallet({ origin })
  const bytes = new TextEncoder().encode('export function main() {}\n')
  const hash = await rawCid(bytes)
  const response = await wallet.signedFetch(base + '/svc/projects/proof/uploads', {
    method: 'POST', body: JSON.stringify({ files: [{ hash, size: bytes.length }] })
  })
  assert.equal(response.status, 200)
  const { uploads } = await response.json()
  assert.ok(uploads[0].url.startsWith(publicUrl + '/blobs/'))
  const { pathname, search } = new URL(uploads[0].url)
  const uploadUrl = base + pathname + search
  assert.equal((await fetch(uploadUrl, { method: 'PUT', body: bytes })).status, 201)
  assert.equal((await wallet.signedFetch(base + '/svc/projects/proof/manifest', {
    method: 'PUT',
    body: JSON.stringify({ name: 'Docker proof', baseVersion: null, files: { 'src/index.ts': { hash, size: bytes.length } } })
  })).status, 200)
  assert.equal((await fetch(base + '/svc/projects')).status, 401)
  assert.equal((await wallet.signedFetch(base + '/svc/assistant/providers')).status, 503)
  assert.equal((await fetch(base + '/metrics')).status, 401)
  assert.match(await (await fetch(base + '/metrics', { headers: { authorization: `Bearer ${metricsToken}` } })).text(), /http_requests_total/)
  docker('restart', '--time', '30', name)
  base = address()
  await ready(base)
  const file = await wallet.signedFetch(base + '/svc/projects/proof/files/' + hash)
  assert.equal(file.status, 200)
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes)
  docker('stop', '--time', '30', name)
  assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', name), '0')
  console.log('Docker smoke: PASS (restricted container, patched WebSocket, offline agent initialization, signed storage, restart persistence, shutdown)')
} finally {
  try { docker('rm', '-f', name) } finally { docker('volume', 'rm', volume) }
}
