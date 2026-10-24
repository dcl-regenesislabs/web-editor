// The assistant's whole chat UX rides on this parser tracking the output of an
// external CLI. Recorded lines, so a format change fails here rather
// than silently showing an empty transcript.
import { describe, it, expect } from 'vitest'
import { ASSISTANT_EFFORT, ASSISTANT_MODEL, ASSISTANT_PROMPT, DESKTOP_PROMPT_ADAPTER } from '@dcl-editor/contract'
import { EDITOR_CLI_TOOLS, PROVIDERS } from './ai'

const DIR = '/Users/me/scenes/my-scene'

const claude = PROVIDERS.claude ?? (() => { throw new Error('no claude provider') })()

function run(lines: string[]): {
  texts: string[]
  tools: Array<[string, string]>
  sessions: Array<string | undefined>
} {
  const texts: string[] = []
  const tools: Array<[string, string]> = []
  const sessions: Array<string | undefined> = []
  for (const line of lines) {
    const session = claude.parseLine(line, DIR, (text, tool) => {
      if (text !== '') texts.push(text)
      if (tool !== undefined) tools.push(tool)
    })
    if (session !== undefined) sessions.push(session)
  }
  return { texts, tools, sessions }
}

describe('claude parseLine', () => {
  it('takes the session id from the init event', () => {
    const { sessions } = run([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' })
    ])
    expect(sessions).toEqual(['sess-abc'])
  })

  it('emits assistant text and tool uses in order', () => {
    const { texts, tools } = run([
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Adding a spin.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: `${DIR}/src/scripts/Spin.ts` } }
          ]
        }
      })
    ])
    expect(texts).toEqual(['Adding a spin.'])
    expect(tools).toHaveLength(1)
    expect(tools[0][0]).toBe('Edit')
    // paths are shown scene-relative, never as a ../../ traversal chain
    expect(tools[0][1]).toBe('src/scripts/Spin.ts')
  })

  it('names the editor MCP tools as the web assistant does', () => {
    const { tools } = run([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'mcp__editor__playtest', input: { action: 'start', platform: 'mobile' } }] }
      })
    ])
    expect(tools).toEqual([['Playtest', 'start (mobile)']])
  })

  it('gives the CLI only the editor MCP server', () => {
    const args = claude.buildArgs({ text: 'hi', projectDir: DIR, images: [], mcpConfig: '{"mcpServers":{}}' })
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 3)).toEqual(['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'])
    expect(claude.buildArgs({ text: 'hi', projectDir: DIR, images: [] })).not.toContain('--mcp-config')
  })

  it('keeps the creator\'s own Claude Code setup out of the editor\'s assistant', () => {
    const args = claude.buildArgs({ text: 'hi', projectDir: DIR, images: [] })
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local')
    const settings = JSON.parse(args[args.indexOf('--settings') + 1])
    expect(settings.claudeMdExcludes[0]).toMatch(/\/\.claude\/CLAUDE\.md$/)
    expect(settings.autoMemoryEnabled).toBe(false)
    expect(args[args.indexOf('--tools') + 1]).toBe(EDITOR_CLI_TOOLS)
    // the web assistant's model and effort, whatever the machine's Claude Code settings say
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4)).toEqual(['--model', ASSISTANT_MODEL, '--effort', ASSISTANT_EFFORT])
    const picked = claude.buildArgs({ text: 'hi', projectDir: DIR, images: [], model: 'sonnet' })
    expect(picked[picked.indexOf('--model') + 1]).toBe('sonnet')
  })

  it('gives Claude the web assistant\'s prompt', () => {
    const args = claude.buildArgs({ text: 'hi', projectDir: DIR, images: [] })
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(`${ASSISTANT_PROMPT}\n\n${DESKTOP_PROMPT_ADAPTER}`)
  })

  it('ignores non-JSON chatter instead of throwing', () => {
    expect(() => run(['Warning: something on stderr', ''])).not.toThrow()
    expect(run(['not json']).texts).toEqual([])
  })

  it('skips empty text blocks', () => {
    const { texts } = run([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } })
    ])
    expect(texts).toEqual([])
  })
})
