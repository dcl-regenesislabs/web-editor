import { createLogComponent } from '@well-known-components/logger'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountPool } from '../ai/accounts.ts'
import { createOperations } from '../ai/operations.ts'
import { ACCESS_AUD, ACCESS_TEAM, accessKeyPair, accessToken } from '../testing/access.ts'
import { createTestService } from '../testing/components.ts'
import { createAccessVerifier } from './access.ts'
import { adminAccessFromConfig, createAdminComponent } from './admin.ts'
import type { AdminStatus } from './admin.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop() })

const key = accessKeyPair('k1')
const now = Date.now()
const BASE = 'https://editor.example/svc'

async function admin(fetchKeys = async () => [key.jwk], accounts?: Awaited<ReturnType<typeof createAccountPool>>) {
  const logs = await createLogComponent({ config: createConfigComponent({ LOG_LEVEL: 'OFF' }) })
  const operations = createOperations()
  const component = createAdminComponent({ logs }, {
    accounts,
    access: { kind: 'cloudflare-access', verifier: createAccessVerifier({ teamDomain: ACCESS_TEAM, audience: ACCESS_AUD, fetchKeys }) },
    basePath: '/svc', version: 'v1', historyUrl: 'https://reports.example/assistant', operations,
    allowance: async () => ({ dailyPercent: 12.5, weeklyPercent: 3, dailyResetAt: '', weeklyResetAt: '' })
  })
  return { component, operations }
}

describe('admin dashboard access', () => {
  it('serves the page and status to a listed admin, through the edge header or the cookie alone', async () => {
    const { component, operations } = await admin()
    operations.openSession('0x' + 'a'.repeat(40)).turnStarted()
    const token = accessToken(key.privateKey, 'k1', now)
    const viaEdge = await component.handle(new Request(`${BASE}/admin/api/status`, { headers: { 'cf-access-jwt-assertion': token } }))
    expect(viaEdge?.status).toBe(200)
    expect(viaEdge?.headers.get('cache-control')).toBe('no-store')
    const status = await viaEdge?.json() as AdminStatus
    expect(status).toMatchObject({ sessions: 1, version: 'v1', historyUrl: 'https://reports.example/assistant', quota: { state: 'disabled' }, telemetry: { enabled: false } })
    expect(status.turns).toHaveLength(1)
    expect(status.users).toMatchObject([{ wallet: '0x' + 'a'.repeat(40), prompts: 1, sessions: 1, running: 1 }])
    expect(status.users[0].allowance).toEqual({ dailyPercent: 12.5, weeklyPercent: 3 })
    const direct = await component.handle(new Request(`${BASE}/admin/`, { headers: { cookie: `other=1; CF_Authorization=${token}` } }))
    expect(direct?.status).toBe(200)
    expect(direct?.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(await direct?.text()).toContain('<script src="dashboard.js" defer>')
    expect((await component.handle(new Request(`${BASE}/admin`, { headers: { cookie: `CF_Authorization=${token}` } })))?.status).toBe(308)
  })

  it('refuses a missing or unverifiable token, or one with no person, and anything but reads', async () => {
    const { component } = await admin()
    const tokens = [
      undefined,
      accessToken(accessKeyPair('k1').privateKey, 'k1', now),
      accessToken(key.privateKey, 'k1', now, { email: undefined, common_name: 'service-token' })
    ]
    for (const token of tokens) {
      const response = await component.handle(new Request(`${BASE}/admin/api/status`, { headers: token === undefined ? {} : { 'cf-access-jwt-assertion': token } }))
      expect(response?.status).toBe(401)
      expect(await response?.json()).toEqual({ error: 'access-required' })
    }
    const post = await component.handle(new Request(`${BASE}/admin/api/status`, { method: 'POST', headers: { 'cf-access-jwt-assertion': accessToken(key.privateKey, 'k1', now) } }))
    expect(post?.status).toBe(405)
    expect(await component.handle(new Request(`${BASE}/projects`))).toBeNull()
  })

  it('denies with 503 while the signing keys cannot be fetched', async () => {
    const { component } = await admin(async () => { throw new Error('certs down') })
    const response = await component.handle(new Request(`${BASE}/admin/api/status`, { headers: { 'cf-access-jwt-assertion': accessToken(key.privateKey, 'k1', now) } }))
    expect(response?.status).toBe(503)
  })

  it('stays off until fully configured, and keeps the no-sign-in mode on loopback outside production', () => {
    expect(adminAccessFromConfig({ production: true })).toBeNull()
    expect(() => adminAccessFromConfig({ teamDomain: 'regenesis', production: true })).toThrow('both')
    expect(adminAccessFromConfig({ teamDomain: 'regenesis', audience: 'aud', production: true })).toMatchObject({ kind: 'cloudflare-access' })
    expect(() => adminAccessFromConfig({ local: '1', host: '127.0.0.1', production: true })).toThrow('production')
    expect(() => adminAccessFromConfig({ local: '1', host: '0.0.0.0', production: false })).toThrow('loopback')
  })

  it('is not served by the running service until configured', async () => {
    const off = await createTestService()
    cleanup.push(off.stop)
    expect((await fetch(`${off.base}/admin/api/status`)).status).toBe(404)
    const local = await createTestService({ vars: { ADMIN_LOCAL: '1' } })
    cleanup.push(local.stop)
    const response = await fetch(`${local.base}/admin/api/status`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sessions: 0, turns: [] })
    expect((await fetch(`${local.base}/admin/dashboard.js`)).headers.get('content-type')).toContain('javascript')
  })
})

describe('Claude accounts from the dashboard', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'admin-accounts-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const accounts = await createAccountPool({ primaryPath: join(dir, '.auth.json'), dir: join(dir, 'claude-accounts') })
    const { component } = await admin(undefined, accounts)
    const signedIn = { 'cf-access-jwt-assertion': accessToken(key.privateKey, 'k1', now) }
    const add = (headers: Record<string, string>, body: unknown = { label: 'Team 2', token: 'sk-ant-oat-second-secret' }) => {
      const text = JSON.stringify(body)
      return component.handle(new Request(`${BASE}/admin/api/accounts`, {
        method: 'POST', headers: { ...signedIn, 'content-length': String(text.length), ...headers }, body: text
      }))
    }
    return { component, accounts, signedIn, add }
  }
  const page = { origin: 'https://editor.example', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }

  it('adds an account from the page and shows it without its token', async () => {
    const { component, signedIn, add } = await setup()
    const response = await add(page)
    expect(response?.status).toBe(201)
    const status = await (await component.handle(new Request(`${BASE}/admin/api/status`, { headers: signedIn })))?.text() ?? ''
    expect(JSON.parse(status).accounts).toMatchObject([{ id: 'primary', state: 'signed-out' }, { label: 'Team 2', state: 'ready', hint: 'cret', removable: true }])
    expect(status).not.toContain('sk-ant-oat')
  })

  it('refuses writes from another site, without sign-in, or that are not a setup token', async () => {
    const { add, accounts } = await setup()
    expect((await add({ ...page, 'sec-fetch-site': 'cross-site' }))?.status).toBe(403)
    expect((await add({ ...page, origin: 'https://evil.example' }))?.status).toBe(403)
    expect((await add({ ...page, 'content-type': 'text/plain' }))?.status).toBe(415)
    expect(await (await add(page, { label: 'x', token: 'sk-live-123' }))?.json()).toEqual({ error: 'invalid-token' })
    expect((await add({ ...page, 'cf-access-jwt-assertion': '' }))?.status).toBe(401)
    expect(await accounts.list()).toHaveLength(1)
  })
})
