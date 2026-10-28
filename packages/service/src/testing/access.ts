import { generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { AccessJwk } from '../admin/access.ts'

export const ACCESS_TEAM = 'regenesis'
export const ACCESS_AUD = 'dashboard-audience'

export function accessKeyPair(kid: string): { privateKey: KeyObject; jwk: AccessJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  return { privateKey, jwk: { kid, kty: 'RSA', n: String(jwk.n), e: String(jwk.e) } }
}

export const encodeSegment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A token shaped like the ones Cloudflare Access issues, signed with a test key. */
export function accessToken(key: KeyObject, kid: string, now: number, claims: Record<string, unknown> = {}): string {
  const head = encodeSegment({ alg: 'RS256', kid })
  const body = encodeSegment({
    iss: `https://${ACCESS_TEAM}.cloudflareaccess.com`, aud: [ACCESS_AUD], email: 'Admin@Example.com',
    exp: Math.floor(now / 1000) + 600, sub: 'user', ...claims
  })
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`
}
