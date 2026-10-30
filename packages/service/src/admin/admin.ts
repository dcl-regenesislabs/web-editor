import { readFileSync } from 'node:fs'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { DISABLED_DELIVERY } from '../ai/analytics.ts'
import type { DeliveryHealth } from '../ai/analytics.ts'
import { createOperations } from '../ai/operations.ts'
import type { Operations, OperationsSnapshot, UserActivity } from '../ai/operations.ts'
import { DISABLED_QUOTA } from '../ai/quota.ts'
import type { QuotaView } from '../ai/quota.ts'
import { createAccessVerifier } from './access.ts'
import type { PoolStatus } from '../pool/pool.ts'
import type { AccessVerifier } from './access.ts'

const asset = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
const PAGE = asset('dashboard.html')
const SCRIPT = asset('dashboard.js')
const STYLE = asset('dashboard.css')

/** The service's own per-wallet allowance (ASSISTANT_DAILY_LIMIT / _WEEKLY_LIMIT), not the provider plan. */
export interface Allowance {
  dailyPercent: number
  weeklyPercent: number
}

export interface AdminStatus extends Omit<OperationsSnapshot, 'users'> {
  users: Array<UserActivity & { allowance: Allowance | null }>
  now: string
  version: string | null
  quota: QuotaView
  telemetry: DeliveryHealth
  historyUrl: string | null
  /** Shared worlds; null while the pool is off or could not be read. */
  pool: PoolStatus | null
}

export interface AdminComponent {
  /** null when the request is not an admin path. */
  handle(request: Request): Promise<Response | null>
}

export type AdminAccess =
  | { kind: 'cloudflare-access'; verifier: AccessVerifier }
  /** Loopback development only: no sign-in. */
  | { kind: 'local' }

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
}

function respond(status: number, body: string, type: string): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, 'content-type': type } })
}

const json = (status: number, value: unknown) => respond(status, JSON.stringify(value), 'application/json')

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=') || undefined
  }
  return undefined
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** Admin is off until Cloudflare Access and the admin list are both configured. */
export function adminAccessFromConfig(vars: {
  teamDomain?: string; audience?: string; local?: string; host?: string; production: boolean
}): AdminAccess | null {
  const { teamDomain, audience } = vars
  if (vars.local === '1') {
    if (vars.production) throw new Error('ADMIN_LOCAL must not be set in production')
    if (!LOOPBACK.has(vars.host ?? '')) throw new Error('ADMIN_LOCAL needs HTTP_SERVER_HOST on loopback')
    return { kind: 'local' }
  }
  if (!teamDomain && !audience) return null
  if (!teamDomain || !audience) {
    throw new Error('Set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD to enable /admin/')
  }
  if (!/^[a-z0-9-]+$/i.test(teamDomain)) throw new Error('CF_ACCESS_TEAM_DOMAIN is the team slug before .cloudflareaccess.com')
  return { kind: 'cloudflare-access', verifier: createAccessVerifier({ teamDomain, audience }) }
}

export function createAdminComponent({ logs }: { logs: ILoggerComponent }, options: {
  access: AdminAccess | null
  basePath?: string
  version?: string
  historyUrl?: string
  operations?: Operations
  quota?: () => QuotaView
  telemetry?: () => DeliveryHealth
  allowance?: (wallet: string) => Promise<Allowance>
  pool?: () => Promise<PoolStatus>
}): AdminComponent {
  const logger = logs.getLogger('admin')
  const root = `${options.basePath ?? ''}/admin`
  const operations = options.operations ?? createOperations()

  async function allowed(request: Request): Promise<boolean | 'unavailable'> {
    const access = options.access
    if (access === null) return false
    if (access.kind === 'local') return true
    // Cloudflare adds the header at its edge; the cookie covers a request that reached the origin directly
    const token = request.headers.get('cf-access-jwt-assertion') ?? cookie(request, 'CF_Authorization')
    if (token === undefined || token === '') return false
    try {
      const email = await access.verifier.verify(token)
      // the Access application's policy is the admin list: a person it let in holds a token for this audience
      return email !== undefined
    } catch {
      logger.error('Cloudflare Access keys could not be fetched')
      return 'unavailable'
    }
  }

  async function status(): Promise<AdminStatus> {
    const snapshot = operations.snapshot()
    const users = await Promise.all(snapshot.users.map(async (user) => {
      const allowance = options.allowance === undefined ? null : await options.allowance(user.wallet)
        .then(({ dailyPercent, weeklyPercent }) => ({ dailyPercent, weeklyPercent }), () => null)
      return { ...user, allowance }
    }))
    return {
      ...snapshot,
      users,
      now: new Date().toISOString(),
      version: options.version ?? null,
      quota: options.quota?.() ?? DISABLED_QUOTA,
      telemetry: options.telemetry?.() ?? DISABLED_DELIVERY,
      historyUrl: options.historyUrl ?? null,
      pool: options.pool === undefined ? null : await options.pool().catch(() => {
        logger.error('Pool status could not be read')
        return null
      })
    }
  }

  return {
    async handle(request) {
      const path = new URL(request.url).pathname
      if (path !== root && !path.startsWith(`${root}/`)) return null
      if (options.access === null) return json(404, { error: 'not-found' })
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method-not-allowed' })
      const verdict = await allowed(request)
      const api = path.startsWith(`${root}/api/`)
      if (verdict === 'unavailable') return api ? json(503, { error: 'access-unavailable' }) : respond(503, 'Sign-in is unavailable. Try again shortly.', 'text/plain; charset=utf-8')
      if (!verdict) return api ? json(401, { error: 'access-required' }) : respond(401, 'Sign in through Cloudflare Access to open this page.', 'text/plain; charset=utf-8')
      if (path === root) return new Response(null, { status: 308, headers: { ...SECURITY_HEADERS, location: `${root}/` } })
      if (path === `${root}/`) return respond(200, PAGE, 'text/html; charset=utf-8')
      if (path === `${root}/dashboard.js`) return respond(200, SCRIPT, 'text/javascript; charset=utf-8')
      if (path === `${root}/dashboard.css`) return respond(200, STYLE, 'text/css; charset=utf-8')
      if (path === `${root}/api/status`) return json(200, await status())
      return json(404, { error: 'not-found' })
    }
  }
}
