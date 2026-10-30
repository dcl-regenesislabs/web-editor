import { join, resolve, sep } from 'node:path'
import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import type { IBaseComponent, IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { walletAllowlist } from '../config.ts'
import { createPoolService, DEFAULT_POOL_LIMITS } from './pool.ts'
import type { PoolLimits, PoolService } from './pool.ts'
import { loadPoolSigner, poolSignerFromJson } from './signer.ts'
import { createWorldsClient } from './worlds.ts'

export const DEFAULT_POOL_WORLDS = 'https://worlds-content-server.decentraland.org'
const NAME = /^[a-z0-9-]+\.dcl\.eth$/

const LIMIT_VARS: Record<keyof PoolLimits, string> = {
  zoneSize: 'POOL_ZONE_SIZE',
  keepClear: 'POOL_KEEP_CLEAR',
  leasesPerName: 'POOL_LEASES_PER_NAME',
  maxSceneBytes: 'POOL_MAX_SCENE_BYTES',
  signsPerMinute: 'POOL_SIGNS_PER_MINUTE',
  signsPerDay: 'POOL_SIGNS_PER_DAY',
  leasesPerAddressPerDay: 'POOL_LEASES_PER_ADDRESS_PER_DAY',
  leasesPerHour: 'POOL_LEASES_PER_HOUR',
  pendingDeploys: 'POOL_PENDING_DEPLOYS',
  pendingSeconds: 'POOL_PENDING_SECONDS',
  idleLeaseHours: 'POOL_IDLE_LEASE_HOURS'
}

export interface PoolComponent extends IBaseComponent {
  /** Undefined while POOL_NAMES is unset: the pool is off. */
  service?: PoolService
}

/** Shared worlds are off unless POOL_NAMES and POOL_SIGNER_KEY_FILE are both set. */
export async function createPoolComponent({ config, logs }: { config: IConfigComponent; logs: ILoggerComponent }, intervalMs = 60_000): Promise<PoolComponent> {
  const listed = (await config.getString('POOL_NAMES'))?.trim()
  if (!listed) return {}
  const names = listed.split(',').map((name) => name.trim().toLowerCase())
  if (names.some((name) => !NAME.test(name))) throw new Error('POOL_NAMES must list NAMEs like name.dcl.eth')
  // NAMEs the Worlds whitelist exempts from the owner's storage allowance: the pool won't gate
  // leases/signs on the owner's free space for them (only the per-scene cap and leasesPerName).
  const whitelisted = ((await config.getString('POOL_WHITELISTED'))?.trim() || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
  const strayWhitelisted = whitelisted.filter((name) => !names.includes(name))
  if (strayWhitelisted.length > 0) throw new Error(`POOL_WHITELISTED has NAMEs that are not in POOL_NAMES: ${strayWhitelisted.join(', ')}`)
  // The signer key either inline (POOL_SIGNER_KEY, which fits an env_file/.env deploy) or as a
  // file path (POOL_SIGNER_KEY_FILE, kept outside STORAGE_DIR so it is never served as content).
  const keyInline = (await config.getString('POOL_SIGNER_KEY'))?.trim()
  const keyFile = (await config.getString('POOL_SIGNER_KEY_FILE'))?.trim()
  if (!keyInline && !keyFile) throw new Error('Set POOL_SIGNER_KEY (the JSON inline) or POOL_SIGNER_KEY_FILE (a path to it)')
  const production = process.env.NODE_ENV === 'production'
  const storageDir = await config.getString('STORAGE_DIR')
  if (keyFile && storageDir !== undefined && (resolve(keyFile) === resolve(storageDir) || resolve(keyFile).startsWith(resolve(storageDir) + sep))) {
    throw new Error('POOL_SIGNER_KEY_FILE must be outside STORAGE_DIR')
  }
  const wallets = (await config.getString('POOL_WALLETS'))?.trim()
  // an open pool lends the owners' storage to any wallet, so production must choose
  if (production && !wallets) throw new Error('POOL_WALLETS must list the wallets that may use shared worlds (or be * for any)')
  const ipHeader = (await config.getString('CLIENT_IP_HEADER'))?.trim().toLowerCase()
  if (production && !ipHeader) throw new Error('CLIENT_IP_HEADER must name the header the proxy puts the client address in, or shared worlds have no per-address limit')

  const limits: Partial<PoolLimits> = {}
  for (const [name, variable] of Object.entries(LIMIT_VARS) as Array<[keyof PoolLimits, string]>) {
    const value = await config.getNumber(variable)
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 0 || (value === 0 && name !== 'keepClear')) throw new Error(`${variable} must be a positive integer`)
    limits[name] = value
  }
  const zoneSize = limits.zoneSize ?? DEFAULT_POOL_LIMITS.zoneSize
  if (zoneSize > 50) throw new Error('POOL_ZONE_SIZE must be at most 50')

  const logger = logs.getLogger('name-pool')
  const worldsContent = ((await config.getString('POOL_WORLDS_SERVER')) ?? DEFAULT_POOL_WORLDS).replace(/\/+$/, '')
  const signer = keyInline ? poolSignerFromJson(keyInline) : loadPoolSigner(keyFile as string)
  const service = await createPoolService({
    names,
    signer,
    worlds: createWorldsClient(worldsContent, signer),
    worldsContent,
    stateDir: (await config.getString('POOL_STATE_DIR')) ?? join(storageDir ?? '.', '..', '.pool'),
    wallets: walletAllowlist(wallets, 'POOL_WALLETS'),
    blocked: walletAllowlist((await config.getString('POOL_BLOCKED_WALLETS')) || undefined, 'POOL_BLOCKED_WALLETS') ?? undefined,
    whitelisted,
    limits,
    log: (message) => logger.warn(message)
  })

  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<void> | undefined
  const sweep = () => {
    running ??= service.sweep()
      .catch(() => { logger.error('Pool sweep failed') })
      .finally(() => { running = undefined })
    return running
  }
  return {
    service,
    async [START_COMPONENT]() {
      for (const name of (await service.status()).names) {
        if (name.canDeploy === false) logger.warn(`The pool wallet ${signer.address} cannot deploy to ${name.name}: its owner has to grant it`)
      }
      timer = setInterval(() => { void sweep() }, intervalMs)
      timer.unref()
    },
    async [STOP_COMPONENT]() {
      clearInterval(timer)
      await running
    }
  }
}

export const poolIpHeader = async (config: IConfigComponent): Promise<string | undefined> =>
  (await config.getString('CLIENT_IP_HEADER'))?.trim().toLowerCase() || undefined
