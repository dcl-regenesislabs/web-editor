import { readFile, readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import { object } from '../../../contract/src/assistant.ts'

const PAGE_SIZE = 16_000
const SKILLS_DIR = new URL('../../skills/', import.meta.url)
// SDK skills an editor skill replaces: their SKILL.md leaves the catalog, their
// references stay readable because the editor skill links to them.
const SUPERSEDED = new Set(['build-ui'])

export interface SkillsComponent {
  catalog: string
  read(path: string, offset?: number, query?: string): string
}

// The editor's own skills: every folder next to the bundle that holds a SKILL.md.
async function readEditorSkills(): Promise<{ files: Map<string, string>; catalog: Array<{ name: string; description: string }> }> {
  const files = new Map<string, string>()
  const catalog: Array<{ name: string; description: string }> = []
  async function collect(directory: URL, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await collect(new URL(`${entry.name}/`, directory), `${prefix}/${entry.name}`)
      else if (entry.isFile() && entry.name.endsWith('.md')) files.set(`${prefix}/${entry.name}`, await readFile(new URL(entry.name, directory), 'utf8'))
    }
  }
  for (const entry of await readdir(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = new URL(`${entry.name}/`, SKILLS_DIR)
    if (!(await readdir(directory)).includes('SKILL.md')) continue
    await collect(directory, entry.name)
    const raw = /^description: (.+)$/m.exec(files.get(`${entry.name}/SKILL.md`) ?? '')?.[1]
    if (raw === undefined) throw new Error(`Missing description: ${entry.name}`)
    catalog.push({ name: entry.name, description: raw.startsWith('"') ? JSON.parse(raw) : raw })
  }
  return { files, catalog }
}

export async function createSkillsComponent(): Promise<SkillsComponent> {
  const bundle: unknown = JSON.parse(await readFile(new URL('sdk-skills.json', SKILLS_DIR), 'utf8'))
  if (!object(bundle) || !object(bundle.files) || !Array.isArray(bundle.catalog)) throw new Error('Invalid SDK skills bundle')
  const files = new Map<string, string>()
  for (const [path, content] of Object.entries(bundle.files)) {
    if (typeof content !== 'string') throw new Error('Invalid SDK skill document')
    files.set(path, content)
  }
  const sdkCatalog = bundle.catalog.map((skill: unknown) => {
    if (!object(skill) || typeof skill.name !== 'string' || typeof skill.description !== 'string' || !files.has(`${skill.name}/SKILL.md`)) {
      throw new Error('Invalid SDK skill catalog')
    }
    return { name: skill.name, description: skill.description }
  })
  const editor = await readEditorSkills()
  for (const name of SUPERSEDED) files.delete(`${name}/SKILL.md`)
  for (const [path, content] of editor.files) files.set(path, content)
  const editorNames = new Set(editor.catalog.map((skill) => skill.name))
  const catalog = [...editor.catalog, ...sdkCatalog.filter((skill) => !SUPERSEDED.has(skill.name) && !editorNames.has(skill.name))]
    .map((skill) => `- ${skill.name}/SKILL.md: ${skill.description}`).join('\n')
  return {
    catalog,
    read(path, offset = 0, query) {
      // Lookups use only this packaged map; model-supplied paths never reach the filesystem.
      if (path.length > 512 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) throw new Error('Unknown SDK skill document')
      const key = posix.normalize(path)
      const source = files.get(key)
      if (source === undefined) throw new Error('Unknown SDK skill document')
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid skill offset')
      const baseDir = key.split('/')[0]
      const content = source.replaceAll('{baseDir}', baseDir)
      if (query !== undefined) {
        if (query.trim() === '' || query.length > 128) throw new Error('Invalid skill search')
        const matches: Array<{ offset: number; text: string }> = []
        let cursor = 0
        let total = 0
        for (const line of content.split('\n')) {
          if (cursor >= offset && line.toLowerCase().includes(query.toLowerCase())) {
            total++
            if (matches.length < 20) matches.push({ offset: cursor, text: line.slice(0, 640) })
          }
          cursor += line.length + 1
        }
        return JSON.stringify({ path: key, matches, total })
      }
      const end = Math.min(offset + PAGE_SIZE, content.length)
      return JSON.stringify({
        path: key, baseDir, offset, content: content.slice(offset, end),
        nextOffset: end < content.length ? end : null,
        ...(key.endsWith('/SKILL.md') ? { references: [...files.keys()].filter((file) => file.startsWith(`${baseDir}/`) && file !== key) } : {})
      })
    }
  }
}
