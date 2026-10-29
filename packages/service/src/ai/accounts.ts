import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { object } from '../../../contract/src/assistant.ts'
import { createQuotaMonitor, DISABLED_QUOTA } from './quota.ts'
import type { QuotaMonitor, QuotaView } from './quota.ts'

const CLAUDE_PROVIDER = 'anthropic'
const PRIMARY_ACCOUNT = 'primary'
const SETUP_TOKEN = /^sk-ant-oat[\w-]{1,400}$/
const ACCOUNT_FILE = /^([a-f0-9]{16})\.json$/
const MAX_ACCOUNTS = 20
// a 429 that is not the plan's limit (a burst) parks the account briefly; a plan limit without a reset time, longer
const BURST_MS = 60_000
const UNKNOWN_RESET_MS = 60 * 60_000
const HEADER = 'anthropic-ratelimit-unified-'

export type AccountState = 'active' | 'ready' | 'limited' | 'rejected' | 'signed-out'

export interface AccountView {
  id: string
  label: string
  addedAt: string | null
  /** The configured account (ANTHROPIC_OAUTH_SETUP_TOKEN or AI_AUTH_PATH) is managed there, not from the dashboard. */
  removable: boolean
  state: AccountState
  limitedUntil: string | null
  /** The token's last four characters, to tell accounts apart. */
  hint: string | null
  quota: QuotaView
}

type AccountErrorCode = 'invalid-token' | 'invalid-label' | 'duplicate' | 'too-many' | 'not-found' | 'not-removable'

export class AccountError extends Error {
  readonly code: AccountErrorCode
  constructor(code: AccountErrorCode) {
    super(code)
    this.code = code
  }
}

/**
 * The Claude accounts the assistant spends, behind one credential store: pi asks it for the `anthropic`
 * credential before every request, so moving to another account needs no new session.
 */
export interface AccountPool {
  store: CredentialStore
  /** The account the last Claude credential was handed out for: the next response belongs to it. */
  current(): string | undefined
  responded(id: string | undefined, status: number, headers: Record<string, string>): void
  /** null while an account can take a request; else when the first limited one frees up (Infinity: none will). */
  blockedUntil(): number | null
  quota(): QuotaView
  list(): Promise<AccountView[]>
  add(label: string, token: string): Promise<AccountView>
  remove(id: string): Promise<void>
}

interface Account {
  id: string
  label: string
  addedAt: number | null
  /** null for the primary account, whose credential is the `anthropic` entry of the shared auth file */
  file: string | null
  credential: Credential | undefined
  limitedUntil: number
  rejected: boolean
  quota: QuotaMonitor
}

type AuthData = Record<string, Credential>

const isCredential = (value: unknown): value is Credential =>
  object(value) && (value.type === 'oauth' || value.type === 'api_key')

async function writePrivate(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function serialized() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work)
    tail = next.catch(() => {})
    return next
  }
}

function windowsAtLimit(headers: Record<string, string>): number[] {
  const resets: number[] = []
  for (const window of ['5h', '7d']) {
    if (Number(headers[`${HEADER}${window}-utilization`]) >= 1) resets.push(Number(headers[`${HEADER}${window}-reset`]))
  }
  return resets
}

/** When a 429 from Claude lets this account work again. */
function limitedUntil(headers: Record<string, string>, now: number): number {
  const atLimit = windowsAtLimit(headers)
  if (headers[`${HEADER}status`] === 'rejected' || atLimit.length > 0) {
    const resets = [Number(headers[`${HEADER}reset`]), ...atLimit].filter((reset) => Number.isFinite(reset) && reset * 1000 > now)
    return resets.length > 0 ? Math.max(...resets) * 1000 : now + UNKNOWN_RESET_MS
  }
  const retryAfter = Number(headers['retry-after'])
  return now + (Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, UNKNOWN_RESET_MS) : BURST_MS)
}

export async function createAccountPool(options: {
  /** The auth file holding the primary Claude credential and every other provider's. */
  primaryPath: string
  /** Where accounts added from the dashboard are kept, one 0600 file each. */
  dir: string
  logger?: { info(message: string): void; warn(message: string): void }
  /** This service's estimated API spend so far, for each account's quota estimate. */
  spend?: () => number
  now?: () => number
}): Promise<AccountPool> {
  const now = options.now ?? Date.now
  const fresh = () => ({ limitedUntil: 0, rejected: false, quota: createQuotaMonitor({ spend: options.spend, now }) })
  const primaryQueue = serialized()
  const accountQueues = new Map<string, ReturnType<typeof serialized>>()
  const queueFor = (id: string) => {
    let queue = accountQueues.get(id)
    if (queue === undefined) accountQueues.set(id, queue = serialized())
    return queue
  }

  async function readPrimary(): Promise<AuthData> {
    let saved: unknown
    try {
      saved = JSON.parse(await readFile(options.primaryPath, 'utf8'))
    } catch (error) {
      if (object(error) && error.code === 'ENOENT') return {}
      throw new Error('Could not load the assistant OAuth session file.')
    }
    if (!object(saved)) throw new Error('Invalid assistant OAuth session file.')
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, Credential] => isCredential(entry[1])))
  }

  const updatePrimary = (change: (data: AuthData) => Promise<boolean>) => primaryQueue(async () => {
    const data = await readPrimary()
    if (await change(data)) await writePrivate(options.primaryPath, data)
    return data
  })

  const accounts: Account[] = [{ id: PRIMARY_ACCOUNT, label: 'Configured account', addedAt: null, file: null, credential: undefined, ...fresh() }]
  await mkdir(options.dir, { recursive: true, mode: 0o700 })
  for (const name of await readdir(options.dir)) {
    const id = ACCOUNT_FILE.exec(name)?.[1]
    if (id === undefined) continue
    const file = join(options.dir, name)
    const saved: unknown = await readFile(file, 'utf8').then((text) => JSON.parse(text), () => undefined)
    if (!object(saved) || !isCredential(saved.credential) || typeof saved.label !== 'string' || typeof saved.addedAt !== 'number') {
      options.logger?.warn(`Skipping an unreadable Claude account file: ${name}`)
      continue
    }
    accounts.push({ id, label: saved.label, addedAt: saved.addedAt, file, credential: saved.credential, ...fresh() })
  }
  accounts.splice(1, accounts.length, ...accounts.slice(1).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0)))

  let active: string | undefined
  let issued: string | undefined
  const byId = (id: string | undefined) => accounts.find((account) => account.id === id)
  const usable = (account: Account, at: number) => account.credential !== undefined && !account.rejected && account.limitedUntil <= at

  async function refreshPrimary(): Promise<AuthData> {
    const data = await readPrimary()
    accounts[0].credential = data[CLAUDE_PROVIDER]
    return data
  }

  // Stay on one account while it works, so its prompt cache keeps paying off.
  function choose(): Account | undefined {
    const at = now()
    const chosen = accounts.find((account) => account.id === active && usable(account, at)) ??
      accounts.find((account) => usable(account, at)) ??
      accounts.filter((account) => account.credential !== undefined && !account.rejected).sort((a, b) => a.limitedUntil - b.limitedUntil)[0] ??
      accounts.find((account) => account.credential !== undefined)
    if (chosen !== undefined && chosen.id !== active) {
      if (active !== undefined) options.logger?.info(`Claude account switched to "${chosen.label}"`)
      chosen.quota.rebase()
      active = chosen.id
    }
    return chosen
  }

  const store: CredentialStore = {
    async read(providerId) {
      if (providerId !== CLAUDE_PROVIDER) return (await readPrimary())[providerId]
      await refreshPrimary()
      const chosen = choose()
      issued = chosen?.id
      return chosen?.credential
    },
    async list() {
      const listed: CredentialInfo[] = Object.entries(await refreshPrimary())
        .filter(([providerId]) => providerId !== CLAUDE_PROVIDER)
        .map(([providerId, credential]) => ({ providerId, type: credential.type }))
      const claude = accounts.find((account) => account.credential !== undefined)?.credential
      return claude === undefined ? listed : [...listed, { providerId: CLAUDE_PROVIDER, type: claude.type }]
    },
    async modify(providerId, change) {
      // pi refreshes inside modify right after a read: the issued account is the one being refreshed
      const account = providerId === CLAUDE_PROVIDER ? byId(issued) : undefined
      if (account === undefined || account.file === null) {
        let result: Credential | undefined
        await updatePrimary(async (data) => {
          const next = await change(data[providerId])
          result = next ?? data[providerId]
          if (next === undefined) return false
          data[providerId] = next
          return true
        })
        if (providerId === CLAUDE_PROVIDER) accounts[0].credential = result
        return result
      }
      const file = account.file
      return queueFor(account.id)(async () => {
        const next = await change(account.credential)
        if (next === undefined) return account.credential
        await writePrivate(file, { label: account.label, addedAt: account.addedAt, credential: next })
        account.credential = next
        return next
      })
    },
    async delete(providerId) {
      await updatePrimary(async (data) => {
        if (!(providerId in data)) return false
        delete data[providerId]
        return true
      })
    }
  }

  function stateOf(account: Account, at: number): AccountState {
    if (account.credential === undefined) return 'signed-out'
    if (account.rejected) return 'rejected'
    if (account.limitedUntil > at) return 'limited'
    return account.id === active ? 'active' : 'ready'
  }

  function view(account: Account): AccountView {
    const at = now()
    const credential = account.credential
    return {
      id: account.id, label: account.label,
      addedAt: account.addedAt === null ? null : new Date(account.addedAt).toISOString(),
      removable: account.file !== null, state: stateOf(account, at),
      limitedUntil: account.limitedUntil > at ? new Date(account.limitedUntil).toISOString() : null,
      hint: credential?.type === 'oauth' ? credential.access.slice(-4) : null,
      quota: account.quota.view()
    }
  }

  return {
    store,
    current: () => issued,
    responded(id, status, headers) {
      const account = byId(id)
      if (account === undefined) return
      account.quota.record(headers)
      const at = now()
      if (status === 429) {
        account.limitedUntil = limitedUntil(headers, at)
        options.logger?.warn(`Claude account "${account.label}" is limited until ${new Date(account.limitedUntil).toISOString()}`)
      } else if (status === 401 || status === 403) {
        account.rejected = true
        options.logger?.warn(`Claude refused the token of account "${account.label}"; replace it`)
      } else if (status < 400) {
        account.rejected = false
        account.limitedUntil = 0
      }
    },
    blockedUntil() {
      const at = now()
      const signedIn = accounts.filter((account) => account.credential !== undefined)
      if (signedIn.length === 0 || signedIn.some((account) => usable(account, at))) return null
      const limited = signedIn.filter((account) => !account.rejected).map((account) => account.limitedUntil)
      return limited.length === 0 ? Infinity : Math.min(...limited)
    },
    quota: () => {
      const shown = byId(active) ?? accounts.find((account) => account.credential !== undefined)
      return shown?.quota.view() ?? DISABLED_QUOTA
    },
    async list() {
      await refreshPrimary()
      return accounts.map(view)
    },
    async add(rawLabel, rawToken) {
      const token = rawToken.trim()
      const label = rawLabel.trim()
      if (!SETUP_TOKEN.test(token)) throw new AccountError('invalid-token')
      if (label.length === 0 || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) throw new AccountError('invalid-label')
      await refreshPrimary()
      if (accounts.some((account) => account.credential?.type === 'oauth' && account.credential.access === token)) throw new AccountError('duplicate')
      if (accounts.length >= MAX_ACCOUNTS) throw new AccountError('too-many')
      const addedAt = now()
      const id = randomBytes(8).toString('hex')
      const file = join(options.dir, `${id}.json`)
      // a setup token is an access token: it cannot be refreshed, and lasts a year
      const credential: Credential = { type: 'oauth', access: token, refresh: '', expires: addedAt + 365 * 24 * 60 * 60_000, setupToken: true }
      await writePrivate(file, { label, addedAt, credential })
      const account: Account = { id, label, addedAt, file, credential, ...fresh() }
      accounts.push(account)
      options.logger?.info(`Claude account "${label}" added`)
      return view(account)
    },
    async remove(id) {
      const account = byId(id)
      if (account === undefined) throw new AccountError('not-found')
      if (account.file === null) throw new AccountError('not-removable')
      const file = account.file
      await queueFor(id)(() => rm(file, { force: true }))
      accounts.splice(accounts.indexOf(account), 1)
      accountQueues.delete(id)
      if (active === id) active = undefined
      options.logger?.info(`Claude account "${account.label}" removed`)
    }
  }
}
