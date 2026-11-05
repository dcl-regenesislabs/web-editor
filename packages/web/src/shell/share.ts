// Sharing a scene for another account to copy, and making that copy.
import type { EditorShell } from '@dcl-editor/contract'
import { externalDependencies } from '../archive/dependencies'
import type { ProjectStore } from '../store/project-store'
import { type SignedFetch, createSharesApi } from '../sync/api'
import { fetchFiles } from '../sync/transfer'
import type { SyncEngine } from '../sync/types'

// what picks the environment, the service the token belongs to, and what the explorer offers the
// editor with: without `editor-features` a released page has no editor to open the link in
const KEPT_PARAMS = ['baseDomain', 'editor-projects', 'editor-features']
// The link rides on `?editor=<projectId>`, the one entry the explorer hands the editor: the token
// fits its id pattern, and no project the store makes matches this, since its ids end in a
// 4-character tail (store/project-store.ts).
const COPY_ENTRY = /^copy-([a-z2-7]{32})$/

// the share token in an `?editor=` value, or null when it names a project
export function sharedToken(entry: string): string | null {
  return COPY_ENTRY.exec(entry)?.[1] ?? null
}

// This page, opening the editor on a copy of the shared project.
export function shareLink(token: string, page: string): string {
  const here = new URL(page)
  const link = new URL(here.origin + here.pathname)
  for (const kept of KEPT_PARAMS) {
    const value = here.searchParams.get(kept)
    if (value !== null) link.searchParams.set(kept, value)
  }
  link.searchParams.set('editor', `copy-${token}`)
  return link.href
}

export function createSharing(deps: {
  base: string
  signedFetch: SignedFetch
  store: ProjectStore
  sync: Pick<SyncEngine, 'flush' | 'remoteIds' | 'touched'>
  wallet: () => string | null
  install: (id: string, files: Map<string, Uint8Array>) => Promise<void>
  page?: () => string
}): { shell: Pick<EditorShell, 'projectShareLink' | 'setProjectShared'>; copyShared: (token: string) => Promise<{ id: string; created: boolean }> } {
  const { store, sync, wallet } = deps
  const api = createSharesApi(deps.base, deps.signedFetch)
  const link = (token: string | null): string | null => (token === null ? null : shareLink(token, deps.page?.() ?? location.href))
  return {
    shell: {
      projectShareLink: async (id) => (wallet() === null ? null : link(await api.token(id))),
      setProjectShared: async (id, shared) => {
        if (wallet() === null) throw new Error('Sign in to share a scene.')
        // what is waiting to be sent is what the link should open
        if (shared) await sync.flush(id)
        return link(await api.setShared(id, shared))
      }
    },
    // copied into a new project of this account's: from then on it is the copier's own
    async copyShared(token) {
      if (wallet() === null) throw new Error('Sign in to make your own copy of a shared scene.')
      // the explorer keeps `?editor=` in the url, so a reload opens the same link again
      const made = (await store.list()).find((record) => record.copiedFrom === token)
      if (made !== undefined) return { id: made.id, created: false }
      const shared = await api.read(token)
      if (shared === null) throw new Error('This link no longer opens a scene: its owner stopped sharing it, or moved it to the trash.')
      const files = await fetchFiles({ blob: (_id, hash) => api.blob(token, hash) }, '', Object.entries(shared.files), () => {})
      const record = await store.create(shared.name, files, { taken: sync.remoteIds() })
      await store.patch(record.id, { copiedFrom: token })
      sync.touched(record.id, 'scene.json')
      // downloaded now, so the copy's first build finds them
      if (Object.keys(externalDependencies(files.get('package.json'))).length > 0) {
        void deps.install(record.id, files).catch((error: unknown) => console.warn('[editor] could not install the packages of', record.id, error))
      }
      return { id: record.id, created: true }
    }
  }
}
