import { describe, expect, it, vi } from 'vitest'
import { ACCESS_AUD as AUD, ACCESS_TEAM as TEAM, accessKeyPair as keyPair, accessToken as token, encodeSegment as encode } from '../testing/access.ts'
import { createAccessVerifier } from './access.ts'
import type { KeyObject } from 'node:crypto'

const NOW = 1_800_000_000_000
const accessToken = (key: KeyObject, kid: string, claims: Record<string, unknown> = {}) => token(key, kid, NOW, claims)

describe('Cloudflare Access tokens', () => {
  const signing = keyPair('k1')
  const forger = keyPair('k1')

  it('accepts only a signed, current token for this team and audience', async () => {
    const verifier = createAccessVerifier({ teamDomain: TEAM, audience: AUD, fetchKeys: async () => [signing.jwk], now: () => NOW })
    expect(await verifier.verify(accessToken(signing.privateKey, 'k1'))).toBe('admin@example.com')
    expect(await verifier.verify(accessToken(forger.privateKey, 'k1'))).toBeUndefined()
    expect(await verifier.verify(accessToken(signing.privateKey, 'k1', { exp: Math.floor(NOW / 1000) - 1 }))).toBeUndefined()
    expect(await verifier.verify(accessToken(signing.privateKey, 'k1', { aud: ['another-app'] }))).toBeUndefined()
    expect(await verifier.verify(accessToken(signing.privateKey, 'k1', { iss: 'https://other.cloudflareaccess.com' }))).toBeUndefined()
    expect(await verifier.verify(accessToken(signing.privateKey, 'k1', { email: undefined, common_name: 'bot' }))).toBeUndefined()
    const [, body] = accessToken(signing.privateKey, 'k1').split('.')
    expect(await verifier.verify(`${encode({ alg: 'none', kid: 'k1' })}.${body}.`)).toBeUndefined()
    expect(await verifier.verify('not-a-token')).toBeUndefined()
  })

  it('caches the keys, bounds refreshes for unknown key ids, and fails when keys cannot be fetched', async () => {
    let clock = NOW
    const fetchKeys = vi.fn(async () => [signing.jwk])
    const verifier = createAccessVerifier({ teamDomain: TEAM, audience: AUD, fetchKeys, now: () => clock })
    await verifier.verify(accessToken(signing.privateKey, 'k1'))
    await verifier.verify(accessToken(signing.privateKey, 'k1'))
    await verifier.verify(accessToken(signing.privateKey, 'unknown'))
    await verifier.verify(accessToken(signing.privateKey, 'unknown'))
    expect(fetchKeys).toHaveBeenCalledTimes(1)
    clock += 61_000
    await verifier.verify(accessToken(signing.privateKey, 'unknown'))
    expect(fetchKeys).toHaveBeenCalledTimes(2)

    const down = createAccessVerifier({ teamDomain: TEAM, audience: AUD, fetchKeys: async () => { throw new Error('certs down') }, now: () => NOW })
    await expect(down.verify(accessToken(signing.privateKey, 'k1'))).rejects.toThrow('certs down')
  })
})
