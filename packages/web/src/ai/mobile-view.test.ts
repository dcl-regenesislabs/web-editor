import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EditorShell, PhonePreviewState } from '@dcl-editor/contract'
import { captureMobileView } from './mobile-view'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function setup(mode: PhonePreviewState['mode'] = 'closed', ready = false) {
  let state: PhonePreviewState = { mode, ready, url: mode === 'closed' ? null : 'http://preview.test/' }
  const listeners = new Set<() => void>()
  const update = (next: Partial<PhonePreviewState>): void => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  const shell = {
    phonePreviewState: () => state,
    phonePreview: vi.fn(async () => { update({ mode: 'embedded', url: 'http://preview.test/' }); return { ok: true } as const }),
    onPhonePreviewState: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    capturePhonePreview: vi.fn(async () => ({ mimeType: 'image/jpeg' as const, image: 'JPEG', width: 1024, height: 461 }))
  } satisfies Partial<EditorShell>
  vi.stubGlobal('window', { editorShell: shell })
  return { shell, update, listeners }
}

it('opens a closed preview on request, waits for readiness and captures its real image', async () => {
  const { shell, update, listeners } = setup()
  const signal = new AbortController().signal
  const picture = captureMobileView(true, signal)
  await vi.advanceTimersByTimeAsync(1000)
  expect(shell.phonePreview).toHaveBeenCalledWith('embedded')
  expect(shell.capturePhonePreview).not.toHaveBeenCalled()
  update({ ready: true })
  expect(await picture).toMatchObject({ image: 'JPEG' })
  expect(shell.capturePhonePreview).toHaveBeenCalledWith(signal)
  expect(listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('leaves a closed preview alone during automatic validation', async () => {
  const { shell, listeners } = setup()
  await expect(captureMobileView(false, new AbortController().signal)).rejects.toThrow('Open Preview')
  expect(shell.phonePreview).not.toHaveBeenCalled()
  expect(shell.capturePhonePreview).not.toHaveBeenCalled()
  expect(listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('uses an existing preview for mobile pictures without restoring it first', async () => {
  const { shell } = setup('minimized', true)
  expect(await captureMobileView(true, new AbortController().signal)).toMatchObject({ image: 'JPEG' })
  expect(shell.phonePreview).not.toHaveBeenCalled()
})

it.each(['abort', 'timeout', 'close'] as const)('cleans up a waiting capture on %s', async (failure) => {
  const { shell, update, listeners } = setup('embedded')
  const controller = new AbortController()
  const rejected = expect(captureMobileView(false, controller.signal)).rejects.toThrow()
  if (failure === 'abort') controller.abort()
  else if (failure === 'timeout') await vi.advanceTimersByTimeAsync(60_000)
  else update({ mode: 'closed', url: null })
  await rejected
  expect(shell.capturePhonePreview).not.toHaveBeenCalled()
  expect(listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not launch a preview for an already cancelled request', async () => {
  const { shell } = setup()
  const controller = new AbortController()
  controller.abort()
  await expect(captureMobileView(true, controller.signal)).rejects.toThrow()
  expect(shell.phonePreview).not.toHaveBeenCalled()
})
