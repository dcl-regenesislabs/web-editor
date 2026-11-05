import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { captureView, MOBILE_VIEW_TIMEOUT_MS, VIEW_TIMEOUT_MS } from './view'

const engine = vi.hoisted(() => ({ consoleCommand: vi.fn(() => new Promise<string>(() => {})) }))
vi.mock('../engine/console', () => engine)
vi.mock('../actions/selection', () => ({ uiFocusEntity: vi.fn() }))
vi.mock('../actions/viewport', () => ({ uiHoldCamera: vi.fn(async () => {}), uiReleaseCamera: vi.fn(async () => {}), uiPoseCamera: vi.fn(async () => {}) }))

const request = { target: 'editor' as const, openIfClosed: false, entity: null, from: null, lookAt: null }

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('fails a view the engine never answers instead of holding the turn', async () => {
  vi.stubGlobal('window', {})
  const rejected = expect(captureView(request, new AbortController().signal)).rejects.toThrow(/did not give a picture within 45 s/)
  await vi.advanceTimersByTimeAsync(VIEW_TIMEOUT_MS)
  await rejected
  expect(engine.consoleCommand).toHaveBeenCalledWith('/screenshot')
  expect(vi.getTimerCount()).toBe(0)
})

it('fails a mobile view whose preview never gives a picture', async () => {
  const shell = {
    phonePreviewState: () => ({ mode: 'embedded' as const, ready: true, url: 'http://preview.test/' }),
    onPhonePreviewState: () => () => {},
    capturePhonePreview: vi.fn(() => new Promise(() => {}))
  }
  vi.stubGlobal('window', { editorShell: shell })
  const rejected = expect(captureView({ ...request, target: 'mobile' }, new AbortController().signal)).rejects.toThrow(/mobile preview did not give a picture/)
  await vi.advanceTimersByTimeAsync(MOBILE_VIEW_TIMEOUT_MS)
  await rejected
  expect(shell.capturePhonePreview).toHaveBeenCalledOnce()
})

it('ends a stuck view as soon as the turn is cancelled', async () => {
  vi.stubGlobal('window', {})
  const controller = new AbortController()
  const rejected = expect(captureView(request, controller.signal)).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(10)
  controller.abort(new Error('Turn cancelled'))
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})
