// The editor's MCP server: how the desktop assistant (the Claude CLI) sees and plays the running
// scene with the same tools the web assistant has (view, playtest, ui_layout). It listens on
// loopback with a per-launch token, answers MCP's JSON-RPC over plain HTTP POST (no streaming),
// and forwards each call to the editor page, which runs it on the engine.
import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  EDITOR_TOOLS,
  EDITOR_TOOL_DESCRIPTIONS,
  EDITOR_TOOL_SCHEMAS,
  editorToolContent,
  isEditorTool,
  type EditorToolCall,
  type EditorToolName,
  type EditorToolResult
} from '@dcl-editor/contract'

export const EDITOR_MCP_SERVER = 'editor'

export interface EditorMcp {
  url: string
  token: string
  close(): Promise<void>
}

type Forward = (name: EditorToolName, args: Record<string, unknown>, signal: AbortSignal) => Promise<EditorToolResult>

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

function rpcRequest(value: unknown): value is RpcRequest {
  return typeof value === 'object' && value !== null && typeof (value as { method?: unknown }).method === 'string'
}

// The page side: each call goes out with an id, the page answers on the result channel.
export function createPageForwarder(send: (call: EditorToolCall) => boolean): { forward: Forward; answer(id: string, result: EditorToolResult): void } {
  const pending = new Map<string, (result: EditorToolResult) => void>()
  return {
    forward: (name, args, signal) => new Promise((resolve) => {
      const id = randomUUID()
      const settle = (result: EditorToolResult): void => {
        pending.delete(id)
        resolve(result)
      }
      if (!send({ id, name, args })) {
        resolve({ ok: false, message: 'The editor window is not open.' })
        return
      }
      pending.set(id, settle)
      signal.addEventListener('abort', () => {
        if (!pending.has(id)) return
        send({ id, cancel: true })
        settle({ ok: false, message: 'Stopped.' })
      }, { once: true })
    }),
    answer: (id, result) => pending.get(id)?.(result)
  }
}

async function handle(request: RpcRequest, forward: Forward, signal: AbortSignal): Promise<unknown> {
  const params = request.params ?? {}
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: EDITOR_MCP_SERVER, version: '1.0.0' }
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: EDITOR_TOOLS.map((name) => ({ name, description: EDITOR_TOOL_DESCRIPTIONS[name], inputSchema: EDITOR_TOOL_SCHEMAS[name] })) }
    case 'tools/call': {
      const name = params.name
      const args = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments as Record<string, unknown> : {}
      if (typeof name !== 'string' || !isEditorTool(name)) return { content: [{ type: 'text', text: `Unknown tool ${String(name)}.` }], isError: true }
      const result = await forward(name, args, signal)
      if (!result.ok) return { content: [{ type: 'text', text: result.message }], isError: true }
      try {
        return { content: editorToolContent(name, result.text) }
      } catch (e) {
        return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 })
  }
}

export function startEditorMcp(forward: Forward, log: (line: string) => void): Promise<EditorMcp> {
  const token = randomBytes(24).toString('hex')
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    if (req.method !== 'POST') {
      // no server-initiated stream: every answer rides on its request
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      // the CLI closing the connection (the assistant stopped) cancels the call it was waiting on
      const controller = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) controller.abort()
      })
      let message: unknown
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
        return
      }
      if (!rpcRequest(message)) {
        res.writeHead(400).end()
        return
      }
      // notifications (initialized, cancelled) need no answer
      if (message.id === undefined) {
        res.writeHead(202).end()
        return
      }
      const id = message.id
      handle(message, forward, controller.signal)
        .then((result) => ({ jsonrpc: '2.0', id, result }))
        .catch((e: unknown) => {
          log(`[editor-mcp] ${message.method} failed: ${String(e)}`)
          const code = typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -32603
          return { jsonrpc: '2.0', id, error: { code, message: e instanceof Error ? e.message : String(e) } }
        })
        .then((body) => {
          if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        })
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the editor MCP server has no port'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        token,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

// What the Claude CLI gets as --mcp-config: only this server.
export function editorMcpConfig(mcp: Pick<EditorMcp, 'url' | 'token'>): string {
  return JSON.stringify({ mcpServers: { [EDITOR_MCP_SERVER]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } })
}
