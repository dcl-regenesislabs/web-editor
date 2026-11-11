export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
export const PREFAB_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const WALLET = /^0x[0-9a-f]{40}$/
// 160 random bits, base32 (RFC 4648, lowercase): what a share link carries
export const SHARE_TOKEN = /^[a-z2-7]{32}$/

const MAX_PATH = 512
// bidi controls make a path or name read as something it is not
export const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/

/** Why a project file path is refused, or null when it may be stored. */
export function pathProblem(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH) return 'length'
  if (path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || BIDI.test(path)) return 'characters'
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) return 'absolute'
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'segment'
    const lower = segment.toLowerCase()
    if (lower === 'node_modules' || lower === '.git') return 'excluded'
    if (lower.startsWith('.env')) return 'secret'
  }
  return null
}

export const keys = {
  blob: (hash: string) => `blobs/${hash}`,
  wallets: 'wallets/',
  markers: (wallet: string) => `wallets/${wallet}/blobs/`,
  // the size rides in the key so one listing answers ownership, sizes and usage
  marker: (wallet: string, hash: string, size: number) => `wallets/${wallet}/blobs/${hash}.${size}`,
  projects: (wallet: string) => `wallets/${wallet}/projects/`,
  manifest: (wallet: string, id: string) => `wallets/${wallet}/projects/${id}/manifest.json`,
  histories: (wallet: string, id: string) => `wallets/${wallet}/projects/${id}/history/`,
  history: (wallet: string, id: string, version: number) => `wallets/${wallet}/projects/${id}/history/${version}.json`,
  // the project's share flag: { token, createdAt } while another account may copy it
  share: (wallet: string, id: string) => `wallets/${wallet}/projects/${id}/share.json`,
  // a share link's token -> { wallet, id }; only believed while that project's flag names the same token
  shared: (token: string) => `shares/${token}.json`,
  prefabs: (wallet: string) => `wallets/${wallet}/prefabs/`,
  prefab: (wallet: string, name: string) => `wallets/${wallet}/prefabs/${name}.json`,
  // the expiry leads, zero-padded, so a listing is oldest first
  tickets: 'uploads/tickets/',
  ticket: (expires: number, wallet: string, id: string) => `uploads/tickets/${String(expires).padStart(15, '0')}.${wallet}.${id}`,
  purgeCursor: 'purge/cursor.json'
}

export const ticketExpiry = (key: string): number => Number(/\/(\d{15})\.[0-9a-fx.]+$/.exec(key)?.[1] ?? NaN)
export const ticketWallet = (key: string): string | undefined => /\/\d{15}\.(0x[0-9a-f]{40})\.[0-9a-f]+$/.exec(key)?.[1]

export function parseMarker(key: string): { hash: string; size: number } | null {
  const match = /\/blobs\/([a-z2-7]+)\.(\d+)$/.exec(key)
  return match == null ? null : { hash: match[1], size: Number(match[2]) }
}
