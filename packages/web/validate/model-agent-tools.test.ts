import { expect, it } from 'vitest'
import { orderedBrowserTools } from './model-agent-tools'

it('preserves both simultaneous script edits and rebuilds the edited version', async () => {
  let script = 'width=1;height=1'
  const run = orderedBrowserTools(async (name, args) => {
    const before = script
    await Promise.resolve()
    if (name === 'edit_file') script = before.replace(String(args.old), String(args.new))
    return script
  })
  const results = await Promise.all([
    run('edit_file', { old: 'width=1', new: 'width=2' }),
    run('edit_file', { old: 'height=1', new: 'height=3' }),
    run('scene_request', { request: { type: 'buildModel', script: 'models/src/chair.js' } })
  ])
  expect(results.at(-1)).toBe('width=2;height=3')
  expect(script).toBe('width=2;height=3')
})

it('allows catalog searches during a pending edit, then continues after a failed edit', async () => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  const finished: string[] = []
  const run = orderedBrowserTools(async (name) => {
    if (name === 'edit_file') {
      await pending
      throw new Error('Edit conflict')
    }
    finished.push(name)
    return name
  })
  const failed = expect(run('edit_file', {})).rejects.toThrow('Edit conflict')
  const queued = run('read_file', {})
  await run('scene_request', { request: { type: 'findModels', query: 'tree' } })
  expect(finished).toEqual(['scene_request'])
  release()
  await failed
  await queued
  expect(finished).toEqual(['scene_request', 'read_file'])
})
