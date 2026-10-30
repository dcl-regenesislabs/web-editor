import { BlockList, isIP } from 'node:net'

const PRIVATE = new BlockList()
for (const [address, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['169.254.0.0', 16]] as const) {
  PRIVATE.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) PRIVATE.addSubnet(address, prefix, 'ipv6')

function normalize(value: string | undefined | null): string | undefined {
  const address = value?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')
  return address !== undefined && isIP(address) !== 0 ? address : undefined
}

const isPrivate = (address: string) => PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')

// one IPv6 holder gets a whole /64, so it counts as one client
function bucket(address: string): string {
  if (isIP(address) !== 6) return address
  const [head, tail = ''] = address.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === '' ? [] : tail.split(':')
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/**
 * The client a request counts against, or undefined when it cannot be told apart from others.
 * `header` (e.g. x-real-ip) is believed only from a private peer, the reverse proxy; a peer on a
 * public address reached the service directly and is the client itself.
 */
export function clientAddress(request: Request, peer: string | undefined, header: string | undefined): string | undefined {
  const socket = normalize(peer)
  if (socket === undefined) return undefined
  if (!isPrivate(socket)) return bucket(socket)
  if (header === undefined) return undefined
  // a proxy appends to x-forwarded-for, so the last entry is the one our proxy saw
  const forwarded = normalize(request.headers.get(header)?.split(',').at(-1))
  return forwarded === undefined ? undefined : bucket(forwarded)
}
