// Environment/endpoint map for the Worlds domain — the same production services
// the decentraland.org creator tools use:
//   - worlds-content-server (deployments, permissions, contributor list)
//   - the marketplace subgraph (which DCL NAMEs the wallet owns)
//   - places API (world thumbnails / live user counts)
//   - creators-data (the once-a-day analytics export behind the Analytics tab)

import { hostV1, isHosted, type SignedServices } from '../../engine/hosted'
import { readKey } from '../../core/persist'

// Hosted, the page says which Worlds server deployments go to, and everything
// read about a world has to come from that same server.
function hostedWorlds(): string | null {
  return hostV1()?.services.worldsContent.replace(/\/+$/, '') ?? null
}
// Hosted with signed services, the page names every service it signs for.
function signed(key: keyof SignedServices): string | null {
  return hostV1()?.services.signed?.[key].replace(/\/+$/, '') ?? null
}
// same env switch as the account feature's auth.ts ('dcl-auth-env' = 'zone' → Sepolia stack)
function zone(): boolean {
  const hosted = hostedWorlds()
  if (hosted !== null) return new URL(hosted).hostname.endsWith('.decentraland.zone')
  return readKey('dcl-auth-env') === 'zone'
}
export function worldsServer(): string {
  const hosted = hostedWorlds()
  if (hosted !== null) return hosted
  return zone() ? 'https://worlds-content-server.decentraland.zone' : 'https://worlds-content-server.decentraland.org'
}
export function placesApi(): string {
  return zone() ? 'https://places.decentraland.zone/api' : 'https://places.decentraland.org/api'
}
export function marketplaceSubgraph(): string {
  return zone() ? 'https://subgraph.decentraland.org/marketplace-sepolia' : 'https://subgraph.decentraland.org/marketplace'
}
export function gatekeeperUrl(): string {
  const hosted = signed('commsGatekeeper')
  if (hosted !== null) return hosted
  return zone() ? 'https://comms-gatekeeper.decentraland.zone' : 'https://comms-gatekeeper.decentraland.org'
}
export function storageUrl(): string {
  const hosted = signed('storage')
  if (hosted !== null) return hosted
  return zone() ? 'https://storage.decentraland.zone' : 'https://storage.decentraland.org'
}
export function multiplayerServerFor(env: 'org' | 'zone'): string {
  return env === 'zone' ? 'https://multiplayer-server.decentraland.zone' : 'https://multiplayer-server.decentraland.org'
}
export function multiplayerServer(): string {
  const hosted = signed('multiplayer')
  if (hosted !== null) return hosted
  return multiplayerServerFor(zone() ? 'zone' : 'org')
}
// Production in both stacks: there is no .zone analytics deployment (the
// creator tools' dev config is byte-identical to their prod one), and a wrong
// host would fail in the one environment we test in.
// The version segment is part of the BASE. Build the request URL by
// concatenation — `new URL('/metrics', metricsApi())` drops /v2, so ADR-44 signs
// a pathname the server never receives and every request 401s with no clue why.
export function metricsApi(): string {
  const hosted = signed('creatorsData')
  if (hosted !== null) return hosted
  return 'https://creators-data.decentraland.org/v2'
}
// Hosted, signing needs the page's services.signed; and storage and creators-data
// only answer decentraland.org's origin, so a local page can't reach them either
export function signedServicesOutOfReach(): boolean {
  if (!isHosted()) return false
  return hostV1()?.services.signed === undefined || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
}
export function chainId(): number {
  return zone() ? 11155111 : 1
}
// The mobile explorer, opened from a phone (a QR on the publish success): its /open
// page takes the world's full name, `.dcl.eth` included, and the scene's base parcel.
export function mobileJumpInUrl(world: string, base: string | null): string {
  const query = new URLSearchParams()
  if (base !== null) query.set('position', base)
  query.set('realm', world.toLowerCase())
  return `https://mobile.dclexplorer.com/open?${query}`
}

// Hosted, into the editor's own page like a publish's link (realm = name on
// Decentraland's servers, the world's url elsewhere); else production bevy-web.
export function jumpInUrl(name: string): string {
  const host = hostV1()
  if (host !== null) {
    const world = name.toLowerCase()
    const server = worldsServer()
    const ours = /\.decentraland\.(org|zone)$/.test(new URL(server).hostname)
    return `${host.pageDir}?realm=${encodeURIComponent(ours ? world : `${server}/world/${world}`)}`
  }
  return `https://decentraland.org/bevy-web/?realm=${encodeURIComponent(name.toLowerCase())}`
}
