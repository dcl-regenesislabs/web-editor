// Generate a fresh Ethereum wallet as a { address, privateKey, publicKey } JSON file — the shape
// loadPoolSigner expects for POOL_SIGNER_KEY_FILE (src/pool/signer.ts). The private key is written
// to the file only, never printed. Keep the file outside STORAGE_DIR.
//   node packages/service/scripts/new-wallet.ts --out ~/.config/boedo-name-pool/signer.json
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'

const { values } = parseArgs({ options: { out: { type: 'string' }, force: { type: 'boolean', default: false } } })
if (!values.out) {
  console.error('usage: node packages/service/scripts/new-wallet.ts --out <path/to/wallet.json> [--force]')
  process.exit(2)
}
if (existsSync(values.out) && !values.force) {
  console.error(`${values.out} already exists. Refusing to overwrite a key file; pass --force to replace it.`)
  process.exit(1)
}

const wallet = createUnsafeIdentity()

// 0700 dir / 0600 file: a private key only its owner may read, like the pool state file (src/pool/state.ts).
mkdirSync(dirname(values.out), { recursive: true, mode: 0o700 })
writeFileSync(values.out, `${JSON.stringify(wallet, null, 2)}\n`, { mode: 0o600 })
chmodSync(values.out, 0o600)

console.log(`wallet ${wallet.address}`)
console.log(`saved to ${values.out} (0600) — the private key is in the file, not printed`)
