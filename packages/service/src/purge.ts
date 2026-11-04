import { runtime } from './config.ts'
import type { Env, Runtime } from './config.ts'
import { loadManifest, readManifest, readPrefab, readShare } from './manifest.ts'
import { keys, parseMarker, ticketExpiry } from './paths.ts'
import { STORAGE_LOCK, readAll } from './store.ts'

const DAY_MS = 24 * 60 * 60 * 1000
// an upload is unreferenced until its manifest is written
const UNREFERENCED_GRACE_MS = DAY_MS
const SPENT_TICKETS_PER_RUN = 500

export interface PurgeResult {
  projects: number
  references: number
  tickets: number
  wallets: number
  /** The run reached the last wallet; the next one starts over. */
  done: boolean
}

/** Remove projects past their time in the trash, the blob references no manifest or prefab uses any more,
 *  and spent upload tickets past their expiry. Each run visits at most `purgeWalletsPerRun` wallets
 *  and carries on from the last one the next time; run it on a schedule. */
export async function purge(env: Env): Promise<PurgeResult> {
  const run = runtime(env)
  return run.lock(STORAGE_LOCK, () => sweep(run))
}

async function sweep(run: Runtime): Promise<PurgeResult> {
  const tickets = await purgeTickets(run)
  const result: PurgeResult = { projects: 0, references: 0, tickets: tickets.removed, wallets: 0, done: false }
  const after = await readCursor(run)
  const page = await run.store.scan(keys.wallets, {
    delimiter: true,
    // past every key of the last wallet visited: `~` sorts after any key character
    startAfter: after === null ? undefined : `${after}~`,
    limit: run.limits.purgeWalletsPerRun
  })
  for (const prefix of page.prefixes) {
    await purgeWallet(run, prefix.split('/')[1], result)
    result.wallets++
  }
  const last = page.prefixes.at(-1)
  const walletsDone = !page.truncated || last === undefined
  result.done = walletsDone && tickets.done
  if (walletsDone) await run.store.delete(keys.purgeCursor)
  else await run.store.put(keys.purgeCursor, new TextEncoder().encode(JSON.stringify({ after: last })))
  if (result.done) await purgeBlobs(run)
  return result
}

async function readCursor(run: Runtime): Promise<string | null> {
  const object = await run.store.get(keys.purgeCursor)
  if (object == null) return null
  try {
    const { after } = JSON.parse(new TextDecoder().decode(await readAll(object.body))) as { after?: unknown }
    return typeof after === 'string' && after.startsWith(keys.wallets) ? after : null
  } catch {
    return null
  }
}

export async function purgeTickets(run: Runtime): Promise<{ removed: number; done: boolean }> {
  const page = await run.store.scan(keys.tickets, { limit: SPENT_TICKETS_PER_RUN })
  let removed = 0
  for (const { key } of page.objects) {
    if (!(ticketExpiry(key) <= run.now)) break
    await run.store.delete(key)
    removed++
  }
  return { removed, done: !page.truncated || removed < page.objects.length }
}

async function purgeBlobs(run: Runtime): Promise<void> {
  const owned = new Set<string>()
  for (const key of await run.store.list(keys.wallets)) {
    const marker = parseMarker(key)
    if (marker !== null) owned.add(marker.hash)
  }
  for (const key of await run.store.list('blobs/')) {
    if (owned.has(key.slice('blobs/'.length))) continue
    const info = await run.store.head(key)
    if (info !== null && run.now - info.modified >= UNREFERENCED_GRACE_MS) await run.store.delete(key)
  }
}

async function purgeWallet(run: Runtime, wallet: string, result: PurgeResult): Promise<void> {
  const trashMs = run.limits.trashDays * DAY_MS
  const walletKeys = await run.store.list(`${keys.wallets}${wallet}/`)
  const referenced = new Set<string>()
  const prefix = keys.projects(wallet)
  const ids = new Set(walletKeys.filter((key) => key.startsWith(prefix)).map((key) => key.split('/')[3]))
  for (const id of ids) {
    const current = await loadManifest(run.store, wallet, id)
    const histories = walletKeys.filter((key) => key.startsWith(keys.histories(wallet, id)))
    const deletedAt = current?.manifest.deletedAt
    if (current == null || (deletedAt != null && run.now - deletedAt >= trashMs)) {
      for (const key of histories) await run.store.delete(key)
      const share = await readShare(run.store, keys.share(wallet, id))
      if (share != null) await run.store.delete(keys.shared(share.token))
      await run.store.delete(keys.share(wallet, id))
      await run.store.delete(keys.manifest(wallet, id))
      if (current != null) result.projects++
      continue
    }
    for (const file of Object.values(current.manifest.files)) referenced.add(file.hash)
    // one version at a time: a wallet's history can be large
    for (const key of histories) {
      const version = await readManifest(run.store, key)
      for (const file of Object.values(version?.manifest.files ?? {})) referenced.add(file.hash)
    }
  }
  for (const key of walletKeys.filter((key) => key.startsWith(keys.prefabs(wallet)))) {
    const prefab = await readPrefab(run.store, key)
    for (const file of Object.values(prefab?.files ?? {})) referenced.add(file.hash)
  }
  for (const key of walletKeys.filter((key) => key.startsWith(keys.markers(wallet)))) {
    const marker = parseMarker(key)
    if (marker == null || referenced.has(marker.hash)) continue
    const info = await run.store.head(key)
    if (info != null && run.now - info.modified >= UNREFERENCED_GRACE_MS) {
      await run.store.delete(key)
      result.references++
    }
  }
}
