// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  let release = (): void => {}
  return {
    host: { setMode: vi.fn(), openCreatePage: vi.fn(), exit: vi.fn() },
    endSession: vi.fn(),
    saved: () => release(),
    flushPendingSave: vi.fn(() => new Promise<{ pending: boolean; ok: boolean }>((resolve) => {
      release = () => resolve({ pending: true, ok: true })
    }))
  }
})
vi.mock('../../engine/hosted', () => ({ getHost: () => h.host, hostedRoute: { project: 'scene' }, isHosted: () => true }))
vi.mock('../../core/autosave', () => ({ flushPendingSave: h.flushPendingSave }))
vi.mock('../../boot/boot', () => ({ endSession: h.endSession, reattachScene: async () => {} }))

import { backToProjects } from './nav'

describe('Back to scenes', () => {
  beforeEach(() => {
    window.editorShell = { closeProject: async () => {} } as unknown as typeof window.editorShell
  })
  afterEach(() => {
    delete window.editorShell
  })

  it('leaves once however often it is pressed while the last save runs', async () => {
    backToProjects()
    backToProjects()
    backToProjects()
    expect(h.flushPendingSave).toHaveBeenCalledTimes(1)
    h.saved()
    await vi.waitFor(() => expect(h.host.openCreatePage).toHaveBeenCalledTimes(1))
    expect(h.endSession).toHaveBeenCalledTimes(1)

    // back in a scene later, the button works again
    backToProjects()
    h.saved()
    await vi.waitFor(() => expect(h.host.openCreatePage).toHaveBeenCalledTimes(2))
  })
})
