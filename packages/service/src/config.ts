import { createLock } from './store.ts'
import type { BlobStore, Clock, Lock } from './store.ts'
import type { AssistantService } from './ai/types.ts'
import type { PoolService } from './pool/pool.ts'
import type { IConfigComponent } from '@well-known-components/interfaces'

export interface Limits {
  maxFileBytes: number
  maxProjectFiles: number
  /** Storage one wallet may hold, counted over the distinct blobs it uploaded. */
  maxWalletBytes: number
  maxProjects: number
  maxPrefabs: number
  maxStorageBytes: number
  maxStorageObjects: number
  maxSpentTickets: number
  /** Spent tickets one wallet may hold, so no single wallet fills `maxSpentTickets`. */
  maxSpentTicketsPerWallet: number
  historyVersions: number
  requestsPerMinute: number
  trashDays: number
  /** Longest remaining lifetime of a login key; must stay above what the Decentraland login issues. */
  maxDelegationDays: number
  /** Distinct blobs one wallet may hold, which bounds every listing of its markers. */
  maxWalletBlobs: number
  /** Blob uploads one wallet may have in flight at once. */
  uploadsPerWallet: number
  /** Bytes of uploads buffered at once by this process (one isolate on Workers). */
  uploadBytesInFlight: number
  /** An upload body gets this long plus its size at uploadMinBytesPerSecond before it is dropped. */
  uploadTimeoutSeconds: number
  uploadMinBytesPerSecond: number
  /** Assistant requests per wallet, counted apart from project requests. */
  assistantRequestsPerMinute: number
  /** Wallets one purge run visits; the next run carries on after the last. */
  purgeWalletsPerRun: number
  /** Shared-world requests per wallet, counted apart from project requests. */
  poolRequestsPerMinute: number
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: 50 * 1024 * 1024,
  maxProjectFiles: 2000,
  maxWalletBytes: 500 * 1024 * 1024,
  maxProjects: 100,
  maxPrefabs: 200,
  maxStorageBytes: 5 * 1024 * 1024 * 1024,
  maxStorageObjects: 100_000,
  maxSpentTickets: 50_000,
  maxSpentTicketsPerWallet: 4000,
  historyVersions: 20,
  requestsPerMinute: 1200,
  trashDays: 30,
  maxDelegationDays: 31,
  maxWalletBlobs: 20_000,
  uploadsPerWallet: 4,
  uploadBytesInFlight: 256 * 1024 * 1024,
  uploadTimeoutSeconds: 30,
  uploadMinBytesPerSecond: 64 * 1024,
  assistantRequestsPerMinute: 60,
  purgeWalletsPerRun: 20,
  poolRequestsPerMinute: 30
}

export interface RateLimiter {
  /** Count one request; answers the seconds to wait when over `limit` per minute, else 0. */
  take(key: string, now: number, limit: number): number
}

export interface Env {
  logError?: (error: unknown) => void
  assistant?: AssistantService
  pool?: PoolService
  /** The header a trusted proxy puts the client address in (nginx: X-Real-IP). */
  clientIpHeader?: string
  store: BlobStore
  /** Exact origins (`https://host[:port]`) the editor may be served from. */
  allowedOrigins: readonly string[]
  storageWallets?: ReadonlySet<string> | null
  /** Signs upload tickets. */
  ticketSecret: string
  clock?: Clock
  /** Path the service is mounted under, e.g. `/editor-projects`; signed paths include it. */
  basePath?: string
  /** Base url put in upload urls when the service cannot tell its own from the request. */
  publicUrl?: string
  /** JSON-RPC endpoint for ERC-1654 wallets; unset, they are refused. */
  ethRpcUrl?: string
  /** the release this build is, reported by /health */
  version?: string
  limits?: Partial<Limits>
  rateLimiter?: RateLimiter
  uploads?: UploadGate
  lock?: Lock
}

export type Vars = Record<string, string | undefined>

const LIMIT_VARS: Record<keyof Limits, string> = {
  maxFileBytes: 'MAX_FILE_BYTES',
  maxProjectFiles: 'MAX_PROJECT_FILES',
  maxWalletBytes: 'MAX_WALLET_BYTES',
  maxProjects: 'MAX_PROJECTS',
  maxPrefabs: 'MAX_PREFABS',
  maxStorageBytes: 'MAX_STORAGE_BYTES',
  maxStorageObjects: 'MAX_STORAGE_OBJECTS',
  maxSpentTickets: 'MAX_SPENT_TICKETS',
  maxSpentTicketsPerWallet: 'MAX_SPENT_TICKETS_PER_WALLET',
  historyVersions: 'HISTORY_VERSIONS',
  requestsPerMinute: 'REQUESTS_PER_MINUTE',
  trashDays: 'TRASH_DAYS',
  maxDelegationDays: 'MAX_DELEGATION_DAYS',
  maxWalletBlobs: 'MAX_WALLET_BLOBS',
  uploadsPerWallet: 'UPLOADS_PER_WALLET',
  uploadBytesInFlight: 'UPLOAD_BYTES_IN_FLIGHT',
  uploadTimeoutSeconds: 'UPLOAD_TIMEOUT_SECONDS',
  uploadMinBytesPerSecond: 'UPLOAD_MIN_BYTES_PER_SECOND',
  assistantRequestsPerMinute: 'ASSISTANT_REQUESTS_PER_MINUTE',
  purgeWalletsPerRun: 'PURGE_WALLETS_PER_RUN',
  poolRequestsPerMinute: 'POOL_REQUESTS_PER_MINUTE'
}

export async function envFromConfig(config: IConfigComponent, store: BlobStore): Promise<Env> {
  const names = ['ALLOWED_ORIGINS', 'STORAGE_WALLETS', 'TICKET_SECRET', 'BASE_PATH', 'PUBLIC_URL', 'ETH_RPC_URL', 'SERVICE_VERSION', ...Object.values(LIMIT_VARS)]
  const values = await Promise.all(names.map(async (name) => [name, await config.getString(name)] as const))
  return envFromVars(Object.fromEntries(values), store)
}

/** Build the handler's environment from string variables (process.env, Worker vars and secrets). */
export function envFromVars(vars: Vars, store: BlobStore): Env {
  const allowedOrigins = (vars.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter((origin) => origin !== '')
  if (allowedOrigins.length === 0) throw new Error('ALLOWED_ORIGINS is empty')
  for (const origin of allowedOrigins) {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('ALLOWED_ORIGINS must contain exact HTTP origins')
  }
  const ticketSecret = vars.TICKET_SECRET ?? ''
  if (ticketSecret.length < 32) throw new Error('TICKET_SECRET must be at least 32 characters')

  const limits: Partial<Limits> = {}
  for (const [name, variable] of Object.entries(LIMIT_VARS) as Array<[keyof Limits, string]>) {
    const text = vars[variable]
    if (text == null || text === '') continue
    const value = Number(text)
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${variable} must be a positive integer`)
    limits[name] = value
  }
  return {
    store,
    allowedOrigins,
    storageWallets: walletAllowlist(vars.STORAGE_WALLETS, 'STORAGE_WALLETS'),
    ticketSecret,
    basePath: (vars.BASE_PATH ?? '').replace(/\/$/, ''),
    publicUrl: vars.PUBLIC_URL?.replace(/\/$/, '') || undefined,
    ethRpcUrl: vars.ETH_RPC_URL || undefined,
    version: vars.SERVICE_VERSION || undefined,
    limits
  }
}

export function walletAllowlist(value: string | undefined, name: string): ReadonlySet<string> | null {
  if (value === undefined || value.trim() === '*') return null
  const wallets = value.split(',').map((wallet) => wallet.trim().toLowerCase())
  if (wallets.some((wallet) => !/^0x[0-9a-f]{40}$/.test(wallet))) throw new Error(`${name} must contain addresses or *`)
  return new Set(wallets)
}

/** A fixed one-minute window per key, in this process's memory. */
export function createRateLimiter(): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    take(key, now, limit) {
      if (windows.size > 10_000) {
        for (const [other, window] of windows) if (now - window.start >= 60_000) windows.delete(other)
      }
      let window = windows.get(key)
      if (window == null || now - window.start >= 60_000) {
        window = { start: now, count: 0 }
        windows.set(key, window)
      }
      window.count++
      return window.count > limit ? Math.max(1, Math.ceil((window.start + 60_000 - now) / 1000)) : 0
    }
  }
}

export interface UploadGate {
  /** A release function, or what is full: this wallet's uploads, or the bytes in flight. */
  acquire(wallet: string, bytes: number, limits: Limits): (() => void) | 'wallet' | 'service'
}

export function createUploadGate(): UploadGate {
  const perWallet = new Map<string, number>()
  let inFlight = 0
  return {
    acquire(wallet, bytes, limits) {
      const count = perWallet.get(wallet) ?? 0
      if (count >= limits.uploadsPerWallet) return 'wallet'
      // one upload always gets through, whatever its size
      if (inFlight > 0 && inFlight + bytes > limits.uploadBytesInFlight) return 'service'
      perWallet.set(wallet, count + 1)
      inFlight += bytes
      let held = true
      return () => {
        if (!held) return
        held = false
        inFlight -= bytes
        const left = (perWallet.get(wallet) ?? 1) - 1
        if (left > 0) perWallet.set(wallet, left)
        else perWallet.delete(wallet)
      }
    }
  }
}

const sharedLimiter = createRateLimiter()
const sharedUploads = createUploadGate()
const sharedLock = createLock()

export interface Runtime {
  store: BlobStore
  limits: Limits
  now: number
  rateLimiter: RateLimiter
  uploads: UploadGate
  lock: Lock
}

export function runtime(env: Env): Runtime {
  return {
    store: env.store,
    limits: { ...DEFAULT_LIMITS, ...env.limits },
    now: (env.clock ?? Date).now(),
    rateLimiter: env.rateLimiter ?? sharedLimiter,
    uploads: env.uploads ?? sharedUploads,
    lock: env.lock ?? sharedLock
  }
}
