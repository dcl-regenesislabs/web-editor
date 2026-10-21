import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

const script = readFileSync(new URL('./capture.js', import.meta.url), 'utf8')
afterEach(() => vi.useRealTimers())
function setup() {
  vi.useFakeTimers()
  const source = { width: 1600, height: 720 }
  const drawImage = vi.fn()
  const frame = { width: 0, height: 0, getContext: () => ({ drawImage }) }
  const queue = { submit: vi.fn() }
  const original = queue.submit
  const scope: { captureMobilePreviewFrame?: (gpuQueue: typeof queue, canvas: typeof source) => Promise<typeof frame> } = {}
  vm.runInNewContext(script, { window: scope, document: { createElement: () => frame }, WeakMap, Promise, Error, setTimeout, clearTimeout, queueMicrotask })
  const capture = scope.captureMobilePreviewFrame
  if (!capture) throw new Error('Missing capture helper')
  return { capture, queue, original, source, drawImage, frame }
}

it('copies the rendered frame after submissions, before browser presentation clears it', async () => {
  const { capture, queue, original, source, drawImage, frame } = setup()
  const picture = capture(queue, source)
  expect(capture(queue, source)).toBe(picture)
  expect(drawImage).not.toHaveBeenCalled()
  queue.submit()
  queue.submit()
  expect(await picture).toBe(frame)
  expect(original).toHaveBeenCalledTimes(2)
  expect(drawImage).toHaveBeenCalledOnce()
  expect(frame).toMatchObject({ width: 1024, height: 461 })
  expect(queue.submit).toBe(original)
  expect(vi.getTimerCount()).toBe(0)
})

it('restores the queue if rendering stops before a capture arrives', async () => {
  const { capture, queue, original, source } = setup()
  const picture = expect(capture(queue, source)).rejects.toThrow('did not render')
  await vi.advanceTimersByTimeAsync(5000)
  await picture
  expect(queue.submit).toBe(original)
})
