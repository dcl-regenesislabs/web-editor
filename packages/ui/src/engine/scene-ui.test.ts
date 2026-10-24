import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { autoHideSceneUi, cancelAutoHideSceneUi, releaseAutoHiddenSceneUi, resetSceneUi, sceneUi } from './scene-ui'

const host = vi.hoisted(() => ({
  state: { frozen: true, snapshot: {} as Record<string, Record<string, unknown>>, saveStatus: '' },
  write: vi.fn(async (_id: string, _component: string, _json: string) => {})
}))
vi.mock('@scene/state', () => ({ state: host.state }))
vi.mock('@scene/inspector', () => ({ writeComponent: host.write }))
vi.mock('../core/history', () => ({ withHistorySuppressed: (fn: () => Promise<void>) => fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  host.state.frozen = true
  host.state.snapshot = {}
  resetSceneUi()
})
afterEach(() => vi.useRealTimers())

it('does not let the previous scene hide the next scene UI after a reset', async () => {
  autoHideSceneUi()
  resetSceneUi()
  host.state.snapshot = { '512': { UiTransform: { parent: 0, display: 0 } } }
  await vi.advanceTimersByTimeAsync(1000)
  expect(sceneUi.hidden).toBe(false)
  expect(host.write).not.toHaveBeenCalled()
})

it('drops a pending hide when a restart begins, so it cannot land on the reloaded scene', async () => {
  host.state.snapshot = { '512': { UiTransform: { parent: 0, display: 0 } } }
  autoHideSceneUi()
  cancelAutoHideSceneUi()
  await vi.advanceTimersByTimeAsync(1000)
  expect(sceneUi.hidden).toBe(false)
  expect(host.write).not.toHaveBeenCalled()
})

it('ignores a late editing-hide request while the scene is already playing', async () => {
  host.state.frozen = false
  host.state.snapshot = { '512': { UiTransform: { parent: 0, display: 0 } } }
  autoHideSceneUi()
  await vi.advanceTimersByTimeAsync(1000)
  expect(sceneUi.hidden).toBe(false)
  expect(host.write).not.toHaveBeenCalled()
})

it('still hides UI while editing and restores the exact root on Play', async () => {
  const transform = { parent: 0, display: 0, width: 1920, height: 1080 }
  host.state.snapshot = { '512': { UiTransform: transform } }
  autoHideSceneUi()
  await vi.advanceTimersByTimeAsync(1000)
  expect(sceneUi.hidden).toBe(true)
  expect(host.write).toHaveBeenLastCalledWith('512', 'UiTransform', JSON.stringify({ ...transform, display: 1 }))
  await releaseAutoHiddenSceneUi()
  expect(sceneUi.hidden).toBe(false)
  expect(host.write).toHaveBeenLastCalledWith('512', 'UiTransform', JSON.stringify(transform))
})
