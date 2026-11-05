// What the model remembers of a conversation, kept across reconnects and restarts. Each one is
// encrypted with a key only the creator's browser holds: the service keeps the key in memory while
// the conversation is open and never writes it, so a stored file can't be read without that browser.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MEMORY_ID = /^[a-f0-9]{32}$/
export const MEMORY_KEY = /^[A-Za-z0-9_-]{43}$/
const WALLET = /^0x[a-f0-9]{40}$/

export interface MemoryRef {
  id: string
  key: string
}

/**
 * saved: kept as it is; trimmed: kept with its oldest images replaced by a note; too_large: still past the size cap
 * without them, so it is not kept; full: the volume budget is spent; skipped: an invalid ref or someone else's copy.
 */
export type MemorySaveResult = 'saved' | 'trimmed' | 'too_large' | 'full' | 'skipped'

/** The conversations of one signed-in wallet, on one connection. */
export interface WalletMemory {
  /** Null when there is none, or it can't be opened with this key. */
  load(ref: MemoryRef): Promise<unknown[] | null>
  save(ref: MemoryRef, entries: unknown[]): Promise<MemorySaveResult | void>
  forget(id: string): Promise<void>
}

export interface AssistantMemory {
  forWallet(wallet: string): WalletMemory
  /** Removes conversations unused for longer than the retention. */
  sweep(now?: number): Promise<number>
}

export const DEFAULT_MEMORY_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  perWallet: 20,
  // it shares the volume with everyone's projects: past this, conversations stop being kept
  totalBytes: 2 * 1024 * 1024 * 1024
}

export const TRIMMED_IMAGE_NOTE = '[An image was here. It was removed to keep this conversation within its size limit.]'

function isImage(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { type?: unknown }).type === 'image' &&
    typeof (value as { data?: unknown }).data === 'string'
}

/**
 * Screenshots and pasted images are most of a long conversation's bytes, and the oldest are the least use to the
 * model: they go first, oldest to newest, until the conversation fits. The live session keeps them; only the stored
 * copy is trimmed, so this costs one cache rewrite when the conversation is restored and nothing before.
 */
export function fitMemory(entries: unknown[], maxBytes: number): { entries: unknown[]; plain: Buffer; trimmed: number } {
  let plain = Buffer.from(JSON.stringify(entries), 'utf8')
  if (plain.length <= maxBytes) return { entries, plain, trimmed: 0 }
  const copy: unknown = JSON.parse(plain.toString('utf8'))
  if (!Array.isArray(copy)) return { entries, plain, trimmed: 0 }
  const images: Array<{ holder: unknown[]; index: number; bytes: number }> = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (isImage(item)) images.push({ holder: value, index, bytes: Buffer.byteLength(JSON.stringify(item)) })
        else walk(item)
      })
    } else if (value !== null && typeof value === 'object') for (const child of Object.values(value)) walk(child)
  }
  walk(copy)
  const note = Buffer.byteLength(JSON.stringify({ type: 'text', text: TRIMMED_IMAGE_NOTE }))
  let size = plain.length
  let trimmed = 0
  for (const image of images) {
    if (size <= maxBytes) break
    image.holder[image.index] = { type: 'text', text: TRIMMED_IMAGE_NOTE }
    size -= image.bytes - note
    trimmed++
  }
  if (trimmed === 0) return { entries, plain, trimmed: 0 }
  plain = Buffer.from(JSON.stringify(copy), 'utf8')
  return { entries: copy, plain, trimmed }
}

export function createAssistantMemory(dir: string, limits = DEFAULT_MEMORY_LIMITS): AssistantMemory {
  const file = (wallet: string, id: string) => join(dir, wallet, `${id}.bin`)
  const aad = (wallet: string, id: string) => Buffer.from(`${wallet}/${id}`)
  const size = async (path: string) => (await stat(path).catch(() => null))?.size ?? 0
  let used: Promise<number> | null = null
  let writes: Promise<unknown> = Promise.resolve()

  async function files(): Promise<Array<{ path: string; wallet: string; mtimeMs: number; size: number }>> {
    const found = []
    for (const wallet of await readdir(dir).catch(() => [])) {
      if (!WALLET.test(wallet)) continue
      for (const name of await readdir(join(dir, wallet)).catch(() => [])) {
        const path = join(dir, wallet, name)
        const info = await stat(path).catch(() => null)
        if (info !== null) found.push({ path, wallet, mtimeMs: info.mtimeMs, size: info.size })
      }
    }
    return found
  }
  const total = () => (used ??= files().then((all) => all.reduce((sum, f) => sum + f.size, 0)))
  async function remove(path: string): Promise<void> {
    const sum = await total()
    const bytes = await size(path)
    await rm(path, { force: true })
    used = Promise.resolve(sum - bytes)
  }
  // one write at a time, so the running total and the per-wallet count stay true
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writes.then(work, work)
    writes = next.catch(() => {})
    return next
  }

  return {
    forWallet(raw: string): WalletMemory {
      const wallet = raw.toLowerCase()
      if (!WALLET.test(wallet)) throw new Error('Invalid wallet')
      // a copy this connection couldn't open is someone's other key: never written over
      const locked = new Set<string>()
      return {
        async load(ref) {
          if (!MEMORY_ID.test(ref.id) || !MEMORY_KEY.test(ref.key)) return null
          let bytes: Buffer
          try {
            bytes = await readFile(file(wallet, ref.id))
          } catch {
            return null
          }
          try {
            const decipher = createDecipheriv('aes-256-gcm', Buffer.from(ref.key, 'base64url'), bytes.subarray(0, 12))
            decipher.setAAD(aad(wallet, ref.id))
            decipher.setAuthTag(bytes.subarray(12, 28))
            const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
            const entries: unknown = JSON.parse(plain.toString('utf8'))
            if (!Array.isArray(entries)) throw new Error('Not a conversation')
            const now = new Date()
            await utimes(file(wallet, ref.id), now, now).catch(() => {})
            locked.delete(ref.id)
            return entries
          } catch {
            locked.add(ref.id)
            return null
          }
        },
        save(ref, entries) {
          return serial(async (): Promise<MemorySaveResult> => {
            if (!MEMORY_ID.test(ref.id) || !MEMORY_KEY.test(ref.key) || locked.has(ref.id)) return 'skipped'
            const target = file(wallet, ref.id)
            const { plain, trimmed } = fitMemory(entries, limits.maxBytes)
            // too big even without images: the next session starts fresh rather than restoring a stale one
            if (plain.length > limits.maxBytes) {
              await remove(target)
              return 'too_large'
            }
            const iv = randomBytes(12)
            const cipher = createCipheriv('aes-256-gcm', Buffer.from(ref.key, 'base64url'), iv)
            cipher.setAAD(aad(wallet, ref.id))
            const sealed = Buffer.concat([iv, Buffer.alloc(16), cipher.update(plain), cipher.final()])
            cipher.getAuthTag().copy(sealed, 12)

            const previous = await size(target)
            let evictions: Array<{ path: string; size: number }> = []
            if (previous === 0) {
              const mine = (await readdir(join(dir, wallet)).catch(() => [])).filter((name) => name.endsWith('.bin'))
              if (mine.length >= limits.perWallet) {
                const ages = await Promise.all(mine.map(async (name) => {
                  const path = join(dir, wallet, name)
                  const info = await stat(path).catch(() => null)
                  return { path, at: info?.mtimeMs ?? 0, size: info?.size ?? 0 }
                }))
                ages.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path))
                evictions = ages.slice(0, mine.length - limits.perWallet + 1)
              }
            }
            const nextTotal = await total() - previous + sealed.length - evictions.reduce((sum, old) => sum + old.size, 0)
            if (nextTotal > limits.totalBytes) return 'full'

            for (const old of evictions) await remove(old.path)
            await mkdir(join(dir, wallet), { recursive: true, mode: 0o700 })
            const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
            await writeFile(temp, sealed, { mode: 0o600 })
            await rename(temp, target)
            used = Promise.resolve(nextTotal)
            return trimmed > 0 ? 'trimmed' : 'saved'
          })
        },
        forget(id) {
          return serial(async () => {
            if (MEMORY_ID.test(id)) await remove(file(wallet, id))
          })
        }
      }
    },
    sweep(now = Date.now()) {
      return serial(async () => {
        let removed = 0
        for (const found of await files()) {
          if (now - found.mtimeMs <= limits.maxAgeMs) continue
          await remove(found.path)
          removed++
        }
        return removed
      })
    }
  }
}
