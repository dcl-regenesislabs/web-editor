// What the pool remembers across restarts: who holds which zone, the scene standing in
// it, and who is blocked. Worlds records the pool wallet as the deployer of every guest
// scene, so this file is the only place that knows whose a scene is.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Zone } from './zones.ts'

export interface GuestScene {
  entityId: string
  parcels: string[]
  base: string
  title: string
  bytes: number
  publishedAt: number
}

export interface Lease {
  wallet: string
  name: string
  zone: Zone
  /** The client address that asked for it, when the service knows it. */
  ip: string | null
  leasedAt: number
  scene: GuestScene | null
}

export interface Block {
  reason: string
  at: number
}

export interface PoolState {
  leases: Record<string, Lease>
  blocked: Record<string, Block>
}

export interface StateFile {
  state: PoolState
  /** Writes the current state; calls made while a write runs are folded into the next one. */
  save(): Promise<void>
}

export async function openState(dir: string): Promise<StateFile> {
  const file = join(dir, 'pool.json')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  let state: PoolState
  try {
    state = JSON.parse(await readFile(file, 'utf8')) as PoolState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    state = { leases: {}, blocked: {} }
  }
  let writing: Promise<void> | null = null
  let again = false
  const write = async (): Promise<void> => {
    do {
      again = false
      await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 })
      await rename(`${file}.tmp`, file)
    } while (again)
  }
  return {
    state,
    save() {
      if (writing !== null) {
        again = true
        return writing
      }
      writing = write().finally(() => { writing = null })
      return writing
    }
  }
}
