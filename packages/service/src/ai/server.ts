import type { IHttpServerComponent } from '@dcl/core-commons'
import { upgradeWebSocketResponse } from '@dcl/http-server/dist/ws.js'
import { STOP_COMPONENT } from '@well-known-components/interfaces'
import type { IBaseComponent } from '@well-known-components/interfaces'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { ASSISTANT_MAX_MESSAGE_BYTES, ASSISTANT_PROTOCOL, ASSISTANT_TICKET_PREFIX, object } from '../../../contract/src/assistant.ts'
import { createRateLimiter } from '../config.ts'
import { createConnection } from './connection.ts'
import type { AssistantMemory } from './memory.ts'
import type { Operations } from './operations.ts'
import type { UsageMeter } from './usage.ts'
import type { SessionLog } from './session-log.ts'
import type { ImageProvider } from './images.ts'
import { createWalletImages, DEFAULT_IMAGES_PER_DAY } from './thumbnail.ts'
import { profileAvatar } from './profile.ts'
import type { AgentFactory, AssistantService } from './types.ts'
import type { BaseComponents } from '../types.ts'

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })
}

export interface AssistantComponent extends AssistantService, IBaseComponent {
  ws: WebSocketServer
  upgrade(request: Request, client?: string): IHttpServerComponent.IResponse
}

export interface AssistantLimits {
  /** Lowercase wallets that may use the assistant; null lets any signed-in wallet in. */
  wallets: ReadonlySet<string> | null
  /** Turns across all wallets per minute. */
  turnsPerMinute: number
  /** Turns one wallet may start per UTC day. */
  turnsPerDay: number
  /** Turns one client address may start per UTC day, whichever wallets it signs in with. */
  turnsPerIpPerDay: number
  /** Turns all wallets together may start per UTC day: what protects the Claude plans. */
  turnsPerDayTotal: number
  /** Turns one wallet may have running at once, across its tabs. */
  turnsAtOnce: number
  /** Images (thumbnails) one wallet may have made per UTC day. */
  imagesPerDay: number
}

// few creators use it: generous, a guard against runaway scripts rather than a quota anyone meets
export const DEFAULT_ASSISTANT_LIMITS: AssistantLimits = {
  wallets: null, turnsPerMinute: 30, turnsPerDay: 100, turnsPerIpPerDay: 300, turnsPerDayTotal: 2000, turnsAtOnce: 2,
  imagesPerDay: DEFAULT_IMAGES_PER_DAY
}

const MAX_SOCKETS = 32
const SOCKETS_PER_WALLET = 3
const SOCKETS_PER_IP = 8
const TURNS_PER_MINUTE_PER_WALLET = 10
const TURNS_PER_MINUTE_PER_IP = 20
const CONNECTS_PER_MINUTE_PER_IP = 30

interface DayCounts { day: number; used: Map<string, number> }

function loadCounts(path: string | undefined): DayCounts {
  const empty = { day: 0, used: new Map<string, number>() }
  if (path === undefined) return empty
  try {
    const saved: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!object(saved) || typeof saved.day !== 'number' || !object(saved.used)) return empty
    return { day: saved.day, used: new Map(Object.entries(saved.used).filter((entry): entry is [string, number] => typeof entry[1] === 'number')) }
  } catch {
    return empty
  }
}
// Proxies drop a silent socket (Cloudflare after 100 s), and a model step can be quiet that long;
// a peer that missed the last ping is gone.
const KEEPALIVE_MS = 30_000

export function createAssistantComponent({ logs }: Pick<BaseComponents, 'logs'>, options: {
  factory?: AgentFactory
  allowedOrigins: readonly string[]
  basePath?: string
  limits?: AssistantLimits
  usage?: UsageMeter
  memory?: AssistantMemory
  /** Plaintext session record for /admin/ (ASSISTANT_SESSION_LOG); off by default. */
  sessions?: SessionLog
  /** Where today's prompt counts are kept, so a restart does not hand out a fresh day. */
  countsPath?: string
  /** The image model and its per-wallet day count; without it thumbnails report themselves unavailable. */
  images?: { provider: ImageProvider; usage: UsageMeter }
  operations?: Operations
  /** How long a stop waits for running turns; compose's stop_grace_period must be longer. */
  drainMs?: number
}): AssistantComponent {
  const limits = options.limits ?? DEFAULT_ASSISTANT_LIMITS
  const counts = loadCounts(options.countsPath)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const factory = options.factory
  const logger = logs.getLogger('assistant')
  const tickets = new Map<string, { wallet: string; origin: string; client?: string; expires: number }>()
  const sockets = new Map<WebSocket, { wallet: string; client?: string }>()
  const connections = new Map<WebSocket, ReturnType<typeof createConnection>>()
  const pending = new Map<string, { wallet: string; client?: string; timer: ReturnType<typeof setTimeout> }>()
  const limiter = createRateLimiter()
  const closing = new Set<Promise<void>>()
  let stopped = false
  const memory = options.memory
  const sessions = options.sessions
  const sweep = () => {
    void memory?.sweep().catch(() => { logger.error('Assistant memory sweep failed') })
    void sessions?.sweep().catch(() => { logger.error('Assistant session log sweep failed') })
  }
  sweep()
  const sweeper = memory === undefined && sessions === undefined ? undefined : setInterval(sweep, 60 * 60_000)
  sweeper?.unref()
  const socketOptions = {
    noServer: true, maxPayload: ASSISTANT_MAX_MESSAGE_BYTES, perMessageDeflate: false,
    maxFragments: 4096, maxBufferedChunks: 16384, closeTimeout: 5000,
    handleProtocols: () => ASSISTANT_PROTOCOL
  }
  const ws = new WebSocketServer(socketOptions)
  const path = `${options.basePath ?? ''}/assistant/socket`
  function liveTickets(): { all: number; held: (wallet: string) => number } {
    for (const [token, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(token)
    return { all: tickets.size, held: (wallet) => [...tickets.values()].filter((ticket) => ticket.wallet === wallet).length }
  }
  function writeCounts(path: string): void {
    saveTimer = undefined
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(`${path}.tmp`, JSON.stringify({ day: counts.day, used: Object.fromEntries(counts.used) }), { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
    } catch {
      logger.error('Assistant prompt counts could not be saved')
    }
  }
  function saveCounts(): void {
    const path = options.countsPath
    if (path === undefined || saveTimer !== undefined) return
    saveTimer = setTimeout(() => writeCounts(path), 1000)
    saveTimer.unref()
  }
  function allowTurn(wallet: string, client: string | undefined): true | string {
    if (stopped) return 'The assistant is restarting for an update. Send your message again in a minute.'
    const running = [...connections].filter(([socket, connection]) => sockets.get(socket)?.wallet === wallet && connection.isRunning()).length
    if (running >= limits.turnsAtOnce) return `${limits.turnsAtOnce} turns are already running in your other tabs. Wait for one to finish.`
    const now = Date.now()
    const day = Math.floor(now / 86_400_000)
    if (counts.day !== day) {
      counts.day = day
      counts.used.clear()
    }
    const ip = client === undefined ? undefined : `ip:${client}`
    const used = (key: string) => counts.used.get(key) ?? 0
    if (used(wallet) >= limits.turnsPerDay) return `You have used today's ${limits.turnsPerDay} prompts. They reset at 00:00 UTC.`
    if (ip !== undefined && used(ip) >= limits.turnsPerIpPerDay) return 'Your network has used today\'s prompts. They reset at 00:00 UTC.'
    if (used('all') >= limits.turnsPerDayTotal) return 'The assistant has used today\'s prompts for everyone. They reset at 00:00 UTC.'
    if (limiter.take(wallet, now, TURNS_PER_MINUTE_PER_WALLET) > 0 || (ip !== undefined && limiter.take(ip, now, TURNS_PER_MINUTE_PER_IP) > 0) ||
      limiter.take('turns', now, limits.turnsPerMinute) > 0) return 'Too many requests. Try again shortly.'
    for (const key of [wallet, ip, 'all']) if (key !== undefined) counts.used.set(key, used(key) + 1)
    saveCounts()
    return true
  }
  function connect(socket: WebSocket, token: string) {
    const reservation = pending.get(token)
    if (reservation !== undefined) clearTimeout(reservation.timer)
    pending.delete(token)
    if (stopped || factory === undefined || reservation === undefined) { socket.terminate(); return }
    const { wallet, client } = reservation
    sockets.set(socket, { wallet, client })
    const operations = options.operations?.openSession(wallet)
    let connection: ReturnType<typeof createConnection> | null = null
    const deadline = setTimeout(() => socket.terminate(), 5000)
    const idle = setTimeout(() => {
      if (connection?.isRunning()) idle.refresh()
      else socket.close(1000, 'Session expired')
    }, 15 * 60_000)
    let answered = true
    socket.on('pong', () => { answered = true })
    const keepalive = setInterval(() => {
      if (!answered) { socket.terminate(); return }
      answered = false
      socket.ping()
    }, KEEPALIVE_MS)
    const send = (value: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1008, 'Client too slow'); return }
      socket.send(JSON.stringify(value))
    }
    socket.on('message', (raw, binary) => {
      idle.refresh()
      if (binary) { socket.close(1003, 'Text messages required'); return }
      let message: unknown
      try { message = JSON.parse(raw.toString()) } catch { socket.close(1008, 'Invalid message'); return }
      if (connection !== null) connection.receive(message)
      else socket.close(1008, 'Wait for session readiness')
    })
    void factory.providers().then((providers) => {
      if (socket.readyState !== WebSocket.OPEN) return
      clearTimeout(deadline)
      const usage = options.usage?.forWallet(wallet)
      const walletImages = createWalletImages(options.images?.provider, options.images?.usage.forWallet(wallet), limits.imagesPerDay,
        (signal) => profileAvatar(wallet, signal))
      const images = options.operations === undefined ? walletImages : {
        ...walletImages,
        generate: async (...args: Parameters<typeof walletImages.generate>) => {
          try {
            const picture = await walletImages.generate(...args)
            options.operations?.imageGenerated(wallet, true)
            return picture
          } catch (error) {
            options.operations?.imageGenerated(wallet, false)
            throw error
          }
        }
      }
      connection = createConnection({ factory, logger, send, allowTurn: () => allowTurn(wallet, client), memory: memory?.forWallet(wallet), usage, images, operations,
        sessions: sessions?.forWallet(wallet) })
      connections.set(socket, connection)
      send({ kind: 'ready', providers })
    }).catch(() => socket.close(1011, 'Assistant unavailable'))
    socket.on('error', () => socket.close())
    socket.on('close', () => {
      clearTimeout(deadline)
      clearTimeout(idle)
      clearInterval(keepalive)
      sockets.delete(socket)
      connections.delete(socket)
      if (connection !== null) {
        const pending = connection.close().catch(() => { logger.error('Assistant cleanup failed') }).finally(() => operations?.closed())
        closing.add(pending)
        void pending.then(() => closing.delete(pending))
      } else operations?.closed()
    })
  }
  return {
    ws,
    upgrade(request, client) {
      if (stopped || factory === undefined) return { status: 503 }
      const url = new URL(request.url)
      const origin = request.headers.get('origin') ?? ''
      if (url.pathname + url.search !== path || !options.allowedOrigins.includes(origin)) return { status: 403 }
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return { status: 426 }
      const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((value) => value.trim())
      if (protocols.length !== 2 || protocols[0] !== ASSISTANT_PROTOCOL || !protocols[1].startsWith(ASSISTANT_TICKET_PREFIX)) return { status: 403 }
      const token = protocols[1].slice(ASSISTANT_TICKET_PREFIX.length)
      const ticket = tickets.get(token)
      if (ticket === undefined || ticket.expires <= Date.now() || ticket.origin !== origin) return { status: 403 }
      const held = [...sockets.values(), ...pending.values()]
      // the ticket's address: a proxy that hides this one must not let the socket escape the count
      const address = client ?? ticket.client
      if (held.length >= MAX_SOCKETS || held.filter((entry) => entry.wallet === ticket.wallet).length >= SOCKETS_PER_WALLET ||
        (address !== undefined && held.filter((entry) => entry.client === address).length >= SOCKETS_PER_IP)) return { status: 429 }
      tickets.delete(token)
      const timer = setTimeout(() => pending.delete(token), 5000)
      timer.unref()
      pending.set(token, { wallet: ticket.wallet, client: address, timer })
      return upgradeWebSocketResponse((socket: WebSocket) => connect(socket, token))
    },
    async handle(request, route, wallet, client) {
      if (stopped || factory === undefined) return json(503, { error: 'assistant-unavailable' })
      const allowed = limits.wallets === null || limits.wallets.has(wallet)
      if (route === '/assistant/providers' && request.method === 'GET') {
        const providers = await factory.providers()
        return json(200, allowed ? providers : providers.map((provider) => ({
          ...provider, available: false, reason: 'This account does not have access to the assistant.'
        })))
      }
      if (route !== '/assistant/connect' || request.method !== 'POST') return json(404, { error: 'not-found' })
      const origin = request.headers.get('origin') ?? JSON.parse(request.headers.get('x-identity-metadata') ?? '{}').origin
      if (typeof origin !== 'string' || !options.allowedOrigins.includes(origin)) return json(403, { error: 'origin-not-allowed' })
      if (!allowed) return json(403, { error: 'assistant-not-allowed' })
      const live = liveTickets()
      if (live.all >= 100 || live.held(wallet) >= SOCKETS_PER_WALLET || limiter.take(`connect:${wallet}`, Date.now(), 10) > 0 ||
        (client !== undefined && limiter.take(`connect-ip:${client}`, Date.now(), CONNECTS_PER_MINUTE_PER_IP) > 0)) {
        return json(429, { error: 'rate-limited' })
      }
      const token = crypto.randomUUID()
      tickets.set(token, { wallet, origin, client, expires: Date.now() + 30_000 })
      return json(200, { token, path })
    },
    async [STOP_COMPONENT]() {
      stopped = true
      clearInterval(sweeper)
      if (saveTimer !== undefined && options.countsPath !== undefined) {
        clearTimeout(saveTimer)
        writeCounts(options.countsPath)
      }
      tickets.clear()
      for (const reservation of pending.values()) clearTimeout(reservation.timer)
      pending.clear()
      // a deploy recreates the container: let the turns already running finish instead of cutting them
      const deadline = Date.now() + (options.drainMs ?? 0)
      while ([...connections.values()].some((connection) => connection.isRunning()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      for (const socket of ws.clients) socket.terminate()
      await new Promise<void>((resolve) => ws.close(() => resolve()))
      await Promise.all(closing)
    }
  }
}
