// The desktop assistant reaches the engine through this server: the CLI speaks MCP's JSON-RPC
// over HTTP, so the handshake, the tool list and a call with a picture are checked end to end.
import { afterEach, describe, expect, it } from 'vitest'
import type { EditorToolCall } from '@dcl-editor/contract'
import { createPageForwarder, editorMcpConfig, startEditorMcp, type EditorMcp } from './editor-mcp'

let server: EditorMcp | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function rpc(mcp: EditorMcp, body: unknown, token = mcp.token): Promise<Response> {
  return fetch(mcp.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('editor MCP server', () => {
  it('lists the editor tools and turns a page answer into an image and text', async () => {
    const calls: unknown[] = []
    server = await startEditorMcp(async (name, args) => {
      calls.push([name, args])
      return { ok: true, text: JSON.stringify({ platform: 'mobile', nodes: [], view: { mimeType: 'image/jpeg', image: 'AAAA' } }) }
    }, () => {})

    const init = await (await rpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json()
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
    expect((await rpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)

    const list = await (await rpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_files', 'search_files', 'read_file', 'edit_file', 'write_file', 'scene_request', 'asset_request', 'build', 'view', 'playtest', 'ui_layout', 'mobile_check'])

    const call = await (await rpc(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ui_layout', arguments: {} } })).json()
    expect(call.result.content).toEqual([
      { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
      { type: 'text', text: JSON.stringify({ platform: 'mobile', nodes: [] }) }
    ])
    expect(calls).toEqual([['ui_layout', {}]])
  })

  it('reports a failed call as a tool error and refuses a caller without the token', async () => {
    server = await startEditorMcp(async () => ({ ok: false, message: 'Start playtesting first' }), () => {})
    const call = await (await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ui_layout' } })).json()
    expect(call.result).toEqual({ content: [{ type: 'text', text: 'Start playtesting first' }], isError: true })
    expect((await rpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'wrong')).status).toBe(401)
  })

  it('gives the CLI a config with only this server', () => {
    expect(JSON.parse(editorMcpConfig({ url: 'http://127.0.0.1:1/mcp', token: 't' }))).toEqual({
      mcpServers: { editor: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } } }
    })
  })
})

describe('page forwarder', () => {
  it('answers a call with the page result, and cancels it on the page when aborted', async () => {
    const sent: EditorToolCall[] = []
    const pages = createPageForwarder((call) => {
      sent.push(call)
      return true
    })
    const answered = pages.forward('view', {}, new AbortController().signal)
    pages.answer(sent[0].id, { ok: true, text: '{}' })
    expect(await answered).toEqual({ ok: true, text: '{}' })

    const stop = new AbortController()
    const stopped = pages.forward('playtest', { action: 'wait' }, stop.signal)
    stop.abort()
    expect(await stopped).toEqual({ ok: false, message: 'Stopped.' })
    expect(sent.at(-1)).toEqual({ id: sent[1].id, cancel: true })
  })

  it('fails at once when there is no window', async () => {
    const pages = createPageForwarder(() => false)
    expect(await pages.forward('view', {}, new AbortController().signal)).toEqual({ ok: false, message: 'The editor window is not open.' })
  })
})
