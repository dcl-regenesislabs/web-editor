// The shell's project sync, as the UI reads it: the status, and the words for it.
import { useEffect, useState } from 'react'
import type { ProjectSync, SyncStatus } from '@dcl-editor/contract'
import { reactive } from '../../core/store'

// Is the conflict question on screen? It is put when a conflict appears, and
// again from the top bar after "Decide later".
export const conflictAsk = reactive({ open: false })

// Null until the shell answers, and for a shell that keeps no copy on an account.
export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  useEffect(() => {
    const shell = window.editorShell
    if (shell?.syncStatus === undefined) return
    let live = true
    void shell.syncStatus().then((first) => live && setStatus((current) => current ?? first))
    const off = shell.onSyncStatus?.((next) => live && setStatus(next))
    return () => {
      live = false
      off?.()
    }
  }, [])
  return status
}

export interface SyncLine {
  text: string
  tone: 'quiet' | 'busy' | 'attention'
}

export const LOADING_LINE: SyncLine = { text: 'Loading your scenes…', tone: 'busy' }

// The one line the home screen shows about where the scenes are kept.
export function syncLine(status: SyncStatus): SyncLine {
  if (status.account === 'guest') return { text: 'Scenes stay on this device until you sign in.', tone: 'quiet' }
  if (status.account === 'unavailable') return { text: 'Scenes stay on this device.', tone: 'quiet' }
  if (status.loading === true) return LOADING_LINE
  switch (status.state) {
    case 'syncing':
      return { text: 'Syncing with your account…', tone: 'busy' }
    case 'offline':
      return { text: 'Offline. Changes are kept on this device and sync when the connection is back.', tone: 'busy' }
    case 'conflict':
      return { text: 'A scene was changed on another device. Open it to choose which version to keep.', tone: 'attention' }
    case 'error':
      return { text: status.message ?? 'A scene could not be synced. It stays on this device.', tone: 'attention' }
    default:
      return { text: 'Synced with your account.', tone: 'quiet' }
  }
}

// A project's state in a word or two; null when there is nothing to say.
export function syncLabel(sync: ProjectSync | undefined): string | null {
  if (sync?.otherAccount === true) return 'Synced with another account'
  switch (sync?.state) {
    case 'syncing':
      return sync.progress !== undefined && sync.progress.total > 0
        ? `Syncing ${sync.progress.done}/${sync.progress.total}`
        : 'Syncing…'
    case 'synced':
      return 'Synced'
    case 'offline':
      return 'Offline, will retry'
    case 'conflict':
      return 'Changed on another device'
    case 'error':
      return 'Not synced'
    default:
      return null
  }
}
