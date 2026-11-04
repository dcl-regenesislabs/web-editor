import { keys } from './paths.ts'
import { readAll } from './store.ts'
import type { BlobStore } from './store.ts'

export interface ManifestFile {
  hash: string
  size: number
}

export interface Manifest {
  id: string
  name: string
  /** 1 for the first write, +1 for each one after. */
  version: number
  /** ms since epoch */
  updatedAt: number
  /** Sum of the file sizes. */
  bytes: number
  files: Record<string, ManifestFile>
  /** ms since epoch; set while the project is in the trash. */
  deletedAt?: number
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export const encodeManifest = (manifest: Manifest): Uint8Array => encoder.encode(JSON.stringify(manifest))

export async function readManifest(store: BlobStore, key: string): Promise<{ manifest: Manifest; etag: string } | null> {
  const object = await store.get(key)
  if (object == null) return null
  return { manifest: JSON.parse(decoder.decode(await readAll(object.body))) as Manifest, etag: object.etag }
}

export const loadManifest = (store: BlobStore, wallet: string, id: string) => readManifest(store, keys.manifest(wallet, id))

export type ProjectSummary = Pick<Manifest, 'id' | 'name' | 'version' | 'updatedAt' | 'bytes' | 'deletedAt'>

export const summarize = ({ id, name, version, updatedAt, bytes, deletedAt }: Manifest): ProjectSummary =>
  ({ id, name, version, updatedAt, bytes, deletedAt })

/** Object metadata stored with a manifest, so listing projects reads no manifest bodies. */
export const summaryMetadata = (manifest: Manifest): Record<string, string> => ({ summary: JSON.stringify(summarize(manifest)) })

export function readSummary(metadata: Record<string, string> | undefined): ProjectSummary | null {
  try {
    const value: unknown = JSON.parse(metadata?.summary ?? 'null')
    const summary = value as ProjectSummary | null
    if (summary == null || typeof summary.id !== 'string' || !Number.isSafeInteger(summary.version)) return null
    return summary
  } catch {
    return null
  }
}

/** A prefab in a wallet's library: written once, deleted for good, never versioned. */
export interface PrefabManifest {
  name: string
  /** ms since epoch */
  updatedAt: number
  bytes: number
  files: Record<string, ManifestFile>
}

export async function readPrefab(store: BlobStore, key: string): Promise<PrefabManifest | null> {
  const object = await store.get(key)
  return object == null ? null : (JSON.parse(decoder.decode(await readAll(object.body))) as PrefabManifest)
}

/** A project's share flag: another account may copy it through `token` while it exists. */
export interface ShareRecord {
  token: string
  /** ms since epoch */
  createdAt: number
}

async function readObject(store: BlobStore, key: string): Promise<Record<string, unknown> | null> {
  const object = await store.get(key)
  if (object == null) return null
  const value: unknown = JSON.parse(decoder.decode(await readAll(object.body)))
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export async function readShare(store: BlobStore, key: string): Promise<ShareRecord | null> {
  const value = await readObject(store, key)
  return typeof value?.token === 'string' && typeof value.createdAt === 'number' ? { token: value.token, createdAt: value.createdAt } : null
}

export async function readShareIndex(store: BlobStore, key: string): Promise<{ wallet: string; id: string } | null> {
  const value = await readObject(store, key)
  return typeof value?.wallet === 'string' && typeof value.id === 'string' ? { wallet: value.wallet, id: value.id } : null
}
