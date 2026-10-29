import { authenticate } from './auth.ts'
import { HASH, matchesHash } from '../../contract/src/cid.ts'
import { runtime } from './config.ts'
import type { Env, Limits, Runtime } from './config.ts'
import { encodeManifest, loadManifest, readManifest, readPrefab, readSummary, summarize, summaryMetadata } from './manifest.ts'
import type { Manifest, ManifestFile, PrefabManifest, ProjectSummary } from './manifest.ts'
import { BIDI, PREFAB_NAME, PROJECT_ID, keys, parseMarker, pathProblem, ticketWallet } from './paths.ts'
import { STORAGE_LOCK } from './store.ts'
import type { BlobStore } from './store.ts'
import { issueTicket, readTicket } from './tickets.ts'
import { StorageFull } from './quota-store.ts'
import { purgeTickets } from './purge.ts'

const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_NAME_LENGTH = 100
const TICKET_TTL_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const CORS_HEADER = /^(content-type|x-identity-timestamp|x-identity-metadata|x-identity-auth-chain-\d)$/

class Refusal extends Error {
  response: Response
  constructor(response: Response) {
    super('refused')
    this.response = response
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers
    }
  })
}

const fail = (status: number, error: string, detail: Record<string, unknown> = {}): Response =>
  json(status, { error, ...detail })

const refuse = (status: number, error: string, detail: Record<string, unknown> = {}): Refusal =>
  new Refusal(fail(status, error, detail))

/** At most `cap` bytes of body; null once it is longer, 'timeout' past `deadlineMs`. */
async function readUpTo(request: Request, cap: number, deadlineMs: number): Promise<Uint8Array | null | 'timeout'> {
  if (request.body == null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const out = new Uint8Array(cap)
  let late = false
  const timer = setTimeout(() => {
    late = true
    void reader.cancel().catch(() => console.warn('[project-storage] Request cancellation failed'))
  }, deadlineMs)
  try {
    let offset = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (late) return 'timeout'
      if (done) return out.subarray(0, offset)
      if (offset + value.length > cap) {
        await reader.cancel()
        return null
      }
      out.set(value, offset)
      offset += value.length
    }
  } catch (error) {
    if (late) return 'timeout'
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Exactly `size` bytes of body; null for any other length, 'timeout' past `deadlineMs`. */
async function readExactly(request: Request, size: number, deadlineMs: number): Promise<Uint8Array | null | 'timeout'> {
  const bytes = await readUpTo(request, size, deadlineMs)
  if (bytes === null || bytes === 'timeout') return bytes
  return bytes.length === size ? bytes : null
}

/** The body, or null once it is longer than `cap`. */
async function readBody(request: Request, cap: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? 0) > cap) return null
  const bytes = await readUpTo(request, cap, 30_000)
  if (bytes === 'timeout') throw refuse(408, 'request-timeout')
  return bytes
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBody(request, MAX_JSON_BYTES)
  if (bytes == null) throw refuse(413, 'body-too-large')
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (value != null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // answered below
  }
  throw refuse(400, 'invalid-json')
}

function checkFile(value: unknown, limits: Limits): ManifestFile {
  const file = value as Partial<ManifestFile> | null
  if (file == null || typeof file.hash !== 'string' || !HASH.test(file.hash)) throw refuse(400, 'invalid-hash')
  if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) throw refuse(400, 'invalid-size', { hash: file.hash })
  if ((file.size as number) > limits.maxFileBytes) {
    throw refuse(413, 'file-too-large', { hash: file.hash, limit: limits.maxFileBytes })
  }
  return { hash: file.hash, size: file.size as number }
}

/** The blobs a wallet uploaded itself: hash -> size. */
async function ownedBlobs(store: BlobStore, wallet: string): Promise<Map<string, number>> {
  const owned = new Map<string, number>()
  for (const key of await store.list(keys.markers(wallet))) {
    const marker = parseMarker(key)
    if (marker != null) owned.set(marker.hash, marker.size)
  }
  return owned
}

const total = (sizes: Iterable<number>): number => {
  let sum = 0
  for (const size of sizes) sum += size
  return sum
}

const storedMetadata = (encoded: Uint8Array, extra: Record<string, string> = {}): Record<string, string> =>
  ({ ...extra, bytes: String(encoded.byteLength) })

async function storedBytes(store: BlobStore, key: string, metadata: Record<string, string> | undefined): Promise<number> {
  const bytes = Number(metadata?.bytes)
  return Number.isSafeInteger(bytes) ? bytes : (await store.head(key))?.size ?? 0
}

async function prefixBytes(store: BlobStore, prefix: string, skip?: string): Promise<number> {
  let bytes = 0
  let startAfter: string | undefined
  for (;;) {
    const page = await store.scan(prefix, { startAfter, metadata: true })
    for (const { key, metadata } of page.objects) {
      if (key !== skip) bytes += await storedBytes(store, key, metadata)
    }
    startAfter = page.objects.at(-1)?.key
    if (!page.truncated || startAfter === undefined) break
  }
  return bytes
}

/** Bytes of a wallet's manifests, their history and its prefabs, which count against its quota like its blobs. */
async function manifestBytes(store: BlobStore, wallet: string, skip?: string): Promise<number> {
  return (await prefixBytes(store, keys.projects(wallet), skip)) + (await prefixBytes(store, keys.prefabs(wallet), skip))
}

const retry = (status: number, error: string, wait: number): Response =>
  json(status, { error, retryAfter: wait }, { 'retry-after': String(wait) })

function limited(run: Runtime, key: string, limit = run.limits.requestsPerMinute): Response | null {
  const wait = run.rateLimiter.take(key, run.now, limit)
  return wait > 0 ? retry(429, 'rate-limited', wait) : null
}

const signedBy = (request: Request, env: Env, run: Runtime) =>
  authenticate(request, {
    now: run.now,
    allowedOrigins: env.allowedOrigins,
    maxDelegationMs: run.limits.maxDelegationDays * DAY_MS,
    ethRpcUrl: env.ethRpcUrl
  })

function preflight(request: Request): Response {
  const requested = (request.headers.get('access-control-request-headers') ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter((header) => CORS_HEADER.test(header))
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': 'GET, PUT, POST, DELETE',
      'access-control-allow-headers': requested.join(', '),
      'access-control-max-age': '600'
    }
  })
}

// Summaries ride in each manifest's object metadata; only a manifest written without one is read.
async function listProjects(run: Runtime, wallet: string): Promise<Response> {
  const projects: ProjectSummary[] = []
  let stored = 0
  let startAfter: string | undefined
  for (;;) {
    const page = await run.store.scan(keys.projects(wallet), { startAfter, metadata: true })
    for (const { key, metadata } of page.objects) {
      stored += await storedBytes(run.store, key, metadata)
      if (!key.endsWith('/manifest.json')) continue
      const summary = readSummary(metadata) ?? (await readManifest(run.store, key).then((found) => found && summarize(found.manifest)))
      if (summary != null) projects.push(summary)
    }
    startAfter = page.objects.at(-1)?.key ?? page.prefixes.at(-1)
    if (!page.truncated || startAfter === undefined) break
  }
  projects.sort((a, b) => b.updatedAt - a.updatedAt)
  const used = total((await ownedBlobs(run.store, wallet)).values()) + stored + (await prefixBytes(run.store, keys.prefabs(wallet)))
  return json(200, { projects, usage: { bytes: used, limit: run.limits.maxWalletBytes } })
}

async function getManifest(run: Runtime, wallet: string, id: string): Promise<Response> {
  const current = await loadManifest(run.store, wallet, id)
  if (current == null) return fail(404, 'not-found')
  const { deletedAt, ...manifest } = current.manifest
  return deletedAt == null ? json(200, manifest) : fail(404, 'deleted', { deletedAt })
}

async function requestUploads(run: Runtime, env: Env, wallet: string, request: Request): Promise<Response> {
  const { files } = await readJson(request)
  if (!Array.isArray(files)) return fail(400, 'invalid-files')
  if (files.length > run.limits.maxProjectFiles) return fail(413, 'too-many-files', { limit: run.limits.maxProjectFiles })
  const wanted = new Map<string, number>()
  for (const file of files) {
    const { hash, size } = checkFile(file, run.limits)
    wanted.set(hash, size)
  }
  const owned = await ownedBlobs(run.store, wallet)
  const needed = [...wanted].filter(([hash]) => !owned.has(hash))
  const used = total(owned.values()) + await manifestBytes(run.store, wallet)
  const adding = total(needed.map(([, size]) => size))
  if (used + adding > run.limits.maxWalletBytes) {
    return fail(413, 'quota-exceeded', { used, needed: adding, limit: run.limits.maxWalletBytes })
  }
  const expires = run.now + TICKET_TTL_MS
  const base = env.publicUrl ?? `${new URL(request.url).origin}${env.basePath ?? ''}`
  const uploads = await Promise.all(
    needed.map(async ([hash, size]) => ({
      hash,
      url: `${base}/blobs/${hash}?ticket=${await issueTicket(env.ticketSecret, hash, { wallet, size, expires })}`,
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' }
    }))
  )
  return json(200, { uploads, expiresAt: expires })
}

async function putBlob(run: Runtime, env: Env, request: Request, hash: string): Promise<Response> {
  if (!HASH.test(hash)) return fail(400, 'invalid-hash')
  const ticket = await readTicket(env.ticketSecret, hash, new URL(request.url).searchParams.get('ticket') ?? '', run.now)
  if (ticket == null) return fail(403, 'invalid-ticket')
  if (env.storageWallets != null && !env.storageWallets.has(ticket.wallet)) return fail(403, 'storage-not-allowed')
  if (ticket.size > run.limits.maxFileBytes) return fail(413, 'file-too-large')
  const wait = limited(run, ticket.wallet)
  if (wait != null) return wait
  const declared = request.headers.get('content-length')
  if (declared != null && Number(declared) !== ticket.size) return fail(422, 'size-mismatch', { expected: ticket.size })

  const release = run.uploads.acquire(ticket.wallet, ticket.size, run.limits)
  if (release === 'wallet') return retry(429, 'too-many-uploads', 1)
  if (release === 'service') return retry(503, 'busy', 5)
  try {
    // spent before the body is read, so one ticket cannot carry parallel uploads
    const spent = await run.lock(STORAGE_LOCK, async () => {
      const key = keys.ticket(ticket.expires, ticket.wallet, ticket.id)
      if (await run.store.head(key) !== null) return null
      let spentKeys = await run.store.list(keys.tickets)
      const full = () => spentKeys.length >= run.limits.maxSpentTickets ||
        spentKeys.filter((spentKey) => ticketWallet(spentKey) === ticket.wallet).length >= run.limits.maxSpentTicketsPerWallet
      if (full()) {
        await purgeTickets(run)
        spentKeys = await run.store.list(keys.tickets)
        if (spentKeys.length >= run.limits.maxSpentTickets) throw new Refusal(retry(503, 'ticket-capacity', 60))
        if (full()) throw new Refusal(retry(429, 'too-many-tickets', 60))
      }
      return run.store.put(key, new Uint8Array(0), { ifMatch: null })
    })
    if (spent == null) return fail(403, 'ticket-used')
    // a trickled body would otherwise hold its share of the upload budget until the socket dies
    const deadline = run.limits.uploadTimeoutSeconds * 1000 + (ticket.size / run.limits.uploadMinBytesPerSecond) * 1000
    const bytes = await readExactly(request, ticket.size, deadline)
    if (bytes === 'timeout') return fail(408, 'upload-timeout')
    if (bytes == null) return fail(422, 'size-mismatch', { expected: ticket.size })
    if (!(await matchesHash(bytes, hash))) return fail(422, 'hash-mismatch')
    return await storeBlob(run, ticket.wallet, hash, ticket.size, bytes)
  } finally {
    release()
  }
}

function storeBlob(run: Runtime, wallet: string, hash: string, size: number, bytes: Uint8Array): Promise<Response> {
  return run.lock(STORAGE_LOCK, async () => {
    const owned = await ownedBlobs(run.store, wallet)
    if (!owned.has(hash)) {
      const used = total(owned.values())
      if (used + size > run.limits.maxWalletBytes) {
        return fail(413, 'quota-exceeded', { used, needed: size, limit: run.limits.maxWalletBytes })
      }
      if (owned.size >= run.limits.maxWalletBlobs) return fail(413, 'too-many-blobs', { limit: run.limits.maxWalletBlobs })
      if ((await run.store.head(keys.blob(hash))) == null) await run.store.put(keys.blob(hash), bytes)
      await run.store.put(keys.marker(wallet, hash, size), new Uint8Array(0))
    }
    return json(201, { hash, size })
  })
}

function checkFiles(files: unknown, limits: Limits): Array<[string, ManifestFile]> {
  if (files == null || typeof files !== 'object' || Array.isArray(files)) throw refuse(400, 'invalid-files')
  const entries = Object.entries(files)
  if (entries.length > limits.maxProjectFiles) throw refuse(413, 'too-many-files', { limit: limits.maxProjectFiles })
  return entries.map(([path, file]): [string, ManifestFile] => {
    const problem = pathProblem(path)
    if (problem != null) throw refuse(400, 'invalid-path', { path: path.slice(0, 200), reason: problem })
    return [path, checkFile(file, limits)]
  })
}

function checkManifestBody(body: Record<string, unknown>, limits: Limits) {
  const { name, files, baseVersion } = body
  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_NAME_LENGTH || /[\x00-\x1f\x7f]/.test(name) || BIDI.test(name)) {
    throw refuse(400, 'invalid-name')
  }
  if (baseVersion !== null && !(Number.isSafeInteger(baseVersion) && (baseVersion as number) > 0)) {
    throw refuse(400, 'invalid-base-version')
  }
  return { name: name.trim(), baseVersion: baseVersion as number | null, files: checkFiles(files, limits) }
}

/** The 422/400 for files naming blobs the wallet did not upload, or at another size. */
function unownedFiles(files: Array<[string, ManifestFile]>, owned: Map<string, number>): Response | null {
  const missing = [...new Set(files.filter(([, file]) => !owned.has(file.hash)).map(([, file]) => file.hash))]
  if (missing.length > 0) return fail(422, 'missing-blobs', { missing: missing.slice(0, 100), count: missing.length })
  const wrong = files.find(([, file]) => owned.get(file.hash) !== file.size)
  return wrong == null ? null : fail(400, 'invalid-size', { hash: wrong[1].hash })
}

async function pruneHistory(run: Runtime, wallet: string, id: string, version: number): Promise<void> {
  const oldest = version - run.limits.historyVersions
  for (const key of await run.store.list(keys.histories(wallet, id))) {
    const kept = Number(/\/(\d+)\.json$/.exec(key)?.[1])
    if (kept <= oldest) await run.store.delete(key)
  }
}

async function putManifest(run: Runtime, wallet: string, id: string, request: Request): Promise<Response> {
  const body = checkManifestBody(await readJson(request), run.limits)
  return run.lock(STORAGE_LOCK, async () => {
    const current = await loadManifest(run.store, wallet, id)
    const stale = (latest: Manifest) => ({ version: latest.version, updatedAt: latest.updatedAt })
    if (current?.manifest.deletedAt != null) {
      return fail(409, 'deleted', { ...stale(current.manifest), deletedAt: current.manifest.deletedAt })
    }
    if (current == null && body.baseVersion !== null) return fail(404, 'not-found')
    if (current != null && current.manifest.version !== body.baseVersion) return fail(409, 'stale', stale(current.manifest))
    if (current == null) {
      const existing = (await run.store.list(keys.projects(wallet))).filter((key) => key.endsWith('/manifest.json'))
      if (existing.length >= run.limits.maxProjects) return fail(413, 'too-many-projects', { limit: run.limits.maxProjects })
    }

    const owned = await ownedBlobs(run.store, wallet)
    const unowned = unownedFiles(body.files, owned)
    if (unowned != null) return unowned

    const manifest: Manifest = {
      id,
      name: body.name,
      version: (current?.manifest.version ?? 0) + 1,
      updatedAt: run.now,
      bytes: total(body.files.map(([, file]) => file.size)),
      files: Object.fromEntries(body.files)
    }
    const encoded = encodeManifest(manifest)
    // the manifest is replaced and one history version is added
    const used = total(owned.values()) + await manifestBytes(run.store, wallet, keys.manifest(wallet, id))
    if (used + 2 * encoded.byteLength > run.limits.maxWalletBytes) {
      return fail(413, 'quota-exceeded', { used, needed: 2 * encoded.byteLength, limit: run.limits.maxWalletBytes })
    }
    const written = await run.store.put(keys.manifest(wallet, id), encoded, {
      ifMatch: current?.etag ?? null,
      metadata: storedMetadata(encoded, summaryMetadata(manifest))
    })
    if (written == null) {
      const latest = await loadManifest(run.store, wallet, id)
      return fail(409, 'stale', latest == null ? {} : stale(latest.manifest))
    }
    await run.store.put(keys.history(wallet, id, manifest.version), encoded, { metadata: storedMetadata(encoded) })
    await pruneHistory(run, wallet, id, manifest.version)
    return json(200, stale(manifest))
  })
}

async function getFile(run: Runtime, wallet: string, id: string, hash: string): Promise<Response> {
  const current = await loadManifest(run.store, wallet, id)
  if (current == null || current.manifest.deletedAt != null) return fail(404, 'not-found')
  return fileOf(run, current.manifest.files, hash)
}

async function fileOf(run: Runtime, files: Record<string, ManifestFile>, hash: string): Promise<Response> {
  if (!Object.values(files).some((file) => file.hash === hash)) return fail(404, 'not-found')
  const blob = await run.store.get(keys.blob(hash))
  if (blob == null) return fail(404, 'not-found')
  // a stored file is only ever handed over as inert bytes, never as a document of this origin
  return new Response(blob.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.size),
      'content-disposition': 'attachment',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    }
  })
}

function setDeleted(run: Runtime, wallet: string, id: string, deleted: boolean): Promise<Response> {
  return run.lock(STORAGE_LOCK, async () => {
    const current = await loadManifest(run.store, wallet, id)
    if (current == null) return fail(404, 'not-found')
    const { deletedAt, ...rest } = current.manifest
    const next: Manifest = deleted ? { ...rest, deletedAt: deletedAt ?? run.now } : rest
    if ((deletedAt != null) !== deleted) {
      const encoded = encodeManifest(next)
      const written = await run.store.put(keys.manifest(wallet, id), encoded, {
        ifMatch: current.etag,
        maintenance: deleted,
        metadata: storedMetadata(encoded, summaryMetadata(next))
      })
      if (written == null) return fail(409, 'conflict')
    }
    const purgeAt = next.deletedAt == null ? undefined : next.deletedAt + run.limits.trashDays * DAY_MS
    return json(200, { id, version: next.version, updatedAt: next.updatedAt, deletedAt: next.deletedAt, purgeAt })
  })
}

async function listPrefabs(run: Runtime, wallet: string): Promise<Response> {
  const prefabs: PrefabManifest[] = []
  for (const key of await run.store.list(keys.prefabs(wallet))) {
    const prefab = await readPrefab(run.store, key)
    if (prefab != null) prefabs.push(prefab)
  }
  prefabs.sort((a, b) => a.name.localeCompare(b.name))
  const used = total((await ownedBlobs(run.store, wallet)).values()) + (await manifestBytes(run.store, wallet))
  return json(200, { prefabs, usage: { bytes: used, limit: run.limits.maxWalletBytes } })
}

async function putPrefab(run: Runtime, wallet: string, name: string, request: Request): Promise<Response> {
  const files = checkFiles((await readJson(request)).files, run.limits)
  return run.lock(STORAGE_LOCK, async () => {
    const key = keys.prefab(wallet, name)
    if ((await run.store.head(key)) != null) return fail(409, 'exists')
    if ((await run.store.list(keys.prefabs(wallet))).length >= run.limits.maxPrefabs) {
      return fail(413, 'too-many-prefabs', { limit: run.limits.maxPrefabs })
    }
    const owned = await ownedBlobs(run.store, wallet)
    const unowned = unownedFiles(files, owned)
    if (unowned != null) return unowned
    const prefab: PrefabManifest = { name, updatedAt: run.now, bytes: total(files.map(([, file]) => file.size)), files: Object.fromEntries(files) }
    const encoded = new TextEncoder().encode(JSON.stringify(prefab))
    const used = total(owned.values()) + (await manifestBytes(run.store, wallet))
    if (used + encoded.byteLength > run.limits.maxWalletBytes) {
      return fail(413, 'quota-exceeded', { used, needed: encoded.byteLength, limit: run.limits.maxWalletBytes })
    }
    const written = await run.store.put(key, encoded, { ifMatch: null, metadata: storedMetadata(encoded) })
    if (written == null) return fail(409, 'exists')
    return json(200, { name, updatedAt: prefab.updatedAt })
  })
}

async function getPrefabFile(run: Runtime, wallet: string, name: string, hash: string): Promise<Response> {
  const prefab = await readPrefab(run.store, keys.prefab(wallet, name))
  return prefab == null ? fail(404, 'not-found') : fileOf(run, prefab.files, hash)
}

// For good: the files go with the next purge once nothing else names them.
function deletePrefab(run: Runtime, wallet: string, name: string): Promise<Response> {
  return run.lock(STORAGE_LOCK, async () => {
    const key = keys.prefab(wallet, name)
    if ((await run.store.head(key)) == null) return fail(404, 'not-found')
    await run.store.delete(key)
    return json(200, { name })
  })
}

async function routePrefabs(run: Runtime, env: Env, wallet: string, request: Request, match: RegExpExecArray): Promise<Response> {
  const method = request.method
  const [, name, action, hash] = match
  if (name === undefined) return method === 'GET' ? listPrefabs(run, wallet) : fail(405, 'method-not-allowed')
  if (!PREFAB_NAME.test(name)) return fail(400, 'invalid-prefab-name')
  if (hash !== undefined) return method === 'GET' ? getPrefabFile(run, wallet, name, hash) : fail(405, 'method-not-allowed')
  if (action === 'manifest' && method === 'PUT') return putPrefab(run, wallet, name, request)
  if (action === 'uploads' && method === 'POST') return requestUploads(run, env, wallet, request)
  if (action === undefined && method === 'DELETE') return deletePrefab(run, wallet, name)
  return fail(405, 'method-not-allowed')
}

async function route(request: Request, env: Env, client: string | undefined): Promise<Response> {
  const run = runtime(env)
  const url = new URL(request.url)
  const base = env.basePath ?? ''
  if (base !== '' && !url.pathname.startsWith(`${base}/`)) return fail(404, 'not-found')
  const path = url.pathname.slice(base.length)
  const method = request.method

  if (client !== undefined) {
    const wait = limited(run, `ip:${client}`, run.limits.ipRequestsPerMinute)
    if (wait != null) return wait
  }
  if (method === 'OPTIONS') return preflight(request)
  if (path === '/health') return json(200, { ok: true, ...(env.version === undefined ? {} : { version: env.version }) })
  const blob = /^\/blobs\/([^/]+)$/.exec(path)
  if (blob != null) return method === 'PUT' ? putBlob(run, env, request, blob[1]) : fail(405, 'method-not-allowed')
  if (path.startsWith('/assistant/')) {
    const auth = await signedBy(request, env, run)
    if ('error' in auth) return fail(auth.status, auth.error)
    // its own budget: assistant traffic never spends a wallet's saves
    const wait = limited(run, `assistant:${auth.wallet}`, run.limits.assistantRequestsPerMinute)
    if (wait !== null) return wait
    if ((await readBody(request, 0)) == null) return fail(413, 'body-too-large')
    return env.assistant?.handle(request, path, auth.wallet, client) ?? fail(503, 'assistant-unavailable')
  }
  const match = /^\/projects(?:\/([^/]+)(?:\/(manifest|uploads|restore)|\/files\/([^/]+))?)?$/.exec(path)
  const prefab = /^\/prefabs(?:\/([^/]+)(?:\/(manifest|uploads)|\/files\/([^/]+))?)?$/.exec(path)
  if (match == null && prefab == null) return fail(404, 'not-found')

  const auth = await signedBy(request, env, run)
  if ('error' in auth) return fail(auth.status, auth.error)
  const { wallet } = auth
  if (env.storageWallets != null && !env.storageWallets.has(wallet)) return fail(403, 'storage-not-allowed')
  const wait = limited(run, wallet)
  if (wait != null) return wait
  if (match == null) return routePrefabs(run, env, wallet, request, prefab as RegExpExecArray)

  const [, id, action, hash] = match
  if (id === undefined) return method === 'GET' ? listProjects(run, wallet) : fail(405, 'method-not-allowed')
  if (!PROJECT_ID.test(id)) return fail(400, 'invalid-project-id')
  if (hash !== undefined) return method === 'GET' ? getFile(run, wallet, id, hash) : fail(405, 'method-not-allowed')
  if (action === 'manifest' && method === 'GET') return getManifest(run, wallet, id)
  if (action === 'manifest' && method === 'PUT') return putManifest(run, wallet, id, request)
  if (action === 'uploads' && method === 'POST') return requestUploads(run, env, wallet, request)
  if (action === 'restore' && method === 'POST') return setDeleted(run, wallet, id, false)
  if (action === undefined && method === 'DELETE') return setDeleted(run, wallet, id, true)
  return fail(405, 'method-not-allowed')
}

/**
 * The whole service: every route, on web-standard APIs only. `client` is the caller's address
 * (src/client-ip.ts); undefined skips the per-address limit.
 */
export async function handle(request: Request, env: Env, client?: string): Promise<Response> {
  const origin = request.headers.get('origin')
  const allowed = origin != null && env.allowedOrigins.includes(origin)
  let response: Response
  try {
    response = origin != null && !allowed ? fail(403, 'origin-not-allowed') : await route(request, env, client)
  } catch (error) {
    if (error instanceof StorageFull) {
      response = retry(503, 'storage-full', 300)
    } else if (error instanceof Refusal) {
      response = error.response
    } else {
      if (env.logError) env.logError(error)
      else console.error('[project-storage]', error)
      response = fail(500, 'internal')
    }
  }
  response.headers.set('vary', 'origin')
  if (allowed) {
    response.headers.set('access-control-allow-origin', origin)
    response.headers.set('access-control-expose-headers', 'retry-after')
  }
  return response
}
