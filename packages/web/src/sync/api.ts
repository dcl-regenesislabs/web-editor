// The project-storage service's API (host contract v1). Every request is signed
// by the host; only the blob uploads go to the urls the service hands out.
import type { StorageUsage } from '@dcl-editor/contract'

export interface ManifestFile {
  hash: string
  size: number
}
export type ManifestFiles = Record<string, ManifestFile>

export interface RemoteProject {
  id: string
  name: string
  version: number
  updatedAt: number
  bytes: number
  deletedAt?: number | null
}

export interface RemoteManifest {
  id: string
  name: string
  version: number
  updatedAt: number
  files: ManifestFiles
}

export interface Upload {
  hash: string
  url: string
  method: string
  headers?: Record<string, string>
}

export type SignedFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: BodyInit | null }
) => Promise<Response>

// The manifest moved on since `baseVersion`.
export class SyncConflictError extends Error {
  constructor(readonly version: number | null) {
    super('The scene was changed on another device')
    this.name = 'SyncConflictError'
  }
}

// The project is in the account's trash: it reads as gone and takes no new version.
export class SyncDeletedError extends Error {
  constructor() {
    super('The scene is in the trash on your account')
    this.name = 'SyncDeletedError'
  }
}

// The service answered, and not with what was asked for. `code` is its own word.
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SyncHttpError'
  }
}

export type SyncFailure = 'signed-out' | 'retry' | 'missing-content' | 'rejected'

// What a failed request means for the copy: try again later, or tell the creator.
export function failureOf(error: unknown): SyncFailure {
  if (error instanceof SyncHttpError) {
    if (error.code === 'missing-blobs') return 'missing-content'
    return error.status >= 500 || error.status === 408 || error.status === 429 ? 'retry' : 'rejected'
  }
  if (error instanceof SyncConflictError || error instanceof SyncDeletedError) return 'rejected'
  if (error instanceof Error && error.message === 'not-signed-in') return 'signed-out'
  // fetch itself failed: no network, or the service is unreachable
  return 'retry'
}

const megabytes = (bytes: unknown): string =>
  typeof bytes === 'number' ? `${Math.round(bytes / (1024 * 1024))} MB` : 'the limit'

// The service answers with codes; these are the ones a creator can act on.
function explain(status: number, code: string, body: Record<string, unknown>): string {
  switch (code) {
    case 'quota-exceeded':
      return `Your account's scene storage is full (${megabytes(body.limit)}). A scene in the trash frees its space 30 days after it was trashed. This one stays on this device.`
    case 'file-too-large':
      return `A file in this scene is larger than the ${megabytes(body.limit)} an account stores per file. The scene stays on this device.`
    case 'too-many-files':
      return `This scene has more files than an account stores (${String(body.limit)}). It stays on this device.`
    case 'too-many-projects':
      return `Your account already holds ${String(body.limit)} scenes, counting the ones in its trash, which stop counting 30 days after they were trashed. This one stays on this device.`
    case 'invalid-path':
      return `"${String(body.path)}" cannot be stored on your account. The scene stays on this device.`
    case 'origin-not-allowed':
      return 'Scene sync is not available from this address.'
  }
  if (status === 401 || status === 403) return 'Your account did not accept this sign-in. Sign in again to sync your scenes.'
  return code === '' ? `The project service answered ${status}` : `The project service answered ${status} (${code})`
}

export interface ProjectsApi {
  list(): Promise<RemoteProject[]>
  // what the account stores, as of the last list(); null before one
  usage?(): StorageUsage | null
  // null when the account has no such project; SyncDeletedError when it is in the trash there
  manifest(id: string): Promise<RemoteManifest | null>
  // the uploads the service still needs, out of `files`
  uploads(id: string, files: ManifestFile[]): Promise<Upload[]>
  putBlob(upload: Upload, bytes: Uint8Array): Promise<void>
  // throws SyncConflictError when `baseVersion` is not the current version, and
  // SyncHttpError 404 when it names a version of a project the account no longer has
  putManifest(id: string, manifest: { name: string; files: ManifestFiles; baseVersion: number | null }): Promise<number>
  blob(id: string, hash: string): Promise<Uint8Array>
  remove(id: string): Promise<void>
  restore(id: string): Promise<void>
}

async function refusal(response: Response): Promise<SyncHttpError> {
  const parsed: unknown = await response.json().catch(() => null)
  const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const code = typeof body.error === 'string' ? body.error : ''
  return new SyncHttpError(response.status, code, explain(response.status, code, body))
}

export function createProjectsApi(
  base: string,
  signedFetch: SignedFetch,
  plainFetch: typeof fetch = (input, init) => fetch(input, init)
): ProjectsApi {
  const json = { 'content-type': 'application/json' }
  async function call(path: string, init?: Parameters<SignedFetch>[1]): Promise<Response> {
    const response = await signedFetch(base + path, init)
    if (response.ok) return response
    const error = await refusal(response)
    throw error.code === 'deleted' ? new SyncDeletedError() : error
  }
  const notFound = (error: unknown): boolean => error instanceof SyncHttpError && error.status === 404
  let usage: StorageUsage | null = null

  return {
    async list() {
      const body = (await (await call('/projects')).json()) as { projects?: RemoteProject[]; usage?: Partial<StorageUsage> }
      const { bytes, limit } = body.usage ?? {}
      usage = typeof bytes === 'number' && typeof limit === 'number' ? { bytes, limit } : null
      return Array.isArray(body.projects) ? body.projects : []
    },
    usage: () => usage,
    async manifest(id) {
      try {
        return (await (await call(`/projects/${id}/manifest`)).json()) as RemoteManifest
      } catch (error) {
        if (notFound(error)) return null
        throw error
      }
    },
    async uploads(id, files) {
      if (files.length === 0) return []
      const response = await call(`/projects/${id}/uploads`, { method: 'POST', headers: json, body: JSON.stringify({ files }) })
      const body = (await response.json()) as { uploads?: Upload[] }
      return Array.isArray(body.uploads) ? body.uploads : []
    },
    async putBlob(upload, bytes) {
      const response = await plainFetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        // fetch rejects shared memory; project bytes are never backed by it
        body: bytes as Uint8Array<ArrayBuffer>
      })
      if (!response.ok) throw await refusal(response)
    },
    async putManifest(id, manifest) {
      const response = await signedFetch(`${base}/projects/${id}/manifest`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify(manifest)
      })
      if (response.status === 409 || response.status === 412) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; version?: number | null }
        throw body.error === 'deleted' ? new SyncDeletedError() : new SyncConflictError(body.version ?? null)
      }
      if (!response.ok) throw await refusal(response)
      const { version } = (await response.json().catch(() => ({}))) as { version?: number | null }
      if (typeof version !== 'number') throw new SyncHttpError(502, '', 'The project service did not say which version it saved')
      return version
    },
    async blob(id, hash) {
      return new Uint8Array(await (await call(`/projects/${id}/files/${hash}`)).arrayBuffer())
    },
    async remove(id) {
      await call(`/projects/${id}`, { method: 'DELETE' }).catch((error: unknown) => {
        if (!notFound(error)) throw error
      })
    },
    async restore(id) {
      await call(`/projects/${id}/restore`, { method: 'POST' })
    }
  }
}

// ---- sharing a project for another account to copy ----

export interface SharedProject {
  name: string
  version: number
  updatedAt: number
  bytes: number
  files: ManifestFiles
}

export interface SharesApi {
  // the project's share token; null while it is not shared
  token(id: string): Promise<string | null>
  // on: the token, the same one while it stays on; off: null
  setShared(id: string, shared: boolean): Promise<string | null>
  // null when the token opens nothing (never given, revoked, or its project is in the trash)
  read(token: string): Promise<SharedProject | null>
  blob(token: string, hash: string): Promise<Uint8Array>
}

export function createSharesApi(base: string, signedFetch: SignedFetch): SharesApi {
  async function call(path: string, init?: Parameters<SignedFetch>[1]): Promise<Response | null> {
    const response = await signedFetch(base + path, init)
    if (response.ok) return response
    const error = await refusal(response)
    if (error.status === 404 && (error.code === 'not-shared' || path.startsWith('/shared/'))) return null
    if (error.code === 'deleted') throw new SyncHttpError(error.status, error.code, 'This scene is in the trash on your account. Restore it to share it.')
    if (error.status === 404) {
      throw new SyncHttpError(error.status, error.code, 'This scene is not on your account yet. Wait until it says Synced, then share it.')
    }
    throw error
  }
  const tokenOf = async (response: Response | null): Promise<string | null> => {
    if (response === null) return null
    const { token } = (await response.json()) as { token?: unknown }
    return typeof token === 'string' ? token : null
  }
  return {
    token: async (id) => tokenOf(await call(`/projects/${id}/share`)),
    async setShared(id, shared) {
      const response = await call(`/projects/${id}/share`, { method: shared ? 'PUT' : 'DELETE' })
      return shared ? tokenOf(response) : null
    },
    async read(token) {
      const response = await call(`/shared/${token}`)
      return response === null ? null : ((await response.json()) as SharedProject)
    },
    async blob(token, hash) {
      const response = await call(`/shared/${token}/files/${hash}`)
      if (response === null) throw new Error('The shared scene changed while it was being copied. Open the link again.')
      return new Uint8Array(await response.arrayBuffer())
    }
  }
}

// ---- the wallet's own prefab library ----

export interface RemotePrefab {
  name: string
  updatedAt: number
  bytes: number
  files: ManifestFiles
}

// Another device saved a prefab under this name first.
export class PrefabNameTaken extends Error {}

export interface PrefabsApi {
  list(): Promise<RemotePrefab[]>
  uploads(name: string, files: ManifestFile[]): Promise<Upload[]>
  putBlob(upload: Upload, bytes: Uint8Array): Promise<void>
  // creates only: PrefabNameTaken when the name is in use
  put(name: string, files: ManifestFiles): Promise<void>
  blob(name: string, hash: string): Promise<Uint8Array>
  // false when there was no such prefab
  remove(name: string): Promise<boolean>
}

function prefabRefusal(error: SyncHttpError, body: { limit?: unknown }): SyncHttpError {
  if (error.code === 'quota-exceeded') {
    return new SyncHttpError(error.status, error.code, `Your account's storage is full (${megabytes(body.limit)}). The prefab stays in this scene.`)
  }
  if (error.code === 'too-many-prefabs') {
    return new SyncHttpError(error.status, error.code, `Your library already holds ${String(body.limit)} prefabs. Remove one to add another.`)
  }
  return error
}

export function createPrefabsApi(
  base: string,
  signedFetch: SignedFetch,
  plainFetch: typeof fetch = (input, init) => fetch(input, init)
): PrefabsApi {
  const projects = createProjectsApi(base, signedFetch, plainFetch)
  const json = { 'content-type': 'application/json' }
  async function call(path: string, init?: Parameters<SignedFetch>[1]): Promise<Response> {
    const response = await signedFetch(base + path, init)
    if (response.ok) return response
    const body = (await response.clone().json().catch(() => ({}))) as { limit?: unknown }
    throw prefabRefusal(await refusal(response), body)
  }
  const named = (name: string): string => `/prefabs/${encodeURIComponent(name)}`

  return {
    async list() {
      const body = (await (await call('/prefabs')).json()) as { prefabs?: RemotePrefab[] }
      return Array.isArray(body.prefabs) ? body.prefabs : []
    },
    async uploads(name, files) {
      if (files.length === 0) return []
      const response = await call(`${named(name)}/uploads`, { method: 'POST', headers: json, body: JSON.stringify({ files }) })
      const body = (await response.json()) as { uploads?: Upload[] }
      return Array.isArray(body.uploads) ? body.uploads : []
    },
    putBlob: (upload, bytes) => projects.putBlob(upload, bytes),
    async put(name, files) {
      try {
        await call(`${named(name)}/manifest`, { method: 'PUT', headers: json, body: JSON.stringify({ files }) })
      } catch (error) {
        if (error instanceof SyncHttpError && error.code === 'exists') throw new PrefabNameTaken(name)
        throw error
      }
    },
    async blob(name, hash) {
      return new Uint8Array(await (await call(`${named(name)}/files/${hash}`)).arrayBuffer())
    },
    async remove(name) {
      try {
        await call(named(name), { method: 'DELETE' })
        return true
      } catch (error) {
        if (error instanceof SyncHttpError && error.status === 404) return false
        throw error
      }
    }
  }
}
