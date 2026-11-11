// Projects in the browser: one folder per project in the Origin Private File
// System, and an index of them next to it.
//
//   dcl-editor/index.json          { version, projects: ProjectRecord[] }
//   dcl-editor/projects/<id>/…     the project's files
//   dcl-editor/sync/<id>.json      where the account's copy of it stands
//   dcl-editor/assistant/<id>@<wallet>.json  that wallet's assistant chat, for display only
//   dcl-editor/packages/…          the npm packages projects are frozen to (package-store.ts)
//
// Deleting a project only marks its record; the files go when the trash is
// purged. Writing needs the project's lock, which one tab at a time holds.
import { PROJECT_ID_PATTERN } from '@dcl-editor/scene-compiler'
import { type DirEntry, type FileEntry, type StoreBackend, isNotFound } from './fs'
import { OpfsPackageStore } from './package-store'

export interface ProjectRecord {
  id: string
  // as typed when the project was made; the title shown is scene.json's
  name: string
  createdAt: number
  lastOpened: number
  favourite: boolean
  // null unless the project is in the trash
  deletedAt: number | null
  // the last publish made from this device
  published?: PublishedRecord
  // the preview realm's id: random, so no other scene can find the unpublished build by its name
  previewId?: string
  // the share token this project was copied from, so opening the same link again finds it
  copiedFrom?: string
}

export interface PublishedRecord {
  world: string
  entityId: string
  url: string
  files: number
  bytes: number
  at: number
}

export class ProjectBusyError extends Error {
  constructor(id: string) {
    super(`"${id}" is open in another tab`)
    this.name = 'ProjectBusyError'
  }
}

const ROOT = 'dcl-editor'
const INDEX_FILE = 'index.json'
const INDEX_LOCK = 'dcl-editor-index'
const projectLock = (id: string): string => `dcl-editor-project:${id}`

// bidi controls make a path read as something it is not
export const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/

function segmentsOf(path: string): string[] | null {
  if (path === '' || /[\\\0]/.test(path)) return null
  const segments = path.split('/')
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..') ? null : segments
}

// False for what a project never keeps here: installed packages, build output,
// git history, and env files, which hold secrets.
export function storablePath(path: string): boolean {
  const segments = segmentsOf(path)
  if (segments === null || BIDI.test(path)) return false
  if (segments[0] === 'bin') return false
  // the same rule as the service's, which would refuse the whole save over one of these
  return !segments.some((segment) => {
    const lower = segment.toLowerCase()
    return lower === 'node_modules' || lower === '.git' || lower.startsWith('.env')
  })
}

function slug(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return base.slice(0, 48).replace(/-$/, '') || 'my-scene'
}

function idTail(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => (byte % 36).toString(36)).join('')
}

async function readBytes(file: FileEntry): Promise<Uint8Array> {
  return new Uint8Array(await (await file.getFile()).arrayBuffer())
}

async function writeBytes(file: FileEntry, bytes: Uint8Array): Promise<void> {
  const stream = await file.createWritable()
  // the stream rejects shared memory; project bytes are never backed by it
  await stream.write(bytes as Uint8Array<ArrayBuffer>)
  await stream.close()
}

async function* walk(dir: DirEntry, prefix = ''): AsyncGenerator<[string, FileEntry]> {
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind === 'file') yield [prefix + name, await dir.getFileHandle(name)]
    else yield* walk(await dir.getDirectoryHandle(name), `${prefix}${name}/`)
  }
}

function isIndex(value: unknown): value is { projects: ProjectRecord[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { projects?: unknown }).projects)
}

export class ProjectStore {
  // projects this tab holds open, by their lock's release
  private readonly held = new Map<string, () => void>()
  // this tab's own short writes queue up; only another tab can make one fail
  private queue: Promise<unknown> = Promise.resolve()

  // shared by the projects of this device; never among a project's own files
  readonly packages = new OpfsPackageStore(async () => (await this.base()).getDirectoryHandle('packages', { create: true }))

  constructor(private readonly backend: StoreBackend) {}

  private async base(): Promise<DirEntry> {
    return (await this.backend.root()).getDirectoryHandle(ROOT, { create: true })
  }

  private async projects(): Promise<DirEntry> {
    return (await this.base()).getDirectoryHandle('projects', { create: true })
  }

  private async dir(id: string, create = false): Promise<DirEntry> {
    if (!PROJECT_ID_PATTERN.test(id)) throw new Error(`Invalid project id "${id}"`)
    return (await this.projects()).getDirectoryHandle(id, { create })
  }

  private async records(): Promise<ProjectRecord[]> {
    let file: FileEntry
    try {
      file = await (await this.base()).getFileHandle(INDEX_FILE)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const bytes = await readBytes(file)
    // just created, and its first write has not closed yet
    if (bytes.length === 0) return []
    const index: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!isIndex(index)) throw new Error('The project index is not readable')
    return index.projects
  }

  private mutate<T>(change: (projects: ProjectRecord[]) => Promise<T> | T): Promise<T> {
    return this.backend.locks.request(INDEX_LOCK, {}, async () => {
      const projects = await this.records()
      const result = await change(projects)
      const file = await (await this.base()).getFileHandle(INDEX_FILE, { create: true })
      await writeBytes(file, new TextEncoder().encode(JSON.stringify({ version: 1, projects })))
      return result
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => {})
    return run
  }

  private locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.held.has(id)) return work()
    return this.serial(() =>
      this.backend.locks.request(projectLock(id), { ifAvailable: true }, async (lock) => {
        if (lock === null) throw new ProjectBusyError(id)
        return work()
      })
    )
  }

  private async put(dir: DirEntry, path: string, bytes: Uint8Array): Promise<void> {
    const segments = segmentsOf(path) ?? []
    let folder = dir
    for (const segment of segments.slice(0, -1)) folder = await folder.getDirectoryHandle(segment, { create: true })
    await writeBytes(await folder.getFileHandle(segments[segments.length - 1], { create: true }), bytes)
  }

  private async file(id: string, path: string): Promise<{ folder: DirEntry; name: string }> {
    const segments = segmentsOf(path)
    if (segments === null) throw new Error(`Invalid project path "${path}"`)
    let folder = await this.dir(id)
    for (const segment of segments.slice(0, -1)) folder = await folder.getDirectoryHandle(segment)
    return { folder, name: segments[segments.length - 1] }
  }

  async list(): Promise<ProjectRecord[]> {
    return (await this.records()).filter((project) => project.deletedAt === null)
  }

  async trashed(): Promise<ProjectRecord[]> {
    return (await this.records()).filter((project) => project.deletedAt !== null)
  }

  // Files the store does not keep (see storablePath) are left out. `as.id` names
  // the project (one coming from the account); `as.taken` are ids in use elsewhere.
  create(
    name: string,
    files: Iterable<readonly [string, Uint8Array]>,
    as: { id?: string; taken?: Iterable<string> } = {}
  ): Promise<ProjectRecord> {
    return this.mutate(async (projects) => {
      const taken = new Set([...projects.map((project) => project.id), ...(as.taken ?? [])])
      const base = slug(name)
      // the random tail keeps two devices that both made "My scene" from sharing an id
      let id = as.id ?? `${base}-${idTail()}`
      if (as.id !== undefined && projects.some((project) => project.id === id)) throw new Error(`"${id}" already exists`)
      while (as.id === undefined && taken.has(id)) id = `${base}-${idTail()}`
      await this.writeJson('sync', id, null)
      // a folder with no record is what an interrupted create left behind
      await (await this.projects()).removeEntry(id, { recursive: true }).catch((error: unknown) => {
        if (!isNotFound(error)) throw error
      })
      const dir = await this.dir(id, true)
      for (const [path, bytes] of files) if (storablePath(path)) await this.put(dir, path, bytes)
      const created = Date.now()
      const record: ProjectRecord = { id, name: name.trim(), createdAt: created, lastOpened: created, favourite: false, deletedAt: null }
      projects.push(record)
      return record
    })
  }

  async duplicate(id: string, name: string, taken?: Iterable<string>): Promise<ProjectRecord> {
    return this.create(name, await this.readAll(id), { taken })
  }

  private async writeJson(folder: string, id: string, value: unknown): Promise<void> {
    const dir = await (await this.base()).getDirectoryHandle(folder, { create: true })
    if (value !== null) {
      await writeBytes(await dir.getFileHandle(`${id}.json`, { create: true }), new TextEncoder().encode(JSON.stringify(value)))
      return
    }
    await dir.removeEntry(`${id}.json`).catch((error: unknown) => {
      if (!isNotFound(error)) throw error
    })
  }

  private async readJson(folder: string, name: string): Promise<unknown> {
    try {
      const dir = await (await this.base()).getDirectoryHandle(folder)
      return JSON.parse(new TextDecoder().decode(await readBytes(await dir.getFileHandle(`${name}.json`))))
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) return null
      throw error
    }
  }

  // Null when the project has never been copied to an account.
  syncRecord(id: string): Promise<unknown> {
    return this.readJson('sync', id)
  }

  // Null when this wallet has no chat kept for the project.
  transcript(id: string, wallet: string): Promise<unknown> {
    return this.readJson('assistant', `${id}@${wallet.toLowerCase()}`)
  }

  setTranscript(id: string, wallet: string, value: unknown): Promise<void> {
    return this.writeJson('assistant', `${id}@${wallet.toLowerCase()}`, value)
  }

  // the key that opens what the service keeps of this chat; removed with the transcripts
  assistantMemory(id: string, wallet: string): Promise<unknown> {
    return this.readJson('assistant', `${id}@${wallet.toLowerCase()}.memory`)
  }

  setAssistantMemory(id: string, wallet: string, value: unknown): Promise<void> {
    return this.writeJson('assistant', `${id}@${wallet.toLowerCase()}.memory`, value)
  }

  private async removeTranscripts(id: string): Promise<void> {
    let dir: DirEntry
    try {
      dir = await (await this.base()).getDirectoryHandle('assistant')
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    const names: string[] = []
    for await (const [name] of dir.entries()) if (name.startsWith(`${id}@`)) names.push(name)
    for (const name of names) await dir.removeEntry(name)
  }

  setSyncRecord(id: string, record: unknown): Promise<void> {
    return this.writeJson('sync', id, record)
  }

  patch(id: string, change: Partial<Pick<ProjectRecord, 'lastOpened' | 'favourite' | 'published' | 'previewId' | 'copiedFrom'>>): Promise<void> {
    return this.mutate((projects) => {
      const record = projects.find((project) => project.id === id)
      if (record !== undefined) Object.assign(record, change)
    })
  }

  // False when the project is open, in this tab or another.
  async trash(id: string): Promise<boolean> {
    if (this.held.has(id)) return false
    try {
      return await this.locked(id, () =>
        this.mutate((projects) => {
          const record = projects.find((project) => project.id === id && project.deletedAt === null)
          if (record === undefined) return false
          record.deletedAt = Date.now()
          record.favourite = false
          return true
        })
      )
    } catch (error) {
      if (error instanceof ProjectBusyError) return false
      throw error
    }
  }

  restore(id: string): Promise<boolean> {
    return this.mutate((projects) => {
      const record = projects.find((project) => project.id === id && project.deletedAt !== null)
      if (record === undefined) return false
      record.deletedAt = null
      return true
    })
  }

  // Deletes for good what went to the trash before `before`; resolves their ids and preview ids.
  purge(before: number): Promise<Array<{ id: string; previewId?: string }>> {
    return this.mutate(async (projects) => {
      const gone = projects.filter((project) => project.deletedAt !== null && project.deletedAt < before)
      for (const { id } of gone) {
        await (await this.projects()).removeEntry(id, { recursive: true }).catch((error: unknown) => {
          if (!isNotFound(error)) throw error
        })
        await this.writeJson('sync', id, null)
        await this.removeTranscripts(id)
        projects.splice(projects.findIndex((project) => project.id === id), 1)
      }
      return gone.map(({ id, previewId }) => ({ id, previewId }))
    })
  }

  // Take the project for this tab until close(). False when another tab has it.
  open(id: string): Promise<boolean> {
    if (this.held.has(id)) return Promise.resolve(true)
    return this.serial(
      () =>
        new Promise<boolean>((resolve, reject) => {
          this.backend.locks
            .request(projectLock(id), { ifAvailable: true }, (lock) => {
              if (lock === null) {
                resolve(false)
                return Promise.resolve()
              }
              return new Promise<void>((release) => {
                this.held.set(id, release)
                resolve(true)
              })
            })
            .catch(reject)
        })
    )
  }

  close(id: string): void {
    this.held.get(id)?.()
    this.held.delete(id)
  }

  // Does this tab have the project open?
  holds(id: string): boolean {
    return this.held.has(id)
  }

  async read(id: string, path: string): Promise<Uint8Array> {
    const { folder, name } = await this.file(id, path)
    return readBytes(await folder.getFileHandle(name))
  }

  async paths(id: string): Promise<string[]> {
    const paths: string[] = []
    for await (const [path] of walk(await this.dir(id))) paths.push(path)
    return paths.sort()
  }

  async readAll(id: string): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>()
    for await (const [path, file] of walk(await this.dir(id))) files.set(path, await readBytes(file))
    return files
  }

  write(id: string, path: string, bytes: Uint8Array): Promise<void> {
    if (!storablePath(path)) return Promise.reject(new Error(`"${path}" is not kept in a project`))
    return this.locked(id, async () => this.put(await this.dir(id), path, bytes))
  }

  // False when there was no such file.
  remove(id: string, path: string): Promise<boolean> {
    return this.locked(id, async () => {
      try {
        const { folder, name } = await this.file(id, path)
        await folder.removeEntry(name)
        return true
      } catch (error) {
        if (isNotFound(error)) return false
        throw error
      }
    })
  }
}
