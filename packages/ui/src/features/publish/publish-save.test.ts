// Publish packs the scene from disk, so it has to wait for the autosave first (creator-hub#1512).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScenePublishResult } from '@dcl-editor/contract'
import { flushPendingSave } from '../../core/autosave'
import { cancelPublish, startSharedPublish } from './publish-flow'

vi.mock('../../core/autosave', () => ({ flushPendingSave: vi.fn() }))
vi.mock('../account/auth', () => ({ canSign: () => true, getAccount: () => null, getIdentity: () => null }))
vi.mock('../worlds/worlds-store', () => ({ refreshWorlds: () => {}, worldSceneCount: () => ({ known: false, total: 0 }) }))

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('publishing waits for the autosave', () => {
  let publishShared: ReturnType<typeof vi.fn>
  let order: string[]

  beforeEach(() => {
    vi.mocked(flushPendingSave).mockReset()
    order = []
    publishShared = vi.fn(() => {
      order.push('publish')
      return new Promise<ScenePublishResult>(() => {})
    })
    vi.stubGlobal('window', { editorShell: { publishShared } })
  })

  afterEach(() => {
    cancelPublish()
    vi.unstubAllGlobals()
  })

  it('publishes only once the pending save reached disk', async () => {
    vi.mocked(flushPendingSave).mockImplementationOnce(async () => {
      order.push('save')
      return { pending: true, ok: true }
    })
    startSharedPublish('/scene')
    await flush()
    expect(order).toEqual(['save', 'publish'])
  })

  it('shows it is working, and refuses a second press, while the save runs', async () => {
    let finish: (r: { pending: boolean; ok: boolean }) => void = () => {}
    vi.mocked(flushPendingSave).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    startSharedPublish('/scene')
    startSharedPublish('/scene')
    expect(vi.mocked(flushPendingSave)).toHaveBeenCalledTimes(1)
    finish({ pending: true, ok: true })
    await flush()
    expect(publishShared).toHaveBeenCalledTimes(1)
  })

  it('does not publish when the save failed', async () => {
    vi.mocked(flushPendingSave).mockResolvedValueOnce({ pending: true, ok: false })
    startSharedPublish('/scene')
    await flush()
    expect(publishShared).not.toHaveBeenCalled()
  })
})
