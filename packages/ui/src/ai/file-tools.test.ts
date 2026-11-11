import { describe, expect, it, vi } from 'vitest'
import { createFileTools, sameBytes } from './file-tools'
import { publishableFiles } from '../../../scene-compiler/src/preview-entity'

const encode = (text: string) => new TextEncoder().encode(text)

function fixture() {
  const files = new Map<string, Uint8Array>([['models/src/chair.js', encode('const height = 0.9;')]])
  const written = vi.fn()
  const run = createFileTools({
    paths: async () => [...files.keys()],
    read: async (path) => files.get(path),
    write: async (path, bytes, expected) => {
      if (!sameBytes(files.get(path), expected)) throw new Error('File changed.')
      files.set(path, bytes)
    },
    written
  })
  return { files, written, run: (tool: Parameters<typeof run>[0], args: Record<string, unknown>) => run(tool, args, new AbortController().signal) }
}

describe('editing saved model scripts', () => {
  it.each(['write_file', 'edit_file'] as const)('excludes scripts from publishing after %s, before any model build', async (tool) => {
    const { files, run } = fixture()
    files.set('models/chair.glb', new Uint8Array([1]))
    files.set('.dclignore', encode('drafts/'))
    const args = tool === 'write_file'
      ? { path: 'models/src/table.js', content: 'root.add(table)', revision: null }
      : { path: 'models/src/chair.js', old: '0.9', new: '1.1' }
    await run(tool, args)
    const ignored = new TextDecoder().decode(files.get('.dclignore'))
    expect(ignored).toContain('drafts/')
    expect(publishableFiles(files.keys(), ignored)).toContain('models/chair.glb')
    expect(publishableFiles(files.keys(), ignored).filter((path) => path.startsWith('models/src/'))).toEqual([])
  })

  it('refuses a script write when its publish exclusion cannot be saved', async () => {
    const write = vi.fn(async (path: string) => { if (path === '.dclignore') throw new Error('Write conflict') })
    const run = createFileTools({ paths: async () => [], read: async () => undefined, write })
    await expect(run('write_file', { path: 'models/src/chair.js', content: 'code', revision: null }, new AbortController().signal)).rejects.toThrow('Write conflict')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toBe('.dclignore')
  })

  it('edits a generated script with the same revision safeguards as scene code', async () => {
    const { files, run, written } = fixture()
    const read = JSON.parse(await run('read_file', { path: 'models/src/chair.js' }))
    await run('edit_file', { path: read.path, old: '0.9', new: '1.1' })
    expect(new TextDecoder().decode(files.get(read.path))).toBe('const height = 1.1;')
    expect(written).toHaveBeenCalledWith(read.path, 'const height = 1.1;')
    await expect(run('write_file', { path: read.path, revision: read.revision, content: 'old read' })).rejects.toThrow('Read this file')
    const latest = JSON.parse(await run('read_file', { path: read.path }))
    files.set(read.path, encode('changed elsewhere'))
    await expect(run('write_file', { path: read.path, revision: latest.revision, content: 'overwrite' })).rejects.toThrow('File changed')
  })

  it.each(['models/chair.js', 'models/src/../chair.js', 'models/src/.hidden.js', 'models/src/nested/chair.js', 'models/src/chair.json', 'src/runtime/foo.js', 'scene.json'])(
    'keeps unrelated and unsafe files protected (%s)', async (path) => {
      await expect(fixture().run('write_file', { path, content: '', revision: null })).rejects.toThrow()
    }
  )
})
