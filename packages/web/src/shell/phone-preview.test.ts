import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPhonePreview, mobilePreviewEntry, previewEnvironment } from './phone-preview'

const { channel } = vi.hoisted(() => ({ channel: {
  receive: (_message: Record<string, unknown>): void => {},
  send: vi.fn(), reset: vi.fn(), dispose: vi.fn()
} }))
vi.mock('./phone-preview-transport', () => ({ createPreviewTransport: (_entry: string, _session: string, receive: (message: Record<string, unknown>) => void) => {
  channel.receive = receive
  return channel
} }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
  vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' }, open: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function setup() {
  const preview = createPhonePreview('http://127.0.0.1:8788/mobile-preview/index.html', async () => 'realm-id', async () => 'machine')
  const open = async (mode: 'embedded' | 'minimized' | 'tab' = 'embedded') => {
    const opening = preview.open('http://localhost:5173/preview/test/', '0,0', mode)
    await vi.advanceTimersByTimeAsync(100)
    return opening
  }
  const identity = () => {
    const url = new URL(preview.state().url ?? '')
    return { session: url.searchParams.get('previewSession'), instance: url.searchParams.get('previewInstance') }
  }
  return { preview, channel, open, identity }
}

describe('mobile preview lifecycle', () => {
  it('embeds by default and reuses the active instance', async () => {
    const { preview, open } = setup()
    await expect(open()).resolves.toEqual({ ok: true })
    const url = preview.state().url
    expect(preview.state()).toMatchObject({ mode: 'embedded', ready: false })
    expect(preview.status()).toEqual({ mode: 'embedded', ready: false })
    expect(new URL(url ?? '').searchParams.get('args')).toContain('--local-editor-preview')
    await open()
    expect(preview.state().url).toBe(url)
    expect(window.open).not.toHaveBeenCalled()
    preview.dispose()
  })

  it('keeps the running preview when the new tab is blocked', async () => {
    const { preview, open } = setup()
    await open()
    const before = preview.state()
    vi.mocked(window.open).mockReturnValue(null)
    expect(await open('tab')).toEqual({ ok: false, reason: 'unavailable' })
    expect(preview.state()).toBe(before)
    preview.dispose()
  })

  it('pauses and restores the same instance, including a minimize during startup', async () => {
    const { preview, channel, open, identity } = setup()
    await open()
    const url = preview.state().url
    const first = identity()
    await open('minimized')
    expect(preview.status()).toEqual({ mode: 'minimized', ready: false })
    expect(channel.send).toHaveBeenLastCalledWith({ type: 'visibility', ...first, visible: false })
    channel.receive({ type: 'ready', ...first })
    expect(channel.send).toHaveBeenLastCalledWith({ type: 'visibility', ...first, visible: false })
    await open()
    expect(preview.state()).toEqual({ mode: 'embedded', url, ready: true })
    expect(channel.send).toHaveBeenLastCalledWith({ type: 'visibility', ...first, visible: true })
    expect(channel.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stop' }))
    expect(fetch).toHaveBeenCalledOnce()
    expect(window.open).not.toHaveBeenCalled()
    preview.dispose()
  })

  it('captures a minimized preview without restarting it and pauses after all pictures finish', async () => {
    const { preview, channel, open, identity } = setup()
    await open()
    channel.receive({ type: 'ready', ...identity() })
    await open('minimized')
    const before = preview.state()
    const first = preview.capture(new AbortController().signal)
    const request: unknown = channel.send.mock.lastCall?.[0]
    expect(preview.state()).toEqual({ ...before, mode: 'embedded' })
    const second = preview.capture(new AbortController().signal)
    const next: unknown = channel.send.mock.lastCall?.[0]
    channel.receive({ ...request as object, image: 'JPEG', width: 1024, height: 461 })
    expect(await first).toMatchObject({ image: 'JPEG' })
    expect(preview.state().mode).toBe('embedded')
    channel.receive({ ...next as object, image: 'JPEG', width: 1024, height: 461 })
    await second
    expect(preview.state()).toEqual(before)
    expect(channel.send).toHaveBeenLastCalledWith({ type: 'visibility', ...identity(), visible: false })
    expect(channel.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stop' }))
    expect(fetch).toHaveBeenCalledOnce()
    preview.dispose()
  })

  it.each(['abort', 'timeout', 'error'] as const)('pauses again after a minimized capture fails: %s', async (failure) => {
    const { preview, channel, open, identity } = setup()
    await open()
    channel.receive({ type: 'ready', ...identity() })
    await open('minimized')
    const controller = new AbortController()
    const pending = preview.capture(controller.signal)
    expect(preview.state().mode).toBe('embedded')
    const rejected = expect(pending).rejects.toThrow()
    if (failure === 'abort') controller.abort()
    else if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_000)
    else {
      const request: unknown = channel.send.mock.lastCall?.[0]
      channel.receive({ ...request as object, error: 'No frame' })
    }
    await rejected
    expect(preview.state().mode).toBe('minimized')
    expect(vi.getTimerCount()).toBe(0)
    preview.dispose()
  })

  it('keeps a preview open if the creator restores it during a temporary capture', async () => {
    const { preview, channel, open, identity } = setup()
    await open()
    channel.receive({ type: 'ready', ...identity() })
    await open('minimized')
    const pending = preview.capture(new AbortController().signal)
    expect(preview.state().mode).toBe('embedded')
    const request: unknown = channel.send.mock.lastCall?.[0]
    await open()
    channel.receive({ ...request as object, image: 'JPEG', width: 1024, height: 461 })
    await pending
    expect(preview.state().mode).toBe('embedded')
    preview.dispose()
  })

  it('does not launch or resume an unavailable preview for a picture', async () => {
    const { preview, open } = setup()
    await expect(preview.capture(new AbortController().signal)).rejects.toThrow('Open')
    expect(fetch).not.toHaveBeenCalled()
    await open()
    await open('minimized')
    await expect(preview.capture(new AbortController().signal)).rejects.toThrow('wait for it to load')
    expect(preview.state().mode).toBe('minimized')
    preview.dispose()
  })

  it('cancels an in-flight capture when minimized and still forwards scene builds', async () => {
    const { preview, channel, open, identity } = setup()
    await open()
    channel.receive({ type: 'ready', ...identity() })
    const pending = expect(preview.capture(new AbortController().signal)).rejects.toThrow('Restore')
    await open('minimized')
    await pending
    expect(vi.getTimerCount()).toBe(0)
    await preview.built('test')
    expect(channel.send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'scene-updated', ...identity(), realm: expect.stringContaining('http://127.0.0.1:8788/mobile-preview/realm/')
    }))
    preview.close()
    expect(preview.state().mode).toBe('closed')
    preview.dispose()
  })

  it('stops the old instance when moved and ignores messages from that instance', async () => {
    const { preview, channel, open, identity } = setup()
    await open()
    const old = identity()
    const frame = { src: '', title: '', allow: '', style: { cssText: '' } }
    const tab = { document: { title: '', body: { style: { cssText: '' }, replaceChildren: vi.fn() }, createElement: vi.fn(() => frame) }, close: vi.fn() }
    vi.mocked(window.open).mockReturnValue(tab as unknown as Window)
    await open('tab')
    expect(channel.send).toHaveBeenCalledWith({ type: 'stop', ...old })
    expect(frame.src).toBe(preview.state().url)
    expect(tab.document.body.replaceChildren).toHaveBeenCalledWith(frame)
    expect(new URL(frame.src).searchParams.get('previewDetached')).toBe('1')
    channel.receive({ type: 'closed', ...old })
    expect(preview.state().mode).toBe('tab')
    channel.receive({ type: 'ready', ...identity() })
    expect(preview.state().ready).toBe(true)
    expect(preview.status()).toEqual({ mode: 'tab', ready: true })
    preview.dispose()
    expect(tab.close).toHaveBeenCalledOnce()
    expect(channel.dispose).toHaveBeenCalledOnce()
  })

  it('cancels a pending launch when the project closes', async () => {
    const { preview } = setup()
    const opening = preview.open('http://localhost:5173/preview/test', '0,0')
    preview.close()
    await vi.runAllTimersAsync()
    expect(await opening).toEqual({ ok: false, reason: 'unavailable' })
    expect(preview.state().mode).toBe('closed')
    preview.dispose()
  })

  it('cancels a pending popout when the user returns to the embedded preview', async () => {
    const { preview, open } = setup()
    await open()
    const before = preview.state()
    const tab = { close: vi.fn() }
    vi.mocked(window.open).mockReturnValue(tab as unknown as Window)
    let finish: (response: Response) => void = () => {}
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = preview.open('http://localhost:5173/preview/test', '0,0', 'tab')
    await open()
    finish(new Response())
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' })
    expect(preview.state()).toBe(before)
    expect(tab.close).toHaveBeenCalledOnce()
    preview.dispose()
  })

  it('keeps the embedded preview if the reserved tab closes during launch', async () => {
    const { preview, open } = setup()
    await open()
    const before = preview.state()
    const tab = { closed: true, close: vi.fn() }
    vi.mocked(window.open).mockReturnValue(tab as unknown as Window)
    expect(await open('tab')).toEqual({ ok: false, reason: 'unavailable' })
    expect(preview.state()).toBe(before)
    preview.dispose()
  })

  it('routes pictures only from the current preview and rejects captures on close', async () => {
    const { preview, channel, open, identity } = setup()
    await open()
    channel.receive({ type: 'ready', ...identity() })
    const picture = preview.capture(new AbortController().signal)
    const request: unknown = channel.send.mock.lastCall?.[0]
    expect(request).toMatchObject({ type: 'capture' })
    channel.receive({ ...request as object, session: 'another-editor', image: 'WRONG', width: 2, height: 2 })
    channel.receive({ ...request as object, image: 'JPEG', width: 1024, height: 461 })
    expect(await picture).toMatchObject({ image: 'JPEG', width: 1024 })
    const pending = preview.capture(new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow('closed')
    preview.close()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    preview.dispose()
  })
})

it('resolves runtime hosting entirely through the editor', () => {
  expect(mobilePreviewEntry('http://localhost:5173/', null)).toBe('http://127.0.0.1:8788/mobile-preview/index.html')
  expect(mobilePreviewEntry('http://localhost:5273/', null, '?editor&editor-mobile=http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888/mobile-preview/index.html')
  expect(mobilePreviewEntry('http://localhost:5273/', null, '?editor-mobile=https://evil.example')).toBe('http://127.0.0.1:8788/mobile-preview/index.html')
  expect(mobilePreviewEntry('https://play.example/', 'https://editor.example/api/')).toBe('https://editor.example/api/mobile-preview/index.html')
  expect(mobilePreviewEntry('https://play.example/', null)).toBeNull()
})

it('starts the runtime on the editor host\'s Decentraland environment', async () => {
  expect(previewEnvironment('https://worlds-content-server.decentraland.zone/')).toBe('zone')
  expect(previewEnvironment('https://worlds-content-server.decentraland.org/')).toBeNull()
  expect(previewEnvironment('http://127.0.0.1:3000')).toBeNull()
  expect(previewEnvironment(null)).toBeNull()
  const preview = createPhonePreview('http://127.0.0.1:8788/mobile-preview/index.html', async () => 'realm-id', async () => 'machine', 'zone')
  const opening = preview.open('http://localhost:5173/preview/test/', '0,0')
  await vi.advanceTimersByTimeAsync(100)
  await opening
  expect(new URL(preview.state().url ?? '').searchParams.get('args')).toMatch(/ --dclenv zone$/)
  preview.dispose()
})
