// The project-file tools both assistants call (list_files, search_files, read_file, edit_file,
// write_file): over the browser's copy of the project on the web, over the files on disk on desktop.
import { ASSET_KINDS, ASSISTANT_MAX_FILE_BYTES, assetKind, assistantReadable, assistantWritable } from '@dcl-editor/contract'

export const FILE_TOOLS = ['list_files', 'search_files', 'read_file', 'edit_file', 'write_file'] as const
export type FileToolName = (typeof FILE_TOOLS)[number]

export function isFileTool(name: string): name is FileToolName {
  return (FILE_TOOLS as readonly string[]).includes(name)
}

export interface ProjectFiles {
  // every file path in the project, '/'-separated from its root
  paths(): Promise<string[]>
  read(path: string): Promise<Uint8Array | undefined>
  // fails when the file no longer holds `expected` (null: when it exists at all)
  write(path: string, bytes: Uint8Array, expected: Uint8Array | null, signal: AbortSignal): Promise<void>
  // after a successful write; answers the entity a new script was attached to
  written?(path: string, content: string, created: boolean): Promise<{ id: string; name: string } | null>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function sameBytes(a: Uint8Array | undefined, b: Uint8Array | null): boolean {
  return a === undefined ? b === null : b !== null && a.length === b.length && a.every((v, i) => v === b[i])
}

const MAX_SEARCH_HITS = 100
const MAX_QUERY_HITS = 60

function lineMatcher(query: unknown, regex: unknown): (line: string) => boolean {
  if (typeof query !== 'string' || query.trim() === '') throw new Error('query must be the text to look for.')
  if (regex === true) {
    let pattern: RegExp
    try { pattern = new RegExp(query, 'i') } catch { throw new Error('query is not a valid regular expression.') }
    return (line) => pattern.test(line)
  }
  const needle = query.toLowerCase()
  return (line) => line.toLowerCase().includes(needle)
}

function count(haystack: string, needle: string): number {
  let n = 0
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) n++
  return n
}

function lineArg(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a whole number from 1.`)
  return value
}

// One per conversation: write_file checks against what this conversation last read.
export function createFileTools(project: ProjectFiles) {
  const reads = new Map<string, { revision: string; bytes: Uint8Array; whole: boolean }>()
  return async (tool: FileToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    if (tool === 'list_files') {
      const kind = typeof args.kind === 'string' && (ASSET_KINDS as readonly string[]).includes(args.kind) ? args.kind : null
      const match = typeof args.match === 'string' ? args.match.toLowerCase() : ''
      // models, images and sounds too: they can't be read, but scripts and components name them by path
      return JSON.stringify((await project.paths()).filter((path) => {
        const of = assetKind(path)
        if (of === null || (of === 'code' && !assistantReadable(path))) return false
        return (kind === null || of === kind) && path.toLowerCase().includes(match)
      }).sort().slice(0, 2000))
    }
    if (tool === 'search_files') {
      const matches = lineMatcher(args.query, args.regex)
      const within = typeof args.match === 'string' ? args.match.toLowerCase() : ''
      const hits: string[] = []
      let total = 0
      for (const path of (await project.paths()).sort((a, b) => a.localeCompare(b))) {
        if (!assistantReadable(path) || !path.toLowerCase().includes(within)) continue
        const bytes = await project.read(path)
        if (bytes === undefined || bytes.byteLength > ASSISTANT_MAX_FILE_BYTES) continue
        let text: string
        try { text = decoder.decode(bytes) } catch { continue }
        text.split('\n').forEach((line, i) => {
          if (!matches(line)) return
          total++
          if (hits.length < MAX_SEARCH_HITS) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 200)}`)
        })
      }
      return JSON.stringify({ hits, total, ...(total > hits.length ? { more: 'Narrow query or match to see the rest.' } : {}) })
    }
    const path = args.path
    if (typeof path !== 'string' || !assistantReadable(path)) throw new Error('This path is not an assistant-readable project file.')
    const bytes = await project.read(path)
    if (tool === 'read_file') {
      if (bytes === undefined) return JSON.stringify({ path, content: null, revision: null })
      if (bytes.byteLength > ASSISTANT_MAX_FILE_BYTES) throw new Error('This file is too large for the assistant.')
      const content = decoder.decode(bytes)
      const revision = crypto.randomUUID()
      const offset = lineArg(args.offset, 'offset')
      const limit = lineArg(args.limit, 'limit')
      const whole = offset === undefined && limit === undefined && args.query === undefined
      reads.set(path, { revision, bytes: bytes.slice(), whole })
      if (whole) return JSON.stringify({ path, content, revision })
      const lines = content.split('\n')
      const numbered = (i: number): string => `${i + 1}| ${lines[i]}`
      if (args.query !== undefined) {
        const matches = lineMatcher(args.query, args.regex)
        const at = lines.flatMap((line, i) => (matches(line) ? [i] : []))
        return JSON.stringify({ path, revision, totalLines: lines.length, matches: at.slice(0, MAX_QUERY_HITS).map(numbered), total: at.length })
      }
      const from = (offset ?? 1) - 1
      const to = Math.min(lines.length, from + (limit ?? lines.length))
      return JSON.stringify({ path, revision, totalLines: lines.length, lines: lines.slice(from, to).map((_, i) => numbered(from + i)).join('\n') })
    }
    if (tool === 'edit_file') {
      if (!assistantWritable(path)) throw new Error('The assistant can write source files; scene data is changed through editor actions.')
      if (bytes === undefined) throw new Error('This file does not exist; create it with write_file.')
      if (typeof args.old !== 'string' || args.old === '' || typeof args.new !== 'string') throw new Error('edit_file needs the exact old text and its new text.')
      const content = decoder.decode(bytes)
      const found = count(content, args.old)
      if (found === 0) throw new Error('old was not found: the file differs from what you expect. read_file it (a query or a range) and copy the text exactly.')
      if (found > 1 && args.all !== true) throw new Error(`old appears ${found} times: include more surrounding text to make it unique, or all: true to change every one.`)
      const changed = args.all === true ? content.split(args.old).join(args.new) : content.replace(args.old, () => args.new as string)
      const next = encoder.encode(changed)
      if (next.byteLength > ASSISTANT_MAX_FILE_BYTES) throw new Error('This file is too large for the assistant.')
      await project.write(path, next, bytes.slice(), signal)
      signal.throwIfAborted()
      const revision = crypto.randomUUID()
      reads.set(path, { revision, bytes: next, whole: reads.get(path)?.whole ?? false })
      await project.written?.(path, changed, false)
      return JSON.stringify({ path, revision, replaced: found > 1 && args.all === true ? found : 1 })
    }
    if (tool !== 'write_file' || !assistantWritable(path)) throw new Error('The assistant can write source files; scene data is changed through editor actions.')
    if (typeof args.content !== 'string') throw new Error('Missing file content.')
    const next = encoder.encode(args.content)
    if (next.byteLength > ASSISTANT_MAX_FILE_BYTES) throw new Error('This file is too large for the assistant.')
    const read = reads.get(path)
    const expected = args.revision === null ? null : read?.bytes
    if (expected === undefined || (args.revision !== null && args.revision !== read?.revision)) {
      throw new Error('Read this file before changing it.')
    }
    // a whole-file write after seeing only part of it would drop the rest
    if (expected !== null && read?.whole === false) throw new Error('You read only part of this file: change it with edit_file, or read it whole before replacing it.')
    await project.write(path, next, expected, signal)
    signal.throwIfAborted()
    const revision = crypto.randomUUID()
    reads.set(path, { revision, bytes: next, whole: true })
    const attached = (await project.written?.(path, args.content, expected === null)) ?? null
    return JSON.stringify({ path, revision, created: expected === null, ...(attached === null ? {} : { attached }) })
  }
}
