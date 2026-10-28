import { assistantReadable } from '@dcl-editor/contract'
import { state } from '@scene/state'
import { listLibrary, copyLibraryPrefabIntoProject } from '../prefabs/library'
import { readPrefabData } from '../prefabs/storage'
import { inspectModel } from '../model-info'

const PAGE_SIZE = 30

function page<T>(entries: T[], request: Record<string, unknown>, searchable: (entry: T) => string) {
  const words = typeof request.query === 'string' ? request.query.toLowerCase().trim().split(/\s+/) : []
  const offset = typeof request.offset === 'number' && Number.isSafeInteger(request.offset) && request.offset > 0 ? request.offset : 0
  const matches = entries.filter((entry) => words.every((word) => searchable(entry).toLowerCase().includes(word)))
  const results = matches.slice(offset, offset + PAGE_SIZE)
  return { total: matches.length, offset, nextOffset: offset + results.length < matches.length ? offset + results.length : null, results }
}

// the project's files as the host holds them: the browser's copy, or the files the desktop read for this call
export interface AssetProject {
  files(): ReadonlyMap<string, Uint8Array>
}

export function createAssetRequests(project: AssetProject) {
  return async (request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted()
    if (request.action === 'search_prefabs') {
      const library = (await listLibrary()).map((p) => ({ ref: p.ref, scope: p.scope, ...p.data }))
      const local = [...project.files()].flatMap(([path, bytes]) => {
        if (!/^custom\/[^/]+\/data\.json$/.test(path)) return []
        const data = readPrefabData(new TextDecoder().decode(bytes), path)
        return [{ ref: path.slice(0, -'/data.json'.length), scope: 'project', ...data }]
      })
      signal.throwIfAborted()
      return page([...local, ...library].map(({ ref, scope, id, name, description, tags, requiresSdk, requiredPermissions }) =>
        ({ ref, scope, id, name, description, tags, requiresSdk, requiredPermissions })), request,
      (p) => [p.name, p.description ?? '', ...p.tags].join(' '))
    }
    if (request.action === 'inspect_model') {
      const path = request.path
      if (typeof path !== 'string' || !/\.(glb|gltf)$/i.test(path) || !assistantReadable(path.replace(/\.(glb|gltf)$/i, '.json'))) {
        throw new Error('Choose a model path from list_files.')
      }
      const bytes = project.files().get(path)
      if (bytes === undefined) throw new Error('That model is not in the project.')
      return { path, ...inspectModel(bytes) }
    }
    if (!state.frozen) throw new Error('Stop Play before importing assets.')
    if (request.action === 'import_prefab') {
      if (typeof request.ref !== 'string') throw new Error('Choose a prefab ref from search_prefabs.')
      if (request.ref.startsWith('custom/') && project.files().has(`${request.ref}/data.json`)) {
        return { folder: request.ref, reused: true, guide: project.files().has(`${request.ref}/ai.md`) ? `${request.ref}/ai.md` : null }
      }
      const entry = (await listLibrary()).find((p) => p.ref === request.ref)
      if (entry === undefined) throw new Error('Choose an exact prefab ref from search_prefabs.')
      signal.throwIfAborted()
      if (!state.frozen) throw new Error('Stop Play before importing assets.')
      const result = await copyLibraryPrefabIntoProject(entry.ref)
      return { ...result, guide: project.files().has(`${result.folder}/ai.md`) ? `${result.folder}/ai.md` : null }
    }
    throw new Error('Unknown asset action.')
  }
}
