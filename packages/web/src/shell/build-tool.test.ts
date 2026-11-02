import { describe, expect, it, vi } from 'vitest'
import { createBuildTool } from './build-tool'

const COMPOSITE = 'assets/scene/main.composite'
const run = { reloaded: true, errors: [], serverErrors: [] }

// The project as the web shell holds it: writes queue on one chain, and the build reads the files.
function project() {
  const files = new Map<string, string>([[COMPOSITE, 'before the edit']])
  let writes: Promise<unknown> = Promise.resolve()
  const write = (path: string, content: string): void => {
    writes = writes.then(() => new Promise((resolve) => setTimeout(resolve, 5))).then(() => files.set(path, content))
  }
  return { files, write, writes: () => writes }
}

describe('the assistant build tool', () => {
  it('compiles the edit the autosave was still holding', async () => {
    const { files, write, writes } = project()
    let built = ''
    const build = createBuildTool({
      // the debounced save, flushed: it queues the composite write
      saveScene: async () => write(COMPOSITE, 'after the edit'),
      fileWrites: writes,
      compile: async () => {
        built = files.get(COMPOSITE) ?? ''
        return { ok: true, diagnostics: [] }
      },
      run: async () => run,
      mobilePreview: () => 'closed'
    })
    await expect(build(new AbortController().signal)).resolves.toMatchObject({ ok: true, run })
    expect(built).toBe('after the edit')
  })

  it('does not compile when the scene could not be saved', async () => {
    const compile = vi.fn(async () => ({ ok: true, diagnostics: [] }))
    const build = createBuildTool({
      saveScene: async () => { throw new Error('The scene could not be saved') },
      fileWrites: async () => {},
      compile,
      run: async () => run,
      mobilePreview: () => 'closed'
    })
    await expect(build(new AbortController().signal)).rejects.toThrow('could not be saved')
    expect(compile).not.toHaveBeenCalled()
  })
})
