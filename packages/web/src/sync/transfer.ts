// Moving a project's files between the browser's store and the service.
import { isNotFound } from '../store/fs'
import { type ProjectStore, storablePath } from '../store/project-store'
import { type ManifestFile, type ManifestFiles, type ProjectsApi, SyncDeletedError, SyncHttpError } from './api'

export type Progress = (done: number, total: number) => void

// An upload that has to start over: the file was written again after it was
// hashed, or the url it was given for has expired.
export class MovedUnderfoot extends Error {}

async function read(store: ProjectStore, id: string, path: string): Promise<Uint8Array | null> {
  try {
    return await store.read(id, path)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

// The project as it is here: `from` with the paths in `changed` hashed again, or
// every file hashed when there is nothing to start from.
export async function localFiles(
  store: ProjectStore,
  hash: (bytes: Uint8Array) => Promise<string>,
  id: string,
  from: ManifestFiles | null,
  changed: Iterable<string>
): Promise<ManifestFiles> {
  const files: ManifestFiles = { ...from }
  for (const path of from === null ? await store.paths(id) : changed) {
    const bytes = storablePath(path) ? await read(store, id, path) : null
    if (bytes === null) delete files[path]
    else files[path] = { hash: await hash(bytes), size: bytes.length }
  }
  return files
}

export function sameFiles(a: ManifestFiles, b: ManifestFiles): boolean {
  const paths = Object.keys(a)
  return paths.length === Object.keys(b).length && paths.every((path) => b[path]?.hash === a[path].hash)
}

// Content first: every blob the service lacks is stored before a manifest names
// it. `known` is a manifest the service already holds the content of.
export async function uploadMissing(
  store: ProjectStore,
  api: ProjectsApi,
  id: string,
  files: ManifestFiles,
  known: ManifestFiles,
  progress: Progress
): Promise<void> {
  const have = new Set(Object.values(known).map((file) => file.hash))
  const sources = new Map<string, { path: string; file: ManifestFile }>()
  for (const [path, file] of Object.entries(files)) if (!have.has(file.hash)) sources.set(file.hash, { path, file })
  const uploads = await api.uploads(id, [...sources.values()].map((source) => source.file))
  progress(0, uploads.length)
  let done = 0
  for (const blob of uploads) {
    const source = sources.get(blob.hash)
    const bytes = source === undefined ? null : await read(store, id, source.path)
    if (bytes === null || bytes.length !== source?.file.size) throw new MovedUnderfoot()
    try {
      await api.putBlob(blob, bytes)
    } catch (error) {
      // the service checks the bytes against the hash it was promised (400, 422),
      // and an upload url is only good for a while (403): both are for a new push
      const again = error instanceof SyncHttpError && [400, 403, 422].includes(error.status)
      throw again ? new MovedUnderfoot() : error
    }
    progress(++done, uploads.length)
  }
}

export async function fetchFiles(
  api: Pick<ProjectsApi, 'blob'>,
  id: string,
  wanted: Array<[string, ManifestFile]>,
  progress: Progress
): Promise<Map<string, Uint8Array>> {
  const byHash = new Map<string, Uint8Array>()
  const files = new Map<string, Uint8Array>()
  for (const [path, file] of wanted) {
    const bytes = byHash.get(file.hash) ?? (await api.blob(id, file.hash))
    byHash.set(file.hash, bytes)
    files.set(path, bytes)
    progress(files.size, wanted.length)
  }
  return files
}

// The account's manifest, taking the project out of the account's trash first
// when it is there: asking for it here means it is wanted.
export async function liveManifest(api: ProjectsApi, id: string) {
  try {
    return await api.manifest(id)
  } catch (error) {
    if (!(error instanceof SyncDeletedError)) throw error
    await api.restore(id)
    return api.manifest(id)
  }
}
