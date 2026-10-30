import { expect, it } from 'vitest'
import { clientAddress } from './client-ip.ts'

const request = (headers: Record<string, string> = {}) => new Request('http://service.local/health', { headers })

it('believes the proxy header only from a private peer', () => {
  const spoofed = request({ 'x-real-ip': '203.0.113.9' })
  expect(clientAddress(spoofed, '172.18.0.1', 'x-real-ip')).toBe('203.0.113.9')
  expect(clientAddress(spoofed, '198.51.100.4', 'x-real-ip')).toBe('198.51.100.4')
  expect(clientAddress(spoofed, '::ffff:127.0.0.1', undefined)).toBeUndefined()
  expect(clientAddress(request(), '127.0.0.1', 'x-real-ip')).toBeUndefined()
})

it('takes the entry our proxy appended to x-forwarded-for', () => {
  const forwarded = request({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })
  expect(clientAddress(forwarded, '10.0.0.2', 'x-forwarded-for')).toBe('203.0.113.9')
})

it('counts one IPv6 /64 as one client', () => {
  expect(clientAddress(request(), '2001:db8:0:1::5', undefined)).toBe('2001:db8:0:1::/64')
  expect(clientAddress(request(), '2001:db8:0:1:aa:bb:cc:dd', undefined)).toBe('2001:db8:0:1::/64')
  expect(clientAddress(request(), 'fe80::1%en0', undefined)).toBeUndefined()
})
