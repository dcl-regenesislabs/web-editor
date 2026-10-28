import { createPublicKey, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

// Cloudflare Access JWT verification with node:crypto only, as in the wearable validator's server.

export interface AccessJwk {
  kid: string
  kty: string
  n: string
  e: string
}

export interface AccessVerifier {
  /** The signed-in email, or undefined for a token that does not verify; rejects only when the keys could not be fetched. */
  verify(token: string): Promise<string | undefined>
}

// an unknown kid refreshes the keys at most this often, so forged tokens cannot make us hammer Cloudflare
const REFRESH_INTERVAL_MS = 60_000
const CERTS_TIMEOUT_MS = 5_000

export const certsUrl = (teamDomain: string) => `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`

function isJwk(value: unknown): value is AccessJwk {
  if (typeof value !== 'object' || value === null) return false
  const jwk = value as Record<string, unknown>
  return typeof jwk.kid === 'string' && typeof jwk.kty === 'string' && typeof jwk.n === 'string' && typeof jwk.e === 'string'
}

async function fetchAccessKeys(url: string): Promise<AccessJwk[]> {
  const response = await fetch(url, { signal: AbortSignal.timeout(CERTS_TIMEOUT_MS), redirect: 'error' })
  if (!response.ok) throw new Error(`Cloudflare Access certs answered ${response.status}`)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('keys' in body) || !Array.isArray(body.keys)) throw new Error('Cloudflare Access certs returned no key list')
  return body.keys.filter(isJwk)
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export function createAccessVerifier(options: {
  /** The team slug: <teamDomain>.cloudflareaccess.com issues the tokens. */
  teamDomain: string
  /** The Access application's audience tag. */
  audience: string
  fetchKeys?: () => Promise<AccessJwk[]>
  now?: () => number
}): AccessVerifier {
  const issuer = `https://${options.teamDomain}.cloudflareaccess.com`
  const now = options.now ?? Date.now
  const fetchKeys = options.fetchKeys ?? (() => fetchAccessKeys(certsUrl(options.teamDomain)))
  let keys = new Map<string, KeyObject>()
  let lastFetch = -Infinity
  let pending: Promise<void> | undefined

  // only a successful fetch replaces the keys: a failed refresh keeps serving the cached ones
  function refresh(): Promise<void> {
    pending ??= (async () => {
      lastFetch = now()
      try {
        const next = new Map<string, KeyObject>()
        for (const jwk of await fetchKeys()) {
          if (jwk.kty !== 'RSA') continue
          next.set(jwk.kid, createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }))
        }
        keys = next
      } finally {
        pending = undefined
      }
    })()
    return pending
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    const cached = keys.get(kid)
    if (cached !== undefined) return cached
    if (now() - lastFetch < REFRESH_INTERVAL_MS) return undefined
    await refresh()
    return keys.get(kid)
  }

  return {
    async verify(token) {
      const [head, body, signature, ...rest] = token.split('.')
      if (!head || !body || signature === undefined || rest.length > 0) return undefined
      const header = decodeSegment(head)
      const payload = decodeSegment(body)
      if (header === undefined || payload === undefined || header.alg !== 'RS256' || typeof header.kid !== 'string') return undefined
      const key = await keyFor(header.kid)
      if (key === undefined) return undefined
      let signed = false
      try {
        signed = verify('sha256', Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'))
      } catch {
        return undefined
      }
      if (!signed) return undefined
      if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(now() / 1000)) return undefined
      if (typeof payload.nbf === 'number' && payload.nbf > Math.floor(now() / 1000) + 60) return undefined
      if (payload.iss !== issuer) return undefined
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
      if (!audiences.includes(options.audience)) return undefined
      return typeof payload.email === 'string' && payload.email !== '' ? payload.email.toLowerCase() : undefined
    }
  }
}
