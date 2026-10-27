// In-app AI assistant: drives a local AI *CLI* (Claude Code) as a child
// process, one per user turn, with the open project as its working directory.
// It runs on the user's own subscription/OAuth session — API keys are stripped
// from the child env on purpose (metered keys are the thing we're avoiding) — and
// edits the scene's src/scripts/*.ts files directly on disk; sdk-commands then
// hot-reloads them. Mirrors servers.ts's spawn/kill discipline (detached POSIX
// process group, killed as a tree). The renderer only sends prompts and renders
// the streamed events; all spawning happens here in the main process.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { ASSISTANT_EFFORT, ASSISTANT_MODEL, type AiEvent, type AiProvider, type AiProviderInfo, type AiSendParams } from '@dcl-editor/contract'
import { ASSISTANT_PROMPT, DESKTOP_PROMPT_ADAPTER } from '@dcl-editor/contract'
import { EDITOR_MCP_SERVER } from './editor-mcp'

// GUI-launched Electron gets a sparse PATH (no shell profile), so the CLIs — and
// their own node/child lookups — won't be found by name alone. Search these in
// addition to whatever PATH we do have.
const HOME = os.homedir()
const EXTRA_BIN_DIRS = [
  path.join(HOME, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  path.join(HOME, '.bun', 'bin'),
  path.join(HOME, '.deno', 'bin'),
  path.join(HOME, '.volta', 'bin')
]

// nvm earns a special case: it is where `npm i -g` actually lands for most of
// the people hitting this, and its layout is fixed. The login-shell probe below
// covers it only when nvm is loaded eagerly — a lazy-loading profile (a common
// speed trick) leaves node off PATH until something triggers it, and then the
// probe reports a PATH without it. Newest version first, since that is the one
// a fresh `npm i -g` installed into.
export function nvmBinDirs(nvmRoot: string): string[] {
  try {
    return fs
      .readdirSync(nvmRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('v'))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(nvmRoot, v, 'bin'))
  } catch {
    return [] // no nvm here
  }
}

// …but that list can only ever guess at install layouts, and the setup card
// tells people to run `npm i -g`, which lands wherever their Node version
// manager points npm's prefix (~/.nvm/versions/…, ~/.n/bin, a custom prefix).
// A GUI launch inherits launchd's PATH — often just /usr/bin:/bin — so none of
// it is visible and a signed-in CLI reads as "not installed". Ask the login
// shell where its PATH actually points instead. `-i` matters: nvm and fnm set
// PATH from .zshrc/.bashrc, not the profile. Marker-delimited because an
// interactive shell may print banners of its own.
const SHELL_PATH_TIMEOUT_MS = 5_000
let shellDirs: string[] = []
let probing: Promise<void> | null = null

// The panel's mount effect and a Recheck click both land here, and with no CLI
// installed each would otherwise spawn its own login shell. Share the one
// in-flight probe; the next call after it settles starts a fresh one, which is
// what makes Recheck-after-installing work.
function loadShellDirs(): Promise<void> {
  probing ??= runShellProbe().finally(() => (probing = null))
  return probing
}

async function runShellProbe(): Promise<void> {
  if (process.platform === 'win32') return // GUI apps there inherit the real PATH
  const shell = process.env.SHELL ?? '/bin/zsh'
  const out = await new Promise<string>((resolve) => {
    let child: ChildProcess
    try {
      // detached: the profile may spawn its own children (a version manager
      // resolving a default), and killing only the shell would orphan them —
      // same process-group discipline as servers.ts.
      child = spawn(shell, ['-ilc', 'printf "<<<%s>>>" "$PATH"'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    } catch {
      resolve('')
      return
    }
    let buf = ''
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') // the group, not just the shell
      } catch {
        child.kill('SIGKILL')
      }
      resolve(buf) // a heavy or interactive profile must not hang the probe
    }, SHELL_PATH_TIMEOUT_MS)
    child.stdout?.on('data', (d: Buffer) => (buf += String(d)))
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(buf)
    })
  })
  const dirs = parseShellPath(out)
  if (dirs.length > 0) {
    shellDirs = dirs // no marker: keep what we had, the static list still applies
    cachedDirs = null
  }
}

// Everywhere worth looking, best evidence first: what the user's own shell
// reported, then the static guesses, then nvm's versioned dirs. Resolved once
// per probe rather than per lookup — findExecutable calls this for every
// provider and childEnv again on every turn, and nothing here changes in
// between.
let cachedDirs: string[] | null = null
function searchDirs(): string[] {
  if (cachedDirs === null) {
    const nvmRoot = path.join(process.env.NVM_DIR ?? path.join(HOME, '.nvm'), 'versions', 'node')
    cachedDirs = [...shellDirs, ...EXTRA_BIN_DIRS, ...nvmBinDirs(nvmRoot)]
  }
  return cachedDirs
}

// Split on ':', not path.delimiter: this is a POSIX shell's $PATH, and the
// probe that produces it never runs on Windows — so the separator is a property
// of the value, not of the platform doing the parsing.
export function parseShellPath(out: string): string[] {
  const found = /<<<(.*?)>>>/s.exec(out)
  return found === null ? [] : found[1].split(':').filter(Boolean)
}

// Find an installed, *runnable* binary by any of its names. realpathSync throws
// on a dangling symlink (e.g. a cask whose target was upgraded away — codex does
// this), so a broken install reads as "not found" instead of spawning garbage.
function findExecutable(names: string[]): string | null {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const dirs = [...pathDirs, ...searchDirs()]
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name)
      try {
        const real = fs.realpathSync(p) // resolves & proves the target exists
        if (fs.statSync(real).isFile()) {
          fs.accessSync(real, fs.constants.X_OK)
          return p // return the found path (spawn follows the symlink itself)
        }
      } catch {
        /* not here, or dangling — keep looking */
      }
    }
  }
  return null
}

// Env vars dropped from the child. Metered API keys → force subscription/OAuth
// auth (the whole point). CLAUDE_CODE_* / CLAUDECODE → don't let the spawned CLI
// think it's nested in another Claude Code session. *BASE_URL / *CUSTOM_HEADERS →
// pin the endpoint to the real provider so an inherited override can't redirect
// the OAuth token to a third party.
const STRIP_ENV = new Set([
  'CLAUDECODE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE'
])

// The child env: strip the vars above, keep everything else (HOME, keychain
// access, etc.), and widen PATH so the CLI finds node/git under a GUI launch.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE') || STRIP_ENV.has(k)) delete env[k]
  }
  // shellDirs too: the CLI's own shebang is `env node`, so a CLI installed
  // under a version manager needs that manager's dir to find its node.
  env.PATH = [...(env.PATH ?? '').split(path.delimiter), ...searchDirs()].filter(Boolean).join(path.delimiter)
  return env
}

interface TurnCtx {
  text: string
  model?: string
  projectDir: string
  resume?: string
  // temp-file paths of attached images (already written to disk)
  images: string[]
  // the editor's MCP server (view, playtest, ui_layout), as --mcp-config JSON
  mcpConfig?: string
}

// A provider = how to find its binary + how to turn a turn into an argv + how to
// read its streaming stdout.
interface ProviderDef {
  id: AiProvider
  label: string
  binNames: string[]
  models: string[]
  defaultModel: string
  buildArgs: (ctx: TurnCtx) => string[]
  // Parse one NDJSON stdout line. Emit chat events; return a session id to
  // remember (for --resume) when the line carries one, else undefined.
  parseLine: (line: string, projectDir: string, emit: (text: string, tool?: [string, string]) => void) => string | undefined
}

// A short, scene-relative label for a tool's target path. The CLIs report
// absolute, symlink-resolved paths (e.g. macOS /private/var/…), so a naive
// path.relative can climb out with ../../ — prefer the meaningful src/… suffix,
// and fall back to the basename rather than showing a traversal chain.
function rel(projectDir: string, p: unknown): string {
  if (typeof p !== 'string' || p === '') return ''
  const srcIdx = p.lastIndexOf('/src/')
  if (srcIdx >= 0) return p.slice(srcIdx + 1)
  try {
    const r = path.relative(projectDir, p)
    return r === '' || r.startsWith('..') ? path.basename(p) : r
  } catch {
    return path.basename(p)
  }
}

// What a tool chip shows after its name. File tools report paths; for the rest,
// prefer what a creator can read — a search's query over nothing.
function toolDetail(tool: string, inp: Record<string, unknown>, projectDir: string): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const clip = (s: string): string => (s.length > 64 ? s.slice(0, 64) + '…' : s)
  const file = rel(projectDir, inp.file_path ?? inp.path ?? '')
  if (file !== '') return file
  if (tool === 'Playtest') return `${str(inp.action)}${inp.platform === 'mobile' ? ' (mobile)' : ''}`
  if (tool === 'UI layout') return 'Screen'
  if (tool === 'Scene') {
    const request = typeof inp.request === 'object' && inp.request !== null ? inp.request as Record<string, unknown> : {}
    return Array.isArray(request.requests) ? `${request.requests.length} changes` : str(request.type)
  }
  if (tool === 'Assets') return str(inp.action)
  if (tool === 'Search' || tool === 'Files') return clip(str(inp.query) !== '' ? str(inp.query) : str(inp.match))
  return ''
}

// the editor's MCP tools as the web assistant names them in the chat
const EDITOR_TOOL_LABELS: Record<string, string> = {
  [`mcp__${EDITOR_MCP_SERVER}__view`]: 'View',
  [`mcp__${EDITOR_MCP_SERVER}__playtest`]: 'Playtest',
  [`mcp__${EDITOR_MCP_SERVER}__ui_layout`]: 'UI layout',
  [`mcp__${EDITOR_MCP_SERVER}__scene_request`]: 'Scene',
  [`mcp__${EDITOR_MCP_SERVER}__asset_request`]: 'Assets',
  [`mcp__${EDITOR_MCP_SERVER}__build`]: 'Build',
  [`mcp__${EDITOR_MCP_SERVER}__list_files`]: 'Files',
  [`mcp__${EDITOR_MCP_SERVER}__search_files`]: 'Search',
  [`mcp__${EDITOR_MCP_SERVER}__read_file`]: 'Read',
  [`mcp__${EDITOR_MCP_SERVER}__edit_file`]: 'Edit',
  [`mcp__${EDITOR_MCP_SERVER}__write_file`]: 'Write'
}

// Claude gets the web assistant's prompt and the editor's tools, so a run here reads like one on the web.
export const CLAUDE_SYSTEM_PROMPT = `${ASSISTANT_PROMPT}\n\n${DESKTOP_PROMPT_ADAPTER}`

// The editor's assistant runs the same on every creator's machine: none of their own Claude Code
// setup (user settings and hooks, ~/.claude/CLAUDE.md, personal skills). Its tools are the web
// assistant's, from the editor's MCP server; of the CLI's own only Skill and Read (for a skill's
// references, which the web reads with read_skill). Without ToolSearch the MCP tools load up front.
const USER_CLAUDE_MD = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'CLAUDE.md')
export const EDITOR_CLI_TOOLS = 'Skill,Read'
function editorIsolation(): string[] {
  const settings = {
    // a glob: forward slashes on every platform
    claudeMdExcludes: [USER_CLAUDE_MD.split(path.sep).join('/')],
    // the CLI's own memory would carry one project's notes into later turns, which the web has no way to do
    autoMemoryEnabled: false
  }
  return ['--setting-sources', 'project,local', '--settings', JSON.stringify(settings), '--tools', EDITOR_CLI_TOOLS]
}

// Exported for the parser tests: parseLine tracks two external CLIs' output
// formats, so a format change has to be caught by something.
// The web's other provider, Codex, has no editor tools here.
export const PROVIDERS: Partial<Record<AiProvider, ProviderDef>> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    binNames: ['claude'],
    models: ['default', 'opus', 'sonnet', 'haiku'],
    defaultModel: 'default',
    buildArgs: (ctx) => {
      const args = [
        '-p',
        ctx.text,
        '--output-format',
        'stream-json',
        '--verbose', // required alongside stream-json under -p
        // Full capability, no prompts: the assistant runs shell (npx, sdk-commands),
        // fetches models and docs off the network, and applies edits — the SDK
        // skills it follows are built around those. No allowlist: an allowlist
        // only ADDS to whatever the user's own ~/.claude settings already grant,
        // so it made capability differ per machine while guaranteeing nothing.
        '--permission-mode',
        'bypassPermissions',
        '--append-system-prompt',
        CLAUDE_SYSTEM_PROMPT
      ]
      // the web assistant's model and effort unless a dev picks another model: the desktop is how
      // we test the web assistant's behaviour, whatever the creator's own Claude Code settings say
      args.push('--model', ctx.model !== undefined && ctx.model !== 'default' ? ctx.model : ASSISTANT_MODEL, '--effort', ASSISTANT_EFFORT)
      if (ctx.resume !== undefined) args.push('--resume', ctx.resume)
      // only the editor's server: the creator's own MCP servers and claude.ai connectors stay out
      if (ctx.mcpConfig !== undefined) args.push('--mcp-config', ctx.mcpConfig, '--strict-mcp-config')
      args.push(...editorIsolation())
      // images travel as paths inside the prompt — claude's Read tool renders
      // image files natively, no dedicated flag exists (or is needed)
      return args
    },
    parseLine: (line, projectDir, emit) => {
      let obj: {
        type?: string
        subtype?: string
        session_id?: string
        is_error?: boolean
        message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> }
      }
      try {
        obj = JSON.parse(line)
      } catch {
        return undefined // non-JSON chatter — ignore
      }
      if (obj.type === 'system' && obj.subtype === 'init') return obj.session_id
      if (obj.type === 'assistant' && obj.message?.content !== undefined) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text !== undefined && block.text !== '') emit(block.text)
          else if (block.type === 'tool_use' && block.name !== undefined) {
            const name = EDITOR_TOOL_LABELS[block.name] ?? block.name
            emit('', [name, toolDetail(name, block.input ?? {}, projectDir)])
          }
        }
      }
      if (obj.type === 'result') return obj.session_id
      return undefined
    }
  }
}

const scan = (): AiProviderInfo[] =>
  Object.values(PROVIDERS).map((def) => {
    const bin = findExecutable(def.binNames)
    return {
      id: def.id,
      label: def.label,
      models: def.models,
      defaultModel: def.defaultModel,
      available: bin !== null,
      reason: bin === null ? `${def.label} CLI not found — install it and sign in` : undefined
    }
  })

// Cheap scan first; only pay for the login shell when something is missing —
// which is also exactly when the user presses Recheck after installing.
export async function detectProviders(): Promise<AiProviderInfo[]> {
  cachedDirs = null // an explicit check re-reads the disk: they may have just installed
  const first = scan()
  if (first.every((p) => p.available)) return first
  await loadShellDirs()
  return scan()
}

// One turn at a time. `sessions` holds each provider's resume id so consecutive
// turns chain into a single conversation until aiReset().
let current: { child: ChildProcess; turnId: string; done: boolean } | null = null
const sessions: Partial<Record<AiProvider, string>> = {}
let turnSeq = 0

function killTree(child: ChildProcess): void {
  child.stdout?.removeAllListeners('data')
  child.stderr?.removeAllListeners('data')
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill()
    else process.kill(-child.pid, 'SIGKILL') // whole detached group
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

// Is a turn's CLI child running? It edits project files on disk, so the
// updater refuses to restart the app mid-turn.
export function aiBusy(): boolean {
  return current !== null
}

export function aiStop(): void {
  if (current === null) return
  const c = current
  current = null
  if (!c.done) {
    c.done = true
    killTree(c.child)
  }
}

export function aiReset(): void {
  aiStop()
  delete sessions.claude
}

// Attached images, written to one temp dir per turn. Kept for the whole app
// session (not deleted when the turn ends): with --resume the conversation can
// legitimately come back to an image several turns later, and the CLI re-reads
// it from the same path. The OS owns tmp cleanup beyond that.
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMG_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

function writeAttachments(images: AiSendParams['images']): string[] {
  if (images === undefined || images.length === 0) return []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcl-editor-ai-'))
  const out: string[] = []
  for (const [i, img] of images.slice(0, MAX_IMAGES).entries()) {
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(img.dataUrl)
    if (m === null) continue
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) continue
    // the user's filename is display-only; the path stays ours (no traversal)
    const p = path.join(dir, `image-${i + 1}${IMG_EXT[m[1]] ?? '.png'}`)
    fs.writeFileSync(p, buf)
    out.push(p)
  }
  return out
}

// Spawn one turn and stream its events through `emit`. Resolves as soon as the
// child is running (with the turn id) — the conversation streams asynchronously;
// it does NOT wait for the turn to finish.
export function aiSend(
  params: AiSendParams,
  projectDir: string | null,
  emit: (e: AiEvent) => void,
  mcpConfig?: string
): { turnId: string } {
  if (projectDir === null) throw new Error('Open a scene before using the assistant.')
  const def = PROVIDERS[params.provider]
  if (def === undefined) throw new Error(`Unknown assistant "${params.provider}".`)
  const bin = findExecutable(def.binNames)
  if (bin === null) throw new Error(`${def.label} CLI not found — install it and sign in.`)

  aiStop() // supersede any in-flight turn
  const turnId = `t${++turnSeq}`
  // Prepend editor context (selected entity + components) to the prompt so the
  // assistant knows what "this entity" means, without the user retyping it.
  let prompt = params.context !== undefined && params.context !== '' ? `${params.context}\n\n---\n\n${params.text}` : params.text
  const images = writeAttachments(params.images)
  if (images.length > 0) {
    // The CLI gets the paths in the prompt; the instruction to view them matters — without it the model
    // sometimes answers without opening the files.
    prompt += `\n\n[The user attached ${images.length === 1 ? 'an image' : `${images.length} images`} to this message — view ${images.length === 1 ? 'it' : 'them'} before answering:\n${images.join('\n')}]`
  }
  const args = def.buildArgs({ text: prompt, model: params.model, projectDir, resume: sessions[params.provider], images, mcpConfig })

  let child: ChildProcess
  try {
    child = spawn(bin, args, {
      cwd: projectDir,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' // own process group so killTree reaps children
    })
  } catch (e) {
    throw new Error(`failed to launch ${def.label}: ${String(e)}`)
  }

  const turn = { child, turnId, done: false }
  current = turn
  emit({ kind: 'started', turnId })

  const finish = (ok: boolean, message?: string): void => {
    if (turn.done) return
    turn.done = true
    if (message !== undefined) emit({ kind: 'error', turnId, message })
    emit({ kind: 'done', turnId, ok })
    if (current === turn) current = null
  }

  let stderr = ''
  let buf = ''
  // StringDecoder buffers a multibyte UTF-8 codepoint split across two stdout
  // chunks; a plain buf += d.toString() would decode each half alone and emit
  // U+FFFD, corrupting emoji/i18n text mid-stream.
  const outDec = new StringDecoder('utf8')
  const errDec = new StringDecoder('utf8')
  const onLine = (line: string): void => {
    if (line === '') return
    const session = def.parseLine(line, projectDir, (text, tool) => {
      if (text !== '') emit({ kind: 'text', turnId, text })
      if (tool !== undefined) emit({ kind: 'tool', turnId, tool: tool[0], detail: tool[1] })
    })
    if (session !== undefined) sessions[params.provider] = session
  }

  child.stdout?.on('data', (d: Buffer) => {
    buf += outDec.write(d)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, nl).trim())
      buf = buf.slice(nl + 1)
    }
  })
  child.stderr?.on('data', (d: Buffer) => {
    stderr += errDec.write(d)
    if (stderr.length > 8000) stderr = stderr.slice(-8000)
  })
  child.on('error', (e) => finish(false, `assistant failed to start: ${e.message}`))
  child.on('exit', (code) => {
    buf += outDec.end()
    if (buf.trim() !== '') onLine(buf.trim()) // flush a trailing partial line
    if (code === 0 || code === null) finish(true)
    else finish(false, (stderr + errDec.end()).trim() || `assistant exited with code ${code}`)
  })

  return { turnId }
}
