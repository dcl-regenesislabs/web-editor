import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { setLibraryBytes } from './library-bytes'
import { iconCredits, iconSvg, isIconIndex, readBlock, searchIcons, type IconIndex } from './icon-library'

const SET = { url: 'https://example.test', license: { title: 'MIT', spdx: 'MIT', url: 'https://example.test/license' }, licenseText: 'MIT text' }

// a two-block catalog, built the way pack-icons.mjs builds the real one
function catalog(icons: Array<[string, string]>, perBlock = 2): { index: IconIndex; pack: Buffer } {
  const blocks: IconIndex['blocks'] = []
  const entries: IconIndex['icons'] = []
  const chunks: Buffer[] = []
  let offset = 0
  for (let i = 0; i < icons.length; i += perBlock) {
    const group = icons.slice(i, i + perBlock)
    const bytes = zlib.deflateRawSync(Buffer.from(group.map(([, svg]) => svg).join('\n')))
    const block = blocks.push([offset, bytes.length, crypto.createHash('sha256').update(bytes).digest('base64')]) - 1
    group.forEach(([id], position) => entries.push([id, block, position, id.startsWith('game-icons:') ? 0 : -1, '']))
    chunks.push(bytes)
    offset += bytes.length
  }
  return {
    index: {
      version: 1,
      sets: { tabler: { ...SET, name: 'Tabler Icons', attribution: false }, 'game-icons': { ...SET, name: 'Game Icons', attribution: true, license: { ...SET.license, title: 'CC BY 3.0' } } },
      authors: ['Lorc'],
      blocks,
      icons: entries
    },
    pack: Buffer.concat(chunks)
  }
}

function serve(pack: Buffer): void {
  setLibraryBytes({
    material: () => Promise.reject(new Error('unused')),
    sound: () => Promise.reject(new Error('unused')),
    iconIndex: () => Promise.reject(new Error('unused')),
    iconBlock: async (offset, length) => new Uint8Array(pack.subarray(offset, offset + length))
  })
}

const svg = (name: string): string => `<svg viewBox="0 0 24 24"><path d="${name}"/></svg>`
const ICONS: Array<[string, string]> = [
  ['tabler:heart', svg('heart')],
  ['tabler:heart-off', svg('heart-off')],
  ['tabler:heart-rate-monitor', svg('monitor')],
  ['game-icons:broadsword', svg('broadsword')],
  ['game-icons:heart-plus', svg('heart-plus')]
]

describe('searchIcons', () => {
  const { index } = catalog(ICONS)

  it('ranks the plain name first and sinks the crossed-out variant', () => {
    expect(searchIcons(index, 'heart', 10).map((m) => m.id)).toEqual(['tabler:heart', 'game-icons:heart-plus', 'tabler:heart-rate-monitor', 'tabler:heart-off'])
  })

  it('finds the crossed-out variant when asked for it', () => {
    expect(searchIcons(index, 'heart off', 1)[0].id).toBe('tabler:heart-off')
  })

  it('keeps to one set and names whom to credit', () => {
    expect(searchIcons(index, 'heart broadsword', 10, 'game-icons')).toEqual([
      { id: 'game-icons:broadsword', set: 'Game Icons', license: 'CC BY 3.0', credit: 'Icon made by Lorc, https://example.test' },
      { id: 'game-icons:heart-plus', set: 'Game Icons', license: 'CC BY 3.0', credit: 'Icon made by Lorc, https://example.test' }
    ])
  })

  it('matches whole words, never parts of one', () => {
    expect(searchIcons(index, 'art', 10)).toEqual([])
    expect(searchIcons(index, 'the icon', 10)).toEqual([])
  })
})

describe('reading the pack', () => {
  beforeEach(() => serve(catalog(ICONS).pack))

  it('inflates one icon from its block', async () => {
    const { index } = catalog(ICONS)
    expect((await iconSvg(index, 'game-icons:broadsword')).svg).toBe(svg('broadsword'))
  })

  it('refuses a block that does not match its checksum', async () => {
    const { index, pack } = catalog(ICONS)
    const tampered = Buffer.from(pack)
    tampered[index.blocks[2][0]] ^= 0xff
    serve(tampered)
    await expect(readBlock({ ...index }, 2)).rejects.toThrow('checksum')
  })

  it('says when an id is not in the catalog', async () => {
    await expect(iconSvg(catalog(ICONS).index, 'tabler:nope')).rejects.toThrow('findIcons')
  })
})

describe('iconCredits', () => {
  it('lists the folder\'s catalog icons with their credit and each license once', () => {
    const { index } = catalog(ICONS)
    const text = iconCredits(index, ['assets/images/icons/tabler-heart.png', 'assets/images/icons/game-icons-broadsword.png', 'assets/images/icons/mine.png'])
    expect(text).toContain('- `game-icons-broadsword.png`: Game Icons, CC BY 3.0. Icon made by Lorc, https://example.test')
    expect(text).toContain('- `tabler-heart.png`: Tabler Icons, MIT\n')
    expect(text).not.toContain('mine.png')
    expect(text.match(/## /g)).toHaveLength(2)
  })
})

describe('the committed catalog', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../icon-library')
  const index: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'icons.index.json'), 'utf8'))
  const pack = fs.readFileSync(path.join(dir, 'icons.pack'))

  it('is an index this editor reads, with every set licensed', () => {
    expect(isIconIndex(index)).toBe(true)
    if (!isIconIndex(index)) return
    for (const set of Object.values(index.sets)) expect(set.licenseText.length).toBeGreaterThan(50)
    expect(index.icons.some(([id]) => id.startsWith('tabler:brand-'))).toBe(false)
  })

  it('holds every icon at the place its index says, under a matching checksum', async () => {
    if (!isIconIndex(index)) throw new Error('not an index')
    serve(pack)
    const sizes = await Promise.all(index.blocks.map((_, block) => readBlock(index, block).then((svgs) => svgs.length)))
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(index.icons.length)
    for (const [id, block, position] of index.icons) {
      const svgs = await readBlock(index, block)
      expect(svgs[position]?.startsWith('<svg'), id).toBe(true)
    }
    const last = index.blocks.at(-1)
    expect(last === undefined ? 0 : last[0] + last[1]).toBe(pack.length)
  })
})
