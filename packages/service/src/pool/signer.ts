// The pool wallet: every pool NAME grants it world-wide deployment. It is a deployment
// delegate, not the NAMEs' owner: a leaked key can deploy and undeploy in the pool
// worlds, but cannot move a NAME or funds, and the owner can revoke it.
import { readFileSync } from 'node:fs'
import { Authenticator } from '@dcl/crypto'
import type { AuthChain, AuthIdentity, IdentityType } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'

const EPHEMERAL_MS = 10 * 60_000
const KEY = /^(0x)?[0-9a-f]{64}$/i

export interface PoolSigner {
  address: string
  signEntity(entityId: string): AuthChain
  /** ADR-44 signed fetch as the pool wallet, for the Worlds calls that need one (undeploy). */
  signedFetch(url: string, init?: { method?: string }): Promise<Response>
}

/** Parse and validate the `{ address, privateKey, publicKey }` JSON (the shape `createUnsafeIdentity` returns). */
export function poolSignerFromJson(raw: string, send: typeof fetch = fetch): PoolSigner {
  let owner: Partial<IdentityType>
  try {
    owner = JSON.parse(raw) as Partial<IdentityType>
  } catch {
    throw new Error('The pool signer key must be JSON { address, privateKey, publicKey }')
  }
  if (typeof owner.address !== 'string' || typeof owner.privateKey !== 'string' || !KEY.test(owner.privateKey) || typeof owner.publicKey !== 'string') {
    throw new Error('The pool signer key must hold { address, privateKey, publicKey }')
  }
  return createPoolSigner(owner as IdentityType, send)
}

/** Read the signer key from a JSON file of `{ address, privateKey, publicKey }`. */
export function loadPoolSigner(file: string, send: typeof fetch = fetch): PoolSigner {
  return poolSignerFromJson(readFileSync(file, 'utf8'), send)
}

export function createPoolSigner(owner: IdentityType, send: typeof fetch = fetch): PoolSigner {
  let session: AuthIdentity | null = null
  // a short-lived key signs the requests, so the pool key itself signs once per window
  const identity = (): AuthIdentity => {
    if (session !== null && session.expiration.getTime() - Date.now() > 60_000) return session
    const ephemeral = createUnsafeIdentity()
    const expiration = new Date(Date.now() + EPHEMERAL_MS)
    const message = Authenticator.getEphemeralMessage(ephemeral.address, expiration)
    session = {
      ephemeralIdentity: ephemeral,
      expiration,
      authChain: [
        { type: 'SIGNER', payload: owner.address, signature: '' },
        { type: 'ECDSA_EPHEMERAL', payload: message, signature: Authenticator.createSignature(owner, message) }
      ] as AuthChain
    }
    return session
  }

  return {
    address: owner.address.toLowerCase(),
    signEntity: (entityId) => Authenticator.createSimpleAuthChain(entityId, owner.address, Authenticator.createSignature(owner, entityId)),
    signedFetch(url, init = {}) {
      const method = init.method ?? 'GET'
      const timestamp = String(Date.now())
      const metadata = JSON.stringify({ signer: 'dcl:editor:name-pool' })
      // the Worlds server checks the pathname only
      const payload = [method, new URL(url).pathname, timestamp, metadata].join(':').toLowerCase()
      const headers: Record<string, string> = { 'x-identity-timestamp': timestamp, 'x-identity-metadata': metadata }
      Authenticator.signPayload(identity(), payload).forEach((link, index) => {
        headers[`x-identity-auth-chain-${index}`] = JSON.stringify(link)
      })
      return send(url, { method, headers, signal: AbortSignal.timeout(15_000) })
    }
  }
}
