// The icon catalog (src/icon-library/, built by scripts/pack-icons.mjs): one index the editor reads once,
// and icons.pack, whose deflate-raw blocks are fetched one byte range at a time, checked against the
// index's sha256 and inflated in the browser, so a search touches a few blocks and never the whole pack.
import { object } from '@dcl-editor/contract'
import { iconBlockBytes, iconIndexBytes } from './library-bytes'
import { searchWords } from './model-search'

export interface IconSet {
  name: string
  url: string
  // CC BY: every icon names its author in the scene's credits
  attribution: boolean
  license: { title: string; spdx: string; url: string }
  licenseText: string
}

type IndexEntry = [id: string, block: number, position: number, author: number, words: string]

export interface IconIndex {
  version: 1
  sets: Record<string, IconSet>
  authors: string[]
  blocks: Array<[offset: number, length: number, sha256: string]>
  icons: IndexEntry[]
}

export interface IconMatch {
  id: string
  set: string
  license: string
  credit?: string
}

// no 'a': a key or a gamepad button can be one letter
const STOP = new Set(['an', 'the', 'of', 'with', 'for', 'and', 'or', 'to', 'in', 'on', 'icon', 'icons', 'symbol', 'glyph'])

export function isIconIndex(value: unknown): value is IconIndex {
  return object(value) && value.version === 1 && object(value.sets) && Array.isArray(value.authors) &&
    Array.isArray(value.blocks) && Array.isArray(value.icons)
}

export function iconPrefix(id: string): string {
  return id.slice(0, Math.max(0, id.indexOf(':')))
}

export function iconCredit(index: IconIndex, entry: IndexEntry): string | undefined {
  const set = index.sets[iconPrefix(entry[0])]
  if (set?.attribution !== true) return undefined
  const author = index.authors[entry[3]]
  return author === undefined ? `${set.name} (${set.url})` : `Icon made by ${author}, ${set.url}`
}

type Searchable = { entry: IndexEntry; name: string[]; extra: string[]; prefix: string; off: boolean }
const searchable = new WeakMap<IconIndex, Searchable[]>()

function rows(index: IconIndex): Searchable[] {
  let list = searchable.get(index)
  if (list === undefined) {
    list = index.icons.map((entry) => {
      const prefix = iconPrefix(entry[0])
      const name = searchWords(entry[0].slice(prefix.length + 1))
      return { entry, name, extra: searchWords(entry[4]), prefix, off: name.at(-1) === 'off' }
    })
    searchable.set(index, list)
  }
  return list
}

// whole words in the icon's name first, then its aliases; "-off" variants (a crossed-out heart) sink unless asked
// for, and among equals the shortest name wins: "heart" before "heart-rate-monitor"
export function searchIcons(index: IconIndex, query: string, limit: number, set?: string): IconMatch[] {
  const wanted = [...new Set(searchWords(query).filter((w) => !STOP.has(w)))]
  if (wanted.length === 0) return []
  const askedOff = wanted.includes('off')
  const scored: Array<{ row: Searchable; matched: number; score: number }> = []
  for (const row of rows(index)) {
    if (set !== undefined && row.prefix !== set) continue
    let matched = 0
    let score = 0
    for (const w of wanted) {
      const hit = row.name.includes(w) ? 3 : row.extra.includes(w) || row.prefix === w ? 1 : 0
      if (hit > 0) matched++
      score += hit
    }
    if (matched > 0) scored.push({ row, matched, score })
  }
  scored.sort((p, q) => q.matched - p.matched || Number(!askedOff && p.row.off) - Number(!askedOff && q.row.off) ||
    q.score - p.score || p.row.name.length - q.row.name.length || p.row.entry[0].localeCompare(q.row.entry[0]))
  // not `({ row }) =>`: this rollup crashes on it ("this.includeNode is not a function") building the web editor
  return scored.slice(0, limit).map((hit) => {
    const row = hit.row
    const s = index.sets[row.prefix]
    const credit = iconCredit(index, row.entry)
    return { id: row.entry[0], set: s?.name ?? row.prefix, license: s?.license.title ?? 'unknown', ...(credit === undefined ? {} : { credit }) }
  })
}

let loaded: Promise<IconIndex> | null = null

export function loadIconIndex(): Promise<IconIndex> {
  loaded ??= iconIndexBytes().then((bytes) => {
    const index: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!isIconIndex(index)) throw new Error('The icon catalog index is not one this editor reads.')
    return index
  })
  loaded.catch(() => { loaded = null })
  return loaded
}

function base64(bytes: ArrayBuffer): string {
  let binary = ''
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b)
  return btoa(binary)
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return await new Response(stream).text()
}

const inflated = new WeakMap<IconIndex, Map<number, Promise<string[]>>>()

export async function readBlock(index: IconIndex, block: number): Promise<string[]> {
  let blocks = inflated.get(index)
  if (blocks === undefined) {
    blocks = new Map()
    inflated.set(index, blocks)
  }
  const cache = blocks
  let pending = cache.get(block)
  if (pending === undefined) {
    const spec = index.blocks[block]
    if (spec === undefined) throw new Error(`The icon catalog has no block ${block}.`)
    const [offset, length, sha256] = spec
    pending = (async () => {
      const bytes = await iconBlockBytes(offset, length)
      if (bytes.length !== length || base64(await crypto.subtle.digest('SHA-256', bytes)) !== sha256) {
        throw new Error('An icon catalog block did not match its checksum.')
      }
      return (await inflate(bytes)).split('\n')
    })()
    cache.set(block, pending)
    pending.catch(() => cache.delete(block))
  }
  return await pending
}

export async function iconSvg(index: IconIndex, id: string): Promise<{ svg: string; entry: IndexEntry }> {
  const entry = index.icons.find((icon) => icon[0] === id)
  if (entry === undefined) throw new Error(`There is no icon ${id}. Use an id findIcons answered.`)
  const svg = (await readBlock(index, entry[1]))[entry[2]]
  if (svg === undefined) throw new Error(`The icon catalog is missing ${id}.`)
  return { svg, entry }
}

export const ICON_DIR = 'assets/images/icons'
export const iconFileName = (id: string): string => `${id.replace(':', '-')}.png`
export const iconPath = (id: string): string => `${ICON_DIR}/${iconFileName(id)}`

// assets/images/icons/CREDITS.md, rebuilt from the icons the folder holds: what each one is, its set and
// license, the author game-icons.net asks to be named, and each license's text once (MIT and ISC ask for it)
export function iconCredits(index: IconIndex, files: string[]): string {
  const byFile = new Map(index.icons.map((entry) => [`${ICON_DIR}/${iconFileName(entry[0])}`, entry]))
  const used = files.map((file) => byFile.get(file)).filter((entry): entry is IndexEntry => entry !== undefined)
    .sort((a, b) => a[0].localeCompare(b[0]))
  const prefixes = [...new Set(used.map((entry) => iconPrefix(entry[0])))]
  const lines = used.map((entry) => {
    const set = index.sets[iconPrefix(entry[0])]
    const credit = iconCredit(index, entry)
    return `- \`${iconFileName(entry[0])}\`: ${set?.name ?? iconPrefix(entry[0])}, ${set?.license.title ?? ''}${credit === undefined ? '' : `. ${credit}`}`
  })
  const licenses = prefixes.map((prefix) => {
    const set = index.sets[prefix]
    if (set === undefined) return ''
    return `## ${set.name}\n\n${set.url} — [${set.license.title}](${set.license.url})\n\n\`\`\`\n${set.licenseText}\n\`\`\``
  }).filter((text) => text !== '')
  return `# Icon credits\n\nThe icons in this folder come from free icon sets; each keeps its license.\n\n${lines.join('\n')}\n\n${licenses.join('\n\n')}\n`
}
