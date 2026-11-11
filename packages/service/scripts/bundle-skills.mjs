import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const revision = '5bfec62d8a72ea25de187d861a64b16e62c0fbf2'
const repository = 'https://github.com/decentraland/sdk-skills'
const excluded = new Set([
  'create-scene', 'deploy-scene', 'deploy-worlds', 'migrate-sdk6-to-sdk7', 'sdk-scenes',
  'creator-hub-mcp', 'unity-explorer-mcp', 'report-sdk-issue', 'avatar-animations',
  'wearables', 'smart-wearables', 'promote-scene', 'scene-retro', 'scene-feedback', 'dcl-prototype'
])
const destination = new URL('../skills/', import.meta.url)
const work = await mkdtemp(join(tmpdir(), 'editor-sdk-skills-'))
try {
  const response = await fetch(`https://codeload.github.com/decentraland/sdk-skills/tar.gz/${revision}`, {
    signal: AbortSignal.timeout(90_000)
  })
  if (!response.ok) throw new Error(`SDK skills download failed: ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  await writeFile(join(work, 'repo.tar.gz'), archive)
  await mkdir(join(work, 'repo'))
  execFileSync('tar', ['-xzf', join(work, 'repo.tar.gz'), '-C', join(work, 'repo'), '--strip-components', '1'])
  const files = {}
  const catalog = []
  async function collect(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name.startsWith('.')) continue
      const path = `${prefix}/${entry.name}`
      if (entry.isDirectory()) await collect(join(directory, entry.name), path)
      if (!entry.isFile() || !/\.(md|mdc)$/.test(entry.name)) continue
      if (entry.name === 'SKILL.md' && excluded.has(prefix)) continue
      files[path] = await readFile(join(directory, entry.name), 'utf8')
    }
  }
  for (const entry of (await readdir(join(work, 'repo'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]+$/.test(entry.name)) continue
    const dir = join(work, 'repo', entry.name)
    if (!(await readdir(dir)).includes('SKILL.md')) continue
    await collect(dir, entry.name)
    if (excluded.has(entry.name)) continue
    const source = files[`${entry.name}/SKILL.md`]
    const raw = /^description: (.+)$/m.exec(source)?.[1]
    if (raw === undefined) throw new Error(`Missing description: ${entry.name}`)
    const description = raw.startsWith('"') ? JSON.parse(raw) : raw
    catalog.push({ name: entry.name, description })
  }
  const bundle = { repository, revision, archiveSha256: createHash('sha256').update(archive).digest('hex'), catalog, files }
  await mkdir(destination, { recursive: true })
  await writeFile(new URL('sdk-skills.json', destination), `${JSON.stringify(bundle, null, 2)}\n`)
  await writeFile(new URL('LICENSE', destination), await readFile(join(work, 'repo', 'LICENSE')))
  console.log(`Bundled ${catalog.length} skills and ${Object.keys(files).length} documents at ${revision}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
