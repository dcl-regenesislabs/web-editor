import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { state, cmd, pauseScene, reloadSnapshot } = vi.hoisted(() => ({
  state: { scene: { hash: 'b64-scene' } as { hash: string } | null, frozen: true },
  cmd: { reload: vi.fn(async () => {}), setScene: vi.fn(async () => {}), sceneLogs: vi.fn(async () => '') },
  pauseScene: vi.fn(async () => true),
  reloadSnapshot: vi.fn(async () => {})
}))
vi.mock('@scene/state', () => ({ state }))
vi.mock('../engine/cmd', () => ({ cmd }))
vi.mock('../engine/hosted', () => ({ hostV1: () => null }))
vi.mock('@scene/inspector', () => ({ pauseScene, reloadSnapshot, syncFrozenState: async () => {} }))
vi.mock('../features/editor/log-roles', () => ({ errorLines: () => [], isServerError: () => false }))
vi.mock('../features/editor/scene-health', () => ({ flushServerRestart: () => {}, noteSceneUpToDate: () => {}, sceneNeedsReload: () => true }))
vi.mock('../core/autosave', () => ({ flushPendingSave: async () => ({ pending: false, ok: true }) }))
vi.mock('../log', () => ({ log: { warn: () => {}, debug: () => {}, error: () => {} } }))

import { runFreshBuild } from './verify-build'

// the engine answers /set_scene with this until the reloaded instance has spawned
const NOT_YET = "no scene matching 'b64-scene'"

describe('running a fresh build', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    state.frozen = true
    cmd.reload.mockClear()
    cmd.setScene.mockReset()
    pauseScene.mockReset()
    pauseScene.mockResolvedValue(true)
    reloadSnapshot.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for a scene that takes seconds to spawn, then pins and pauses it', async () => {
    const spawnsAt = Date.now() + 5_000
    cmd.setScene.mockImplementation(async () => {
      if (Date.now() < spawnsAt) throw NOT_YET
    })
    const run = runFreshBuild()
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(run).resolves.toMatchObject({ reloaded: true })
    expect(pauseScene).toHaveBeenCalled()
    expect(reloadSnapshot).toHaveBeenCalled()
  })

  it('says why when the scene never comes back', async () => {
    cmd.setScene.mockRejectedValue(NOT_YET)
    const run = runFreshBuild()
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await run
    expect(result.reloaded).toBe(false)
    expect(result.reason).toContain('did not come back')
    expect(result.reason).toContain(NOT_YET)
  })

  it('says the build was not loaded while the scene is playing', async () => {
    state.frozen = false
    const result = await runFreshBuild()
    expect(result).toMatchObject({ reloaded: false, reason: expect.stringContaining('Stop the playtest') })
    expect(cmd.reload).not.toHaveBeenCalled()
  })
})
