// Regenerates src/icon-library/ from free icon sets: icons.pack holds every icon's SVG in deflate-raw blocks
// of BLOCK icons each, and icons.index.json says where each icon is, which set it comes from and whom to credit,
// so the editor fetches the index once and then only the blocks a search shows (an HTTP Range per block).
// Tiny SVGs compress poorly one by one (a zip of single icons is twice this size), hence the blocks.
// Run from the repo root: node packages/ui/scripts/pack-icons.mjs (needs tar and unzip).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BLOCK = 64
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/icon-library')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-icons-'))

const GAME_ICONS_COMMIT = '82d948812bfe3f269ef8f731dcdb07b08160edc4'
const KENNEY_INPUT_PROMPTS = 'https://opengameart.org/sites/default/files/kenney_input-prompts_1.zip'
// Brand marks are trademarks whatever the icon's license says; the abstract-N game icons are filler.
const ICONIFY = {
  'game-icons': {
    version: '1.2.4', name: 'Game Icons', url: 'https://game-icons.net', attribution: true,
    license: { title: 'CC BY 3.0', spdx: 'CC-BY-3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
    licenseFile: `https://raw.githubusercontent.com/game-icons/icons/${GAME_ICONS_COMMIT}/license.txt`,
    skip: (name) => /^abstract-\d+$/.test(name)
  },
  tabler: {
    version: '1.2.43', name: 'Tabler Icons', url: 'https://tabler.io/icons', attribution: false,
    license: { title: 'MIT', spdx: 'MIT', url: 'https://github.com/tabler/tabler-icons/blob/main/LICENSE' },
    licenseFile: 'https://raw.githubusercontent.com/tabler/tabler-icons/ed177a085b652fe04ec4f37ced867c94621e7840/LICENSE',
    skip: (name) => /^brand-/.test(name) || /^(pacman|pokeball)(-|$)/.test(name)
  },
  lucide: {
    version: '1.2.151', name: 'Lucide', url: 'https://lucide.dev', attribution: false,
    license: { title: 'ISC', spdx: 'ISC', url: 'https://github.com/lucide-icons/lucide/blob/main/LICENSE' },
    licenseFile: 'https://raw.githubusercontent.com/lucide-icons/lucide/1980e3d59b0fa1a2aeb566d5902b25ee98204001/LICENSE',
    skip: () => false
  },
  pixelarticons: {
    version: '1.2.10', name: 'Pixelarticons', url: 'https://pixelarticons.com', attribution: false,
    license: { title: 'MIT', spdx: 'MIT', url: 'https://github.com/halfmage/pixelarticons/blob/master/LICENSE' },
    licenseFile: 'https://raw.githubusercontent.com/halfmage/pixelarticons/c9ecc2da61afde85dbe539025e3d931c6152ad75/LICENSE',
    skip: () => false
  }
}
// The input prompt families a Decentraland scene can show: no console brand beyond the Xbox gamepad's
// lettered buttons (the pack ships no PlayStation symbols).
const KENNEY_FOLDERS = ['Generic', 'Keyboard & Mouse', 'Touch', 'Xbox Series', 'Flairs']
const KENNEY = {
  name: 'Kenney Input Prompts', url: 'https://kenney.nl/assets/input-prompts', attribution: false,
  license: { title: 'CC0 1.0', spdx: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' }
}

async function download(url, file) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
  return file
}

async function text(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return (await response.text()).trim()
}

const oneLine = (svg) => svg.replace(/<\?xml[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim()

// game-icons.net's own repo files each icon under its author's folder; Iconify keeps only the set's name
async function gameIconAuthors() {
  const tgz = await download(`https://codeload.github.com/game-icons/icons/tar.gz/${GAME_ICONS_COMMIT}`, path.join(work, 'game-icons.tgz'))
  const listing = execFileSync('tar', ['-tzf', tgz], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n')
  const license = execFileSync('tar', ['-xzOf', tgz, '--wildcards', '*/license.txt']).toString()
  const names = new Map()
  for (const line of license.split('\n')) {
    const m = /^- ([^,]+?)(?:,| - |$)/.exec(line.trim())
    if (m !== null) names.set(m[1].trim().toLowerCase().replace(/\s+/g, '-'), m[1].trim())
  }
  const authors = new Map()
  for (const entry of listing) {
    const m = /^[^/]+\/([^/]+)\/([^/]+)\.svg$/.exec(entry)
    if (m === null) continue
    const display = names.get(m[1]) ?? m[1].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
    if (!authors.has(m[2])) authors.set(m[2], display)
  }
  return authors
}

async function iconifySet(prefix, spec) {
  const tgz = await download(`https://registry.npmjs.org/@iconify-json/${prefix}/-/${prefix}-${spec.version}.tgz`, path.join(work, `${prefix}.tgz`))
  const data = JSON.parse(execFileSync('tar', ['-xzOf', tgz, 'package/icons.json'], { maxBuffer: 256 * 1024 * 1024 }).toString())
  const aliases = new Map()
  for (const [alias, { parent }] of Object.entries(data.aliases ?? {})) aliases.set(parent, [...(aliases.get(parent) ?? []), alias])
  const icons = []
  for (const [name, icon] of Object.entries(data.icons)) {
    if (spec.skip(name)) continue
    const w = icon.width ?? data.width ?? 16
    const h = icon.height ?? data.height ?? 16
    // currentColor resolves to the root's color: the editor paints icons white so a scene can tint them
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${icon.left ?? 0} ${icon.top ?? 0} ${w} ${h}" color="#fff">${icon.body}</svg>`
    icons.push({ name, svg: oneLine(svg), words: (aliases.get(name) ?? []).join(' ') })
  }
  return icons
}

async function kenneySet() {
  const zip = await download(KENNEY_INPUT_PROMPTS, path.join(work, 'kenney.zip'))
  const dir = path.join(work, 'kenney')
  execFileSync('unzip', ['-q', '-o', zip, '-d', dir])
  const icons = []
  for (const folder of KENNEY_FOLDERS) {
    const vector = path.join(dir, folder, 'Vector')
    for (const file of fs.readdirSync(vector).filter((f) => f.endsWith('.svg'))) {
      const name = file.slice(0, -4).toLowerCase().replace(/[_\s]+/g, '-')
      icons.push({ name, svg: oneLine(fs.readFileSync(path.join(vector, file), 'utf8')), words: folder.toLowerCase().replace(/&/g, ' ') })
    }
  }
  return { icons, license: fs.readFileSync(path.join(dir, 'License.txt'), 'utf8').replace(/\t/g, '').trim() }
}

const sets = {}
const families = []
const authors = await gameIconAuthors()
for (const [prefix, spec] of Object.entries(ICONIFY)) {
  const { version, licenseFile, skip, ...meta } = spec
  sets[prefix] = { ...meta, licenseText: await text(licenseFile) }
  families.push([prefix, await iconifySet(prefix, spec)])
  console.log(`${prefix}@${version}: ${families.at(-1)[1].length} icons`)
}
const kenney = await kenneySet()
sets.kenney = { ...KENNEY, licenseText: kenney.license }
families.push(['kenney', kenney.icons])
console.log(`kenney input prompts: ${kenney.icons.length} icons`)

// [id, block, position in block, author (index into authors), extra search words]
const authorList = []
const authorIndex = (name) => {
  let at = authorList.indexOf(name)
  if (at < 0) at = authorList.push(name) - 1
  return at
}
const blocks = []
const entries = []
const chunks = []
let offset = 0
for (const [prefix, icons] of families) {
  icons.sort((a, b) => a.name.localeCompare(b.name))
  for (let i = 0; i < icons.length; i += BLOCK) {
    const group = icons.slice(i, i + BLOCK)
    const bytes = zlib.deflateRawSync(Buffer.from(group.map((icon) => icon.svg).join('\n')), { level: 9 })
    const block = blocks.push([offset, bytes.length, crypto.createHash('sha256').update(bytes).digest('base64')]) - 1
    group.forEach((icon, position) => {
      const author = prefix === 'game-icons' ? authorIndex(authors.get(icon.name) ?? 'game-icons.net contributors') : -1
      entries.push([`${prefix}:${icon.name}`, block, position, author, icon.words])
    })
    chunks.push(bytes)
    offset += bytes.length
  }
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'icons.pack'), Buffer.concat(chunks))
fs.writeFileSync(path.join(out, 'icons.index.json'), JSON.stringify({ version: 1, sets, authors: authorList, blocks, icons: entries }))
const rows = Object.entries(sets).map(([prefix, s]) =>
  `| \`${prefix}\` | [${s.name}](${s.url}) | [${s.license.title}](${s.license.url}) | ${entries.filter(([id]) => id.startsWith(`${prefix}:`)).length} | ${s.attribution ? 'yes' : 'no'} |`)
fs.writeFileSync(path.join(out, 'CREDITS.md'), `# Icon credits

The icon catalog the assistant searches (\`findIcons\`) and copies into scenes (\`addIcon\`). Every set allows
commercial use and redistribution. A scene gets each icon it uses as a PNG under \`assets/images/icons/\`, next to
a \`CREDITS.md\` naming the set, its license and, for game-icons.net, the icon's author.
Brand icons (Tabler's \`brand-*\`, \`pacman\`, \`pokeball\`) and game-icons.net's \`abstract-N\` filler are left out.
Regenerate with \`node packages/ui/scripts/pack-icons.mjs\`.

| Prefix | Set | License | Icons | Per-icon author credit |
|---|---|---|---|---|
${rows.join('\n')}

Total: ${entries.length} icons in ${blocks.length} blocks, ${(offset / 1024 / 1024).toFixed(2)} MB.
`)
fs.rmSync(work, { recursive: true, force: true })
console.log(`${entries.length} icons, ${blocks.length} blocks, pack ${(offset / 1048576).toFixed(2)} MB, index ${(fs.statSync(path.join(out, 'icons.index.json')).size / 1048576).toFixed(2)} MB`)
