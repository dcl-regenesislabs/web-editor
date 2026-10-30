// Which worlds a wallet can publish to, from public endpoints only: the editor
// signs nothing, and the host signs for the project service and nothing else.
//
// - the NAMEs the wallet owns (a catalyst's lambdas): each is a world, whether
//   or not anything was ever published to it
// - the worlds the Worlds server lists for the wallet as owner or as a wallet
//   on the deployment list (`/worlds?authorized_deployer=`), which is the only
//   place a collaborator's worlds show up
import type { PublishWorld } from '@dcl-editor/contract'

const PAGE = 100
const MAX_PAGES = 20

// The catalyst that knows the NAMEs of the network a Worlds server is on; null
// for a server that is not Decentraland's (a local one): its own list is all there is.
function lambdasFor(worldsContent: string): string | null {
  const host = new URL(worldsContent).hostname
  if (host.endsWith('.decentraland.org')) return 'https://peer.decentraland.org/lambdas'
  if (host.endsWith('.decentraland.zone')) return 'https://peer.decentraland.zone/lambdas'
  return null
}

// What `realm=` takes for a world: its name on Decentraland's own servers, the
// world's url on any other.
export function worldRealm(worldsContent: string, world: string): string {
  return lambdasFor(worldsContent) === null ? `${worldsContent}/world/${world}` : world
}

// The page link to a world. A world named on Decentraland's servers resolves against the page's own
// domain, so a page on decentraland.zone that deployed to the .org servers has to say baseDomain.
export function worldLink(pageDir: string, worldsContent: string, world: string): string {
  const link = `${pageDir}?realm=${encodeURIComponent(worldRealm(worldsContent, world))}`
  if (lambdasFor(worldsContent) === null) return link
  const domain = new URL(worldsContent).hostname.split('.').slice(-2).join('.')
  const page = new URL(pageDir).hostname
  return page === domain || page.endsWith(`.${domain}`) ? link : `${link}&baseDomain=${domain}`
}

async function ownedNames(lambdas: string, wallet: string): Promise<string[]> {
  const names: string[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetch(`${lambdas}/users/${wallet}/names?pageSize=${PAGE}&pageNum=${page}`)
    if (!response.ok) throw new Error(`could not list your NAMEs (${response.status})`)
    const body = (await response.json()) as { elements?: { name?: unknown }[]; totalAmount?: unknown }
    const elements = Array.isArray(body.elements) ? body.elements : []
    for (const { name } of elements) if (typeof name === 'string' && name !== '') names.push(`${name.toLowerCase()}.dcl.eth`)
    if (elements.length < PAGE || (typeof body.totalAmount === 'number' && names.length >= body.totalAmount)) break
  }
  return names
}

async function deployable(worldsContent: string, wallet: string): Promise<PublishWorld[]> {
  const worlds: PublishWorld[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetch(`${worldsContent}/worlds?authorized_deployer=${wallet}&limit=${PAGE}&offset=${page * PAGE}`)
    if (!response.ok) throw new Error(`could not list the worlds you can publish to (${response.status})`)
    const body = (await response.json()) as { worlds?: { name?: unknown; owner?: unknown }[]; total?: unknown }
    const rows = Array.isArray(body.worlds) ? body.worlds : []
    for (const row of rows) {
      if (typeof row.name !== 'string') continue
      const mine = typeof row.owner === 'string' && row.owner.toLowerCase() === wallet
      worlds.push({ name: row.name.toLowerCase(), role: mine ? 'owner' : 'collaborator' })
    }
    if (rows.length < PAGE || (typeof body.total === 'number' && (page + 1) * PAGE >= body.total)) break
  }
  return worlds
}

// none while signed out
export async function publishWorlds(wallet: string | null, server: string): Promise<PublishWorld[]> {
  if (wallet === null) return []
  const address = wallet.toLowerCase()
  const worldsContent = server.replace(/\/+$/, '')
  const lambdas = lambdasFor(worldsContent)
  const [names, listed] = await Promise.all([
    lambdas === null ? [] : ownedNames(lambdas, address),
    // with the NAMEs in hand, the server failing to list costs only the worlds of others
    deployable(worldsContent, address).catch((error: unknown) => {
      if (lambdas === null) throw error
      return []
    })
  ])
  const byName = new Map<string, PublishWorld>()
  for (const world of listed) byName.set(world.name, world)
  for (const name of names) byName.set(name, { name, role: 'owner' })
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
