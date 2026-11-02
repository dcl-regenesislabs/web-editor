// Copies projects to the signed-in account and back. The project in the browser
// is the working copy; the service holds one private, versioned copy per wallet.
//
// Per project the engine remembers the manifest it last agreed on with the
// service (`base`) and the paths written since (`pending`). A push hashes only
// those paths, uploads the content the service lacks, and writes the manifest
// last, against the version it started from. A manifest that moved on in the
// meantime is a conflict: nothing is merged and nothing local is replaced until
// the creator chooses.
import type { ProjectSync, ProjectSyncState, SyncStatus } from '@dcl-editor/contract'
import { ProjectBusyError, storablePath } from '../store/project-store'
import {
  type ManifestFiles,
  type RemoteManifest,
  type RemoteProject,
  SyncConflictError,
  SyncDeletedError,
  SyncHttpError,
  failureOf
} from './api'
import { MovedUnderfoot, type Progress, fetchFiles, liveManifest, localFiles, sameFiles, uploadMissing } from './transfer'
import {
  ATTENTION,
  LIST_FRESH_MS,
  MOVED_TRIES,
  OPEN_CHECK_MS,
  PUSH_DEBOUNCE_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type SyncEngine,
  type SyncEngineOptions,
  type SyncSession,
  type Tracked,
  describe,
  isRecord
} from './types'

export * from './types'

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { store } = options
  const tracked = new Map<string, Tracked>()
  const listeners = new Set<(status: SyncStatus) => void>()
  let trashedIds = new Set<string>()
  let remote: RemoteProject[] = []
  let localIds = new Set<string>()
  let revision = 0
  // a request failed for want of a network; cleared by the next one that works
  let offline = false
  let listError: string | null = null
  let listRetry: ReturnType<typeof setTimeout> | null = null
  let listAttempt = 0
  let listedAt = 0
  // whose list `remote` is: until it is the signed-in wallet's, the scenes only on the account are not known
  let listedFor: string | null = null
  let listing: Promise<void> | null = null
  let lastWallet: string | null = null
  // orders lists against agreed versions: a list asked before a version went through cannot know of it
  let clock = 0
  let disposed = false
  let announced = false
  const inFlight = new Set<Promise<unknown>>()

  function emit(): void {
    if (announced || disposed) return
    announced = true
    queueMicrotask(() => {
      announced = false
      if (disposed) return
      const status = engine.status()
      for (const listener of listeners) listener(status)
    })
  }

  function watch<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => {},
      () => {}
    )
    inFlight.add(settled)
    void settled.then(() => inFlight.delete(settled))
    return work
  }

  function track(id: string): Tracked {
    const found = tracked.get(id)
    if (found !== undefined) return found
    const made: Tracked = {
      loaded: Promise.resolve(),
      record: null,
      pending: new Set(),
      busy: 0,
      conflict: false,
      behind: false,
      error: null,
      attempt: 0,
      moved: 0,
      retry: null,
      debounce: null,
      chain: Promise.resolve(),
      saving: Promise.resolve(),
      agreedAt: 0
    }
    made.loaded = read(id, made)
    tracked.set(id, made)
    return made
  }

  // The record as the store has it. Another tab may have copied the project, or
  // edited it, since this one last looked: what it wrote there is the truth.
  async function read(id: string, t: Tracked): Promise<void> {
    try {
      await t.saving
      const value = await store.syncRecord(id)
      t.record = isRecord(value) ? { ...value, remoteDeleted: value.remoteDeleted === true } : null
      if (isRecord(value)) for (const path of value.pending) t.pending.add(path)
    } catch (error) {
      console.warn(`[editor] could not read the sync record of ${id}`, error)
    }
  }

  function persist(id: string, t: Tracked): Promise<void> {
    const write = t.saving.then(() =>
      store.setSyncRecord(id, t.record === null ? null : { ...t.record, pending: [...t.pending] })
    )
    t.saving = write.catch((error: unknown) => console.warn(`[editor] could not save the sync record of ${id}`, error))
    return t.saving as Promise<void>
  }

  // One operation at a time per project.
  function run<T>(id: string, work: (t: Tracked, session: SyncSession) => Promise<T>): Promise<T | undefined> {
    const t = track(id)
    const next = t.chain.then(async () => {
      await t.loaded
      const session = options.session()
      if (session === null || disposed) return undefined
      if (t.record !== null && t.record.wallet !== session.wallet) return undefined
      t.busy++
      emit()
      try {
        return await work(t, session)
      } finally {
        t.busy--
        t.progress = undefined
        emit()
      }
    })
    t.chain = next.catch(() => {})
    return watch(next)
  }

  // a copy another wallet keeps on this device, or any synced copy while signed out: nothing done
  // here is queued, pushed or trashed for it
  function foreign(t: Tracked): boolean {
    const wallet = options.session()?.wallet ?? null
    return t.record !== null && t.record.wallet !== wallet
  }

  function stopTimers(t: Tracked): void {
    if (t.debounce !== null) clearTimeout(t.debounce)
    if (t.retry !== null) clearTimeout(t.retry)
    t.debounce = null
    t.retry = null
  }

  function schedulePush(id: string, delay: number): void {
    const t = track(id)
    if (t.debounce !== null) clearTimeout(t.debounce)
    t.debounce = setTimeout(() => {
      t.debounce = null
      void push(id)
    }, delay)
  }

  function failed(id: string, t: Tracked, error: unknown, again: () => void): void {
    if (error instanceof SyncConflictError) {
      t.conflict = true
      return
    }
    if (error instanceof MovedUnderfoot && ++t.moved < MOVED_TRIES) {
      schedulePush(id, PUSH_DEBOUNCE_MS)
      return
    }
    const kind = failureOf(error)
    if (kind === 'signed-out') return
    if (kind === 'retry') {
      offline = true
      t.attempt++
      if (t.retry !== null) clearTimeout(t.retry)
      t.retry = setTimeout(() => {
        t.retry = null
        again()
      }, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (t.attempt - 1)))
      return
    }
    t.error = describe(error)
  }

  function succeeded(t: Tracked): void {
    offline = false
    t.error = null
    t.attempt = 0
    t.moved = 0
    if (t.retry !== null) clearTimeout(t.retry)
    t.retry = null
  }

  const progressOf =
    (t: Tracked, also?: Progress): Progress =>
    (done, total) => {
      t.progress = { done, total }
      also?.(done, total)
      emit()
    }

  function push(id: string): Promise<void> {
    return run(id, async (t, { api, wallet }) => {
      if (t.conflict || trashedIds.has(id) || !localIds.has(id)) return
      if (t.record !== null && t.pending.size === 0) return
      const taken = [...t.pending]
      t.pending.clear()
      try {
        const base = t.record?.base ?? {}
        const files = await localFiles(store, options.hash, id, t.record?.base ?? null, taken)
        if (t.record === null || !sameFiles(files, base)) {
          const manifest = { name: await options.title(id), files, baseVersion: t.record?.baseVersion ?? null }
          const put = async (known: ManifestFiles): Promise<number> => {
            await uploadMissing(store, api, id, files, known, progressOf(t))
            return api.putManifest(id, manifest)
          }
          const version = await put(base).catch(async (error: unknown) => {
            if (error instanceof SyncDeletedError) {
              // in the account's trash, and edited here since
              await api.restore(id)
              return put(base)
            }
            // the service lost content it once had: offer everything again
            if (failureOf(error) === 'missing-content') return put({})
            throw error
          })
          t.record = { wallet, baseVersion: version, base: files, pending: [], remoteDeleted: false }
          t.agreedAt = ++clock
        }
        succeeded(t)
        await persist(id, t)
        if (t.pending.size > 0) schedulePush(id, PUSH_DEBOUNCE_MS)
      } catch (error) {
        for (const path of taken) t.pending.add(path)
        if (error instanceof SyncHttpError && error.status === 404 && t.record !== null) {
          // the account no longer has the project this was a version of: copy it as new
          t.record = null
          await persist(id, t)
          schedulePush(id, 0)
          return
        }
        failed(id, t, error, () => void push(id))
      }
    }).then(() => {})
  }

  // Make the project here what the account has. Everything is downloaded before
  // the first file is replaced, so a lost connection leaves the project as it was.
  async function applyRemote(
    id: string,
    t: Tracked,
    session: SyncSession,
    manifest: RemoteManifest,
    local: ManifestFiles,
    progress?: Progress
  ): Promise<void> {
    const wanted = Object.entries(manifest.files).filter(
      ([path, file]) => storablePath(path) && local[path]?.hash !== file.hash
    )
    const files = await fetchFiles(session.api, id, wanted, progressOf(t, progress))
    for (const [path, bytes] of files) await store.write(id, path, bytes)
    for (const path of Object.keys(local)) if (manifest.files[path] === undefined) await store.remove(id, path)
    t.record = { wallet: session.wallet, baseVersion: manifest.version, base: manifest.files, pending: [], remoteDeleted: false }
    t.agreedAt = ++clock
    t.pending.clear()
    t.behind = false
    t.conflict = false
    succeeded(t)
    await persist(id, t)
    revision++
  }

  // A push the service took but whose answer never came back (the editor was closed mid-request)
  // leaves the account a version ahead holding exactly these files: agreement, not a conflict.
  async function agreeIfSame(id: string, t: Tracked, wallet: string, theirs: RemoteManifest): Promise<boolean> {
    const files = await localFiles(store, options.hash, id, t.record?.base ?? null, [...t.pending])
    if (!sameFiles(files, theirs.files)) return false
    t.record = { wallet, baseVersion: theirs.version, base: theirs.files, pending: [], remoteDeleted: false }
    t.agreedAt = ++clock
    t.pending.clear()
    t.conflict = false
    succeeded(t)
    await persist(id, t)
    return true
  }

  function catchUp(id: string, known?: RemoteManifest): Promise<void> {
    return run(id, async (t, session) => {
      if (t.record === null || t.pending.size > 0 || t.conflict) return
      try {
        const manifest = known ?? (await liveManifest(session.api, id))
        if (manifest === null || manifest.version === t.record.baseVersion) {
          t.behind = false
          return
        }
        await applyRemote(id, t, session, manifest, t.record.base)
      } catch (error) {
        // open in another tab: that tab brings it up to date
        if (!(error instanceof ProjectBusyError)) failed(id, t, error, () => void catchUp(id))
      }
    }).then(() => {})
  }

  async function reconcile(id: string, isTrashed: boolean, theirs: RemoteProject | undefined, asked: number): Promise<void> {
    await run(id, async (t, { api, wallet }) => {
      const record = t.record
      try {
        if (isTrashed) {
          if (record === null || theirs === undefined) return
          if (theirs.deletedAt != null) record.remoteDeleted = true
          else if (record.remoteDeleted) {
            // restored on another device
            await store.restore(id)
            record.remoteDeleted = false
            revision++
          } else {
            await api.remove(id)
            record.remoteDeleted = true
          }
          await persist(id, t)
          return
        }
        if (theirs === undefined) {
          // the list was asked before this version went through, so it cannot show it
          if (record !== null && t.agreedAt > asked) return
          // not on the account (any more): what is here is copied as a new project
          if (record !== null) {
            t.record = null
            await persist(id, t)
          }
          schedulePush(id, 0)
          return
        }
        if (record === null) {
          // the same id on both sides, and they have never been the same project
          t.conflict = true
          return
        }
        if (theirs.deletedAt != null) {
          if (!record.remoteDeleted && t.pending.size === 0 && !store.holds(id)) {
            // deleted on another device
            if (await store.trash(id)) {
              record.remoteDeleted = true
              await persist(id, t)
              revision++
            }
            return
          }
          // restored here, or edited here since: this device's word is the later one
          await api.restore(id)
          record.remoteDeleted = false
          await persist(id, t)
        }
        if (theirs.version !== record.baseVersion) {
          if (t.pending.size === 0) t.behind = true
          // the list may be older than a push that has just gone through: ask again
          else {
            const live = await liveManifest(api, id)
            if (live?.version === record.baseVersion) schedulePush(id, 0)
            else if (live === null || !(await agreeIfSame(id, t, wallet, live))) t.conflict = true
          }
          return
        }
        t.behind = false
        if (t.pending.size > 0) schedulePush(id, 0)
      } catch (error) {
        failed(id, t, error, () => void engine.refresh(true))
      }
    })
    const t = track(id)
    if (t.behind && !store.holds(id)) await catchUp(id)
  }

  async function list(): Promise<void> {
    const signedIn = options.session()?.wallet ?? null
    if (signedIn !== lastWallet) {
      // what was true of the previous account says nothing about this one
      lastWallet = signedIn
      listedFor = null
      offline = false
      listError = null
      for (const t of tracked.values()) {
        stopTimers(t)
        t.conflict = false
        t.behind = false
        t.error = null
        t.attempt = 0
      }
    }
    const [alive, dead] = await Promise.all([store.list(), store.trashed()])
    trashedIds = new Set(dead.map((project) => project.id))
    localIds = new Set([...alive, ...dead].map((project) => project.id))
    for (const [id, t] of tracked) {
      if (localIds.has(id)) continue
      stopTimers(t)
      tracked.delete(id)
    }
    await Promise.all(
      [...localIds].map(async (id) => {
        const t = track(id)
        await t.loaded
        if (t.busy === 0) await read(id, t)
      })
    )
    const session = options.session()
    if (session === null) {
      remote = []
      listedFor = null
      emit()
      return
    }
    const asked = ++clock
    try {
      remote = await session.api.list()
      offline = false
      listError = null
      listAttempt = 0
      listedAt = Date.now()
      listedFor = session.wallet
    } catch (error) {
      const kind = failureOf(error)
      if (kind === 'retry') {
        offline = true
        listAttempt++
        if (listRetry !== null) clearTimeout(listRetry)
        listRetry = setTimeout(() => {
          listRetry = null
          void engine.refresh(true)
        }, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (listAttempt - 1)))
      } else if (kind === 'rejected') listError = describe(error)
      emit()
      return
    }
    revision++
    emit()
    const theirs = new Map(remote.map((project) => [project.id, project]))
    for (const project of alive) await reconcile(project.id, false, theirs.get(project.id), asked)
    for (const project of dead) await reconcile(project.id, true, theirs.get(project.id), asked)
    emit()
  }

  function projectState(t: Tracked, wallet: string): ProjectSync {
    if (t.record !== null && t.record.wallet !== wallet) return { state: 'local', otherAccount: true }
    // never synced from here: the account's scene of that id is another scene
    if (t.conflict) return t.record === null ? { state: 'conflict', unrelated: true } : { state: 'conflict' }
    if (t.busy > 0) return { state: 'syncing', progress: t.progress }
    if (t.error !== null) return { state: 'error', message: t.error }
    const settled = t.record !== null && t.pending.size === 0 && !t.behind
    if (settled) return { state: 'synced' }
    return { state: t.retry !== null || offline ? 'offline' : 'syncing' }
  }

  const online = (): void => {
    for (const [id, t] of tracked) {
      if (t.retry === null) continue
      clearTimeout(t.retry)
      t.retry = null
      void push(id)
    }
    if (listRetry !== null) void engine.refresh(true)
  }
  if (typeof window !== 'undefined') window.addEventListener('online', online)

  const engine: SyncEngine = {
    status() {
      const account = options.account()
      const session = options.session()
      const projects: Record<string, ProjectSync> = {}
      for (const id of localIds) {
        const t = tracked.get(id)
        projects[id] = session === null || t === undefined ? { state: 'local' } : projectState(t, session.wallet)
      }
      const states = Object.entries(projects).filter(([id]) => !trashedIds.has(id))
      let state: ProjectSyncState = 'synced'
      if (session === null) state = 'local'
      else if (listError !== null) state = 'error'
      else if (offline) state = 'offline'
      for (const [, project] of states) {
        if (project.state !== 'local' && ATTENTION.indexOf(project.state) < ATTENTION.indexOf(state)) state = project.state
      }
      const message = states.find(([, project]) => project.state === 'error')?.[1].message ?? listError ?? undefined
      const loading = session !== null && listedFor !== session.wallet && listError === null && !offline
      return { account, state, message, projects, revision, ...(loading ? { loading } : {}), usage: session?.api.usage?.() ?? undefined }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    remoteOnly() {
      if (options.session() === null) return []
      return remote
        .filter((project) => project.deletedAt == null && !localIds.has(project.id))
        .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
    },
    remoteIds: () => remote.map((project) => project.id),
    async manifest(id) {
      const t = track(id)
      await t.loaded
      return localFiles(store, options.hash, id, t.record?.base ?? null, [...t.pending])
    },
    refresh(force = false) {
      if (disposed) return Promise.resolve()
      if (listing !== null) return listing
      if (!force && Date.now() - listedAt < LIST_FRESH_MS) return Promise.resolve()
      if (listRetry !== null) clearTimeout(listRetry)
      listRetry = null
      listing = watch(list())
        .catch((error: unknown) => console.warn('[editor] could not compare the scenes with the account', error))
        .finally(() => {
          listing = null
        })
      return listing
    },
    touched(id, path) {
      if (!storablePath(path)) return
      localIds.add(id)
      const t = track(id)
      t.error = null
      void t.loaded.then(() => {
        if (foreign(t)) return
        const fresh = !t.pending.has(path)
        t.pending.add(path)
        if (fresh && t.record !== null) void persist(id, t)
        emit()
      })
      if (options.session() !== null) schedulePush(id, PUSH_DEBOUNCE_MS)
      emit()
    },
    async flush(id) {
      const waiting = [...tracked].filter(([key, t]) => (id === undefined || key === id) && t.debounce !== null)
      await Promise.all(
        waiting.map(([key, t]) => {
          if (t.debounce !== null) clearTimeout(t.debounce)
          t.debounce = null
          return push(key)
        })
      )
    },
    async prepareOpen(id, progress) {
      const session = options.session()
      if (!localIds.has(id) && !(await store.list()).some((project) => project.id === id)) {
        if (session === null) throw new Error('This scene is not on this device.')
        let manifest: RemoteManifest | null
        let files: Map<string, Uint8Array>
        try {
          manifest = await session.api.manifest(id)
          if (manifest === null) throw new Error('This scene is no longer on your account.')
          files = await fetchFiles(session.api, id, Object.entries(manifest.files), progress ?? (() => {}))
        } catch (error) {
          if (error instanceof SyncHttpError || failureOf(error) !== 'retry') throw error
          throw new Error('This scene is on your account but not on this device yet, and you seem to be offline.')
        }
        await store.create(manifest.name, [...files], { id })
        localIds.add(id)
        const t = track(id)
        await t.loaded
        t.record = { wallet: session.wallet, baseVersion: manifest.version, base: manifest.files, pending: [], remoteDeleted: false }
        t.agreedAt = ++clock
        await persist(id, t)
        revision++
        emit()
        return
      }
      localIds.add(id)
      if (session === null) return
      // Asked after any push in flight, so the answer is never older than what
      // this device just sent. Opening waits OPEN_CHECK_MS for it and no longer:
      // a later push finds out if the account moved on.
      let abandoned = false
      let answered = false
      const check = run(id, async (t, current) => {
        if (abandoned || t.conflict) return
        await read(id, t)
        let theirs: RemoteManifest | null
        try {
          theirs = await liveManifest(current.api, id)
        } catch {
          return
        }
        if (abandoned) return
        answered = true
        if (theirs === null) {
          if (t.record !== null) {
            t.record = null
            await persist(id, t)
          }
          schedulePush(id, 0)
          return
        }
        if (t.record === null || (theirs.version !== t.record.baseVersion && t.pending.size > 0)) {
          if (t.record === null || !(await agreeIfSame(id, t, current.wallet, theirs))) t.conflict = true
          return
        }
        if (theirs.version === t.record.baseVersion) return
        try {
          await applyRemote(id, t, current, theirs, t.record.base, progress)
        } catch (error) {
          // open in another tab: opening it here is refused next, in words
          if (!(error instanceof ProjectBusyError)) failed(id, t, error, () => {})
        }
      })
      await Promise.race([
        check,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            // an answer in hand is acted on to the end: half a download is not opened
            if (answered) return
            abandoned = true
            resolve()
          }, OPEN_CHECK_MS)
        )
      ])
    },
    async resolve(id, choice) {
      const session = options.session()
      if (session === null) throw new Error('Sign in to choose which version to keep.')
      const copy = choice === 'keep-both' ? await options.duplicate(id) : null
      const done = await run(id, async (t, { api, wallet }) => {
        const manifest = await liveManifest(api, id)
        // every file is compared with the other version, whatever was pending
        const files = await localFiles(store, options.hash, id, null, [])
        if (choice === 'keep-local' || manifest === null) {
          await uploadMissing(store, api, id, files, manifest?.files ?? {}, progressOf(t))
          const version = await api.putManifest(id, {
            name: await options.title(id),
            files,
            baseVersion: manifest?.version ?? null
          })
          t.record = { wallet, baseVersion: version, base: files, pending: [], remoteDeleted: false }
          t.agreedAt = ++clock
          t.pending.clear()
          t.conflict = false
          succeeded(t)
          await persist(id, t)
        } else {
          await applyRemote(id, t, { api, wallet }, manifest, files)
        }
        return true
      })
      if (copy !== null) {
        localIds.add(copy)
        schedulePush(copy, 0)
      }
      if (done !== true) throw new Error('Sign in to choose which version to keep.')
      revision++
      emit()
    },
    trashed(id) {
      trashedIds.add(id)
      const t = track(id)
      stopTimers(t)
      // the other account's copy stays as it is: this device forgets it was ever synced
      void t.loaded.then(() => {
        if (!foreign(t)) return
        t.record = null
        t.pending.clear()
        void persist(id, t)
      })
      void run(id, async (_, { api }) => {
        if (t.record === null) return
        try {
          await api.remove(id)
          t.record.remoteDeleted = true
          await persist(id, t)
        } catch {
          /* the next comparison with the account deletes it there */
        }
      })
    },
    restored(id) {
      trashedIds.delete(id)
      const t = track(id)
      void run(id, async (_, { api }) => {
        if (t.record === null) {
          schedulePush(id, 0)
          return
        }
        try {
          if (t.record.remoteDeleted) await api.restore(id)
          t.record.remoteDeleted = false
          await persist(id, t)
          if (t.pending.size > 0) schedulePush(id, 0)
        } catch {
          /* the next comparison with the account restores it there */
        }
      })
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight])
      await Promise.all([...tracked.values()].map((t) => t.saving))
    },
    dispose() {
      disposed = true
      for (const t of tracked.values()) stopTimers(t)
      if (listRetry !== null) clearTimeout(listRetry)
      if (typeof window !== 'undefined') window.removeEventListener('online', online)
      listeners.clear()
    }
  }
  return engine
}
