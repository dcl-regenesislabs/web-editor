import { dirname, join, resolve, sep } from 'node:path'
import { createServerComponent, createStatusCheckComponent, instrumentHttpServerWithPromClientRegistry } from '@dcl/http-server'
import { createMetricsComponent } from '@dcl/metrics'
import { createLogComponent } from '@well-known-components/logger'
import type { IConfigComponent } from '@well-known-components/interfaces'
import { createServiceConfig } from './adapters/config.ts'
import { createProjectStorageComponent } from './adapters/project-storage.ts'
import { createPurgeJobComponent } from './adapters/purge-job.ts'
import { createSkillsComponent } from './adapters/skills.ts'
import { createTelemetryComponent } from './adapters/telemetry.ts'
import { adminAccessFromConfig, createAdminComponent } from './admin/admin.ts'
import { createAssistantComponent, DEFAULT_ASSISTANT_LIMITS } from './ai/server.ts'
import type { AssistantLimits } from './ai/server.ts'
import { createAccountPool } from './ai/accounts.ts'
import type { AccountPool } from './ai/accounts.ts'
import { DISABLED_QUOTA } from './ai/quota.ts'
import { createAssistantMemory } from './ai/memory.ts'
import { createSessionLog, DEFAULT_SESSION_LOG_LIMITS } from './ai/session-log.ts'
import { createUsageMeter, DEFAULT_USAGE_LIMITS } from './ai/usage.ts'
import { ASSISTANT_MODEL, createPiFactory, DEFAULT_COMPACT_AT_TOKENS, MIN_COMPACT_AT_TOKENS } from './ai/pi.ts'
import { codexTokenSource, createCodexImageProvider } from './ai/images.ts'
import type { AgentFactory } from './ai/types.ts'
import { createRateLimiter, createUploadGate, envFromConfig, DEFAULT_LIMITS, walletAllowlist } from './config.ts'
import { createQuotaStore } from './quota-store.ts'
import { createPoolComponent } from './pool/component.ts'
import { createFsStore } from './fs-store.ts'
import { metricDeclarations } from './metrics.ts'
import { createLock } from './store.ts'
import type { BlobStore } from './store.ts'
import type { AppComponents, GlobalContext } from './types.ts'

export interface ComponentOptions {
  config?: IConfigComponent
  store?: BlobStore
  agentFactory?: AgentFactory
}

async function assistantLimits(config: IConfigComponent, enabled: boolean): Promise<AssistantLimits> {
  const listed = (await config.getString('ASSISTANT_WALLETS'))?.trim()
  // an open assistant spends the owner's credential on any free wallet, so production must choose
  if (enabled && process.env.NODE_ENV === 'production' && !listed) {
    throw new Error('ASSISTANT_WALLETS must list the wallets that may use the assistant (or be * for any)')
  }
  const count = async (name: string, fallback: number) => {
    const value = await config.getNumber(name)
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
    return value
  }
  return {
    wallets: walletAllowlist(listed, 'ASSISTANT_WALLETS'),
    turnsPerMinute: await count('ASSISTANT_TURNS_PER_MINUTE', DEFAULT_ASSISTANT_LIMITS.turnsPerMinute),
    turnsPerDay: await count('ASSISTANT_TURNS_PER_DAY', DEFAULT_ASSISTANT_LIMITS.turnsPerDay),
    turnsPerIpPerDay: await count('ASSISTANT_TURNS_PER_IP_PER_DAY', DEFAULT_ASSISTANT_LIMITS.turnsPerIpPerDay),
    turnsPerDayTotal: await count('ASSISTANT_TURNS_PER_DAY_TOTAL', DEFAULT_ASSISTANT_LIMITS.turnsPerDayTotal),
    turnsAtOnce: await count('ASSISTANT_TURNS_AT_ONCE', DEFAULT_ASSISTANT_LIMITS.turnsAtOnce),
    imagesPerDay: await count('ASSISTANT_IMAGES_PER_DAY', DEFAULT_ASSISTANT_LIMITS.imagesPerDay)
  }
}

export async function initComponents(options: ComponentOptions = {}): Promise<AppComponents> {
  const config = options.config ?? await createServiceConfig()
  const rawStore = options.store ?? createFsStore(await config.requireString('STORAGE_DIR'))
  const env = await envFromConfig(config, rawStore)
  const store = await createQuotaStore(rawStore, { ...DEFAULT_LIMITS, ...env.limits })
  env.store = store
  env.rateLimiter = createRateLimiter()
  env.uploads = createUploadGate()
  env.lock = createLock()
  const setupToken = await config.getString('ANTHROPIC_OAUTH_SETUP_TOKEN')
  const skills = await createSkillsComponent()
  const authPath = await config.getString('AI_AUTH_PATH') ??
    (setupToken === undefined ? undefined : join(await config.requireString('STORAGE_DIR'), '..', '.assistant', '.auth.json'))
  const limits = await assistantLimits(config, options.agentFactory !== undefined || authPath !== undefined)
  const imageAuthPath = await config.getString('AI_IMAGE_AUTH_PATH')
  const storageDir = await config.getString('STORAGE_DIR')
  const inStorage = (path: string | undefined) => path !== undefined && storageDir !== undefined &&
    (resolve(path) === resolve(storageDir) || resolve(path).startsWith(resolve(storageDir) + sep))
  const authInStorage = inStorage(authPath)
  const imageAuthInStorage = inStorage(imageAuthPath)
  if (process.env.NODE_ENV === 'production') {
    if (env.publicUrl === undefined) throw new Error('PUBLIC_URL must be set in production, or upload urls echo the request Host header')
    if (!(await config.getString('WKC_METRICS_BEARER_TOKEN'))) throw new Error('WKC_METRICS_BEARER_TOKEN must be set in production, or /metrics is public')
    if (!(await config.getString('STORAGE_WALLETS'))?.trim()) throw new Error('STORAGE_WALLETS must list allowed wallets, or * for public storage')
    const publicUrl = new URL(env.publicUrl)
    if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash ||
      publicUrl.pathname.replace(/\/$/, '') !== (env.basePath ?? '')) throw new Error('PUBLIC_URL must be HTTPS and match BASE_PATH')
    if (env.allowedOrigins.some((origin) => !origin.startsWith('https://'))) throw new Error('ALLOWED_ORIGINS must use HTTPS in production')
    if (authInStorage) throw new Error('AI_AUTH_PATH must be outside STORAGE_DIR in production')
    if (imageAuthInStorage) throw new Error('AI_IMAGE_AUTH_PATH must be outside STORAGE_DIR in production')
  }
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ config, metrics })
  if (authInStorage) {
    logs.getLogger('assistant').warn('The assistant credential is inside STORAGE_DIR; set AI_AUTH_PATH to a secret mount outside it')
  }
  if (process.env.NODE_ENV === 'production' && env.clientIpHeader === undefined) {
    logs.getLogger('service').warn('CLIENT_IP_HEADER is unset: behind a reverse proxy every client shares one address, so per-IP limits are off')
  }
  if (imageAuthInStorage) {
    logs.getLogger('assistant').warn('The image model credential is inside STORAGE_DIR; set AI_IMAGE_AUTH_PATH to a secret mount outside it')
  }
  const usage = authPath === undefined ? undefined : createUsageMeter(join(dirname(authPath), 'usage'), {
    daily: (await config.getNumber('ASSISTANT_DAILY_LIMIT')) ?? DEFAULT_USAGE_LIMITS.daily,
    weekly: (await config.getNumber('ASSISTANT_WEEKLY_LIMIT')) ?? DEFAULT_USAGE_LIMITS.weekly
  })
  // the pool estimates each account's share from telemetry's spend, and telemetry reports the pool's reading
  let accounts: AccountPool | undefined
  const telemetry = await createTelemetryComponent({ config, logs }, {
    stateDir: authPath === undefined ? undefined : dirname(authPath), quota: () => accounts?.quota() ?? DISABLED_QUOTA
  })
  if (authPath !== undefined) {
    accounts = await createAccountPool({
      primaryPath: authPath, dir: join(dirname(authPath), 'claude-accounts'), logger: logs.getLogger('assistant'),
      spend: () => telemetry.operations.snapshot().sinceStart.usage.estimatedCostUsd
    })
  }
  const sessionLog = await config.getString('ASSISTANT_SESSION_LOG')
  if (sessionLog !== undefined && sessionLog !== '0' && sessionLog !== '1') throw new Error('ASSISTANT_SESSION_LOG must be 0 or 1')
  const sessionDays = (await config.getNumber('ASSISTANT_SESSION_LOG_DAYS')) ?? DEFAULT_SESSION_LOG_LIMITS.maxAgeMs / 86_400_000
  if (!Number.isSafeInteger(sessionDays) || sessionDays < 1) throw new Error('ASSISTANT_SESSION_LOG_DAYS must be a positive whole number')
  const sessions = sessionLog !== '1' || authPath === undefined ? undefined
    : createSessionLog(join(dirname(authPath), 'sessions'), { ...DEFAULT_SESSION_LOG_LIMITS, maxAgeMs: sessionDays * 86_400_000 })
  if (sessions !== undefined) {
    logs.getLogger('assistant').warn(`ASSISTANT_SESSION_LOG is on: assistant sessions are kept in plaintext for ${sessionDays} days and readable at /admin/`)
  }
  const compactAt = (await config.getNumber('ASSISTANT_COMPACT_AT_TOKENS')) ?? DEFAULT_COMPACT_AT_TOKENS
  // below this the system prompt and one file read would trigger a summary on nearly every call
  if (!Number.isSafeInteger(compactAt) || (compactAt !== 0 && compactAt < MIN_COMPACT_AT_TOKENS)) {
    throw new Error(`ASSISTANT_COMPACT_AT_TOKENS must be 0 or a whole number of at least ${MIN_COMPACT_AT_TOKENS}`)
  }
  const factory = options.agentFactory ?? (authPath === undefined ? undefined :
    await createPiFactory(authPath, (await config.getString('AI_MODEL')) ?? ASSISTANT_MODEL, setupToken, skills,
      logs.getLogger('assistant'), accounts, compactAt))
  const pool = await createPoolComponent({ config, logs })
  env.pool = pool.service
  const poolService = pool.service
  const admin = createAdminComponent({ logs }, {
    access: adminAccessFromConfig({
      teamDomain: await config.getString('CF_ACCESS_TEAM_DOMAIN'),
      audience: await config.getString('CF_ACCESS_AUD'),
      local: await config.getString('ADMIN_LOCAL'),
      host: await config.getString('HTTP_SERVER_HOST'),
      production: process.env.NODE_ENV === 'production'
    }),
    basePath: env.basePath, version: env.version, historyUrl: telemetry.historyUrl,
    operations: telemetry.operations, quota: telemetry.quota, telemetry: telemetry.delivery, accounts,
    allowance: usage === undefined ? undefined : async (wallet) => usage.forWallet(wallet).balance(),
    pool: poolService === undefined ? undefined : () => poolService.status(),
    sessions
  })
  const drainSeconds = (await config.getNumber('ASSISTANT_DRAIN_SECONDS')) ?? 600
  if (!Number.isSafeInteger(drainSeconds) || drainSeconds < 0) throw new Error('ASSISTANT_DRAIN_SECONDS must be a whole number of seconds')
  const assistant = createAssistantComponent({ logs }, {
    factory, allowedOrigins: env.allowedOrigins, basePath: env.basePath,
    limits, operations: telemetry.operations, drainMs: drainSeconds * 1000,
    // beside the credential, outside STORAGE_DIR and its project backups
    memory: authPath === undefined ? undefined : createAssistantMemory(join(dirname(authPath), 'memory')),
    sessions,
    countsPath: authPath === undefined ? undefined : join(dirname(authPath), 'prompt-counts.json'),
    usage,
    // one image counts 1, so the meter's daily limit is the image cap
    images: imageAuthPath === undefined ? undefined : {
      provider: createCodexImageProvider({ token: await codexTokenSource(imageAuthPath) }),
      usage: createUsageMeter(join(dirname(imageAuthPath), 'image-usage'), { daily: limits.imagesPerDay, weekly: limits.imagesPerDay * 7 })
    }
  })
  const server = await createServerComponent<GlobalContext>({ config, logs, ws: assistant.ws }, {})
  if (!metrics.registry) throw new Error('Metrics registry is not initialized')
  await instrumentHttpServerWithPromClientRegistry({ config, metrics, server, registry: metrics.registry })
  const statusChecks = await createStatusCheckComponent({ server, config })
  const projectStorage = createProjectStorageComponent({ assistant, logs }, env)
  const purgeJob = createPurgeJobComponent({ projectStorage, logs })

  // Stop WebSockets before the HTTP listener, then drain the purge job before storage; telemetry
  // stops after the assistant so the last turns' events are queued.
  return { config, logs, metrics, store, skills, telemetry, admin, projectStorage, purgeJob, pool, server, statusChecks, assistant }
}
