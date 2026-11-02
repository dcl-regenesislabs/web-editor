// What a shell that keeps the projects itself (the web target) tells the UI about
// them: where the account's copy of each stands, and what an import brought in.

// ---- Project sync ----
// A shell that keeps projects itself (the web target) can copy them to the
// signed-in account. `local`: nothing is copied (guest, no service, or another
// account's scene). `offline`: the copy is behind and is being retried.
export type ProjectSyncState = 'local' | 'syncing' | 'synced' | 'offline' | 'conflict' | 'error'

export interface ProjectSync {
  state: ProjectSyncState
  // what the service refused, in words, for `error`
  message?: string
  // files moved so far by the upload or download under way
  progress?: { done: number; total: number }
  // synced by a wallet other than the one signed in: kept here, never synced from here
  otherAccount?: boolean
  // a conflict with a scene the account holds under the same id that was never this one
  unrelated?: boolean
}

export interface SyncStatus {
  // why nothing is copied, or `on`
  account: 'guest' | 'unavailable' | 'on'
  // the state that most needs attention across the projects
  state: ProjectSyncState
  message?: string
  projects: Record<string, ProjectSync>
  // goes up when the list of scenes itself changed: one arrived, left or was replaced
  revision: number
  // the account's list of scenes has not been read yet, so the scenes only on it are not known
  loading?: boolean
  // what the account stores against its limit, trashed scenes included
  usage?: StorageUsage
}

// "Keep both" names this device's version so it reads true on every device
export function copySuffix(at: Date): string {
  return `(copy, ${at.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})`
}

// a scene in a shell's own trash is deleted for good this long after it went in
export const TRASH_DAYS = 30

export interface StorageUsage {
  bytes: number
  limit: number
}

// `keep-both` loses nothing: this device's version becomes a new scene, and the
// scene takes the other device's version.
export type SyncConflictChoice = 'keep-local' | 'use-remote' | 'keep-both'

// ---- Project import ----
export interface ProjectImportReport {
  id: string
  title: string
  files: number
  // left out: installed packages, build output, git history, env files
  skipped: number
  warnings: string[]
  // package.json dependencies the bundled SDK does not provide: name -> version range
  needsPackages: Record<string, string>
}

export type ProjectImportResult = { ok: true; report: ProjectImportReport } | { ok: false; reason: string }

// ---- npm packages ----
// A shell that builds the scene itself downloads the packages package.json asks
// for once, checks them against their integrity and freezes them: the versions
// in the project's lock file, the files on this device.
export interface ProjectPackages {
  state: 'installing' | 'ready' | 'error'
  // packages stored so far, of those the project is frozen to
  progress?: { done: number; total: number }
  // the project's own dependencies as frozen: name -> version
  installed: Record<string, string>
  // how many packages that takes, their dependencies included
  total: number
  warnings: string[]
  // why they could not be installed, for `error`
  message?: string
}
