import { object, type OpenPreview, type PhonePreviewCapture, type PhonePreviewState, type PreviewCaptureSignal } from '@dcl-editor/contract'
import { previewEntityId } from '@dcl-editor/scene-compiler'
import { createPreviewTransport } from './phone-preview-transport'

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

// a local page's runtime is the dev stack's own server; `?editor-mobile=` names another stack's
export function mobilePreviewEntry(pageDir: string, service: string | null, search = ''): string | null {
  if (LOOPBACK.includes(new URL(pageDir).hostname)) {
    const asked = new URLSearchParams(search).get('editor-mobile')
    const origin = asked !== null && URL.canParse(asked) && LOOPBACK.includes(new URL(asked).hostname) ? new URL(asked).origin : 'http://127.0.0.1:8788'
    return `${origin}/mobile-preview/index.html`
  }
  return service === null ? null : new URL('mobile-preview/index.html', service.replace(/\/$/, '') + '/').href
}

// The runtime defaults to org; on zone it must also use zone's catalysts, auth and comms.
export function previewEnvironment(worldsContent: string | null): string | null {
  if (worldsContent === null) return null
  const host = new URL(worldsContent).hostname
  return host === 'decentraland.zone' || host.endsWith('.decentraland.zone') ? 'zone' : null
}

export function createPhonePreview(
  entry: string | null,
  realmIdOf: (projectId: string) => Promise<string>,
  machineId: (realmId: string) => Promise<string>,
  environment: string | null = null
) {
  const session = crypto.randomUUID()
  const channel = createPreviewTransport(entry, session, (message) => receive(message))
  const listeners = new Set<() => void>()
  const captures = new Map<string, { resolve: (value: PhonePreviewCapture) => void; reject: (error: Error) => void }>()
  let state: PhonePreviewState = { mode: 'closed', url: null, ready: false }
  let realmOpened: string | null = null
  let relayRealm = ''
  let instance = ''
  let generation = 0
  let pauseAfterCapture: number | null = null
  let disposed = false
  let activeTab: Window | null = null

  const publish = (next: PhonePreviewState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const stop = (): void => {
    if (instance !== '') channel.send({ type: 'stop', session, instance })
    channel.reset()
    activeTab?.close()
    activeTab = null
    instance = ''
    for (const capture of captures.values()) capture.reject(new Error('The mobile preview was closed.'))
    captures.clear()
    publish({ mode: 'closed', url: null, ready: false })
  }
  const close = (): void => {
    generation++
    realmOpened = null
    stop()
  }
  window.addEventListener('pagehide', close)
  const receive = (message: Record<string, unknown>): void => {
    if (!object(message) || message.session !== session || message.instance !== instance) return
    if (message.type === 'ready') {
      publish({ ...state, ready: true })
      channel.send({ type: 'visibility', session, instance, visible: state.mode !== 'minimized' })
    }
    if (message.type === 'closed') close()
    if (message.type !== 'capture' || typeof message.requestId !== 'string') return
    const pending = captures.get(message.requestId)
    if (pending === undefined) return
    if (typeof message.error === 'string') pending.reject(new Error(message.error))
    else if (typeof message.image === 'string' && message.image.length <= 4_000_000 &&
      typeof message.width === 'number' && message.width > 0 && message.width <= 1024 &&
      typeof message.height === 'number' && message.height > 0 && message.height <= 1024) {
      pending.resolve({ mimeType: 'image/jpeg', image: message.image, width: message.width, height: message.height })
    } else pending.reject(new Error('The mobile preview sent an invalid picture.'))
  }
  return {
    state: (): PhonePreviewState => state,
    status: (): Pick<PhonePreviewState, 'mode' | 'ready'> => ({ mode: state.mode, ready: state.ready }),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open: async (realmUrl: string, position: string, mode: 'embedded' | 'minimized' | 'tab' = 'embedded'): Promise<OpenPreview> => {
      if (disposed || entry === null) return { ok: false, reason: 'unavailable' }
      const realm = realmUrl.replace(/\/$/, '')
      if (state.mode === mode && realmOpened === realm) {
        generation++
        return { ok: true }
      }
      if ((mode === 'embedded' || mode === 'minimized') &&
        (state.mode === 'embedded' || state.mode === 'minimized') && realmOpened === realm) {
        generation++
        publish({ ...state, mode })
        channel.send({ type: 'visibility', session, instance, visible: mode !== 'minimized' })
        if (mode === 'minimized') {
          for (const capture of captures.values()) capture.reject(new Error('Restore the mobile preview before taking a picture.'))
        }
        return { ok: true }
      }
      if (mode === 'minimized') return { ok: false, reason: 'unavailable' }
      // Reserve the tab during the click; the availability check is asynchronous.
      const tab = mode === 'tab' ? window.open('about:blank', `dcl-phone-preview-${crypto.randomUUID()}`) : null
      if (mode === 'tab' && tab === null) return { ok: false, reason: 'unavailable' }
      const mine = ++generation
      const served = await fetch(entry, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then((response) => response.ok, () => false)
      if (!served || mine !== generation || disposed || tab?.closed) {
        tab?.close()
        return { ok: false, reason: 'unavailable' }
      }
      stop()
      // Unmount the old frame (or let its tab navigate away) before allocating another engine.
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (mine !== generation || disposed || tab?.closed) {
        tab?.close()
        return { ok: false, reason: 'unavailable' }
      }
      instance = crypto.randomUUID()
      const url = new URL(entry)
      url.searchParams.set('previewSession', session)
      url.searchParams.set('previewInstance', instance)
      url.searchParams.set('editorOrigin', window.location.origin)
      if (mode === 'tab') url.searchParams.set('previewDetached', '1')
      url.searchParams.set('maxpixels', String(1600 * 720))
      relayRealm = new URL(`realm/${session}/${instance}`, entry).href
      channel.reset(instance, realm, relayRealm)
      const link = new URL('decentraland://open')
      link.searchParams.set('preview', relayRealm)
      link.searchParams.set('position', position)
      const args = ['--local-editor-preview', '--skip-lobby', '--guest-profile', '--fake-deeplink', link.href]
      if (environment !== null) args.push('--dclenv', environment)
      url.searchParams.set('args', args.join(' '))
      realmOpened = realm
      publish({ mode, url: url.href, ready: false })
      activeTab = tab
      if (tab !== null) mountPreviewTab(tab, url.href)
      return { ok: true }
    },
    close,
    capture: async (signal: PreviewCaptureSignal): Promise<PhonePreviewCapture> => {
      signal.throwIfAborted()
      if (state.mode === 'closed' || !state.ready) throw new Error('Open the mobile preview and wait for it to load before taking a picture.')
      if (state.mode === 'minimized') {
        pauseAfterCapture = generation
        publish({ ...state, mode: 'embedded' })
        channel.send({ type: 'visibility', session, instance, visible: true })
      }
      const requestId = crypto.randomUUID()
      try {
        return await new Promise<PhonePreviewCapture>((resolve, reject) => {
          const finish = (): void => {
            clearTimeout(timeout)
            signal.removeEventListener('abort', abort)
            captures.delete(requestId)
          }
          const abort = (): void => { finish(); reject(signal.reason) }
          const timeout = setTimeout(() => { finish(); reject(new Error('The mobile preview did not answer. Bring its tab to the foreground and retry.')) }, 10_000)
          captures.set(requestId, {
            resolve: (value) => { finish(); resolve(value) },
            reject: (error) => { finish(); reject(error) }
          })
          signal.addEventListener('abort', abort, { once: true })
          channel.send({ type: 'capture', session, instance, requestId })
        })
      } finally {
        if (captures.size === 0) {
          // A creator action during capture takes precedence over restoring the previous mode.
          if (pauseAfterCapture === generation && state.mode === 'embedded') {
            publish({ ...state, mode: 'minimized' })
            channel.send({ type: 'visibility', session, instance, visible: false })
          }
          pauseAfterCapture = null
        }
      }
    },
    built: async (projectId: string): Promise<void> => {
      if (realmOpened === null) return
      const realm = realmOpened
      const realmId = await realmIdOf(projectId)
      const entityId = previewEntityId(realmId, await machineId(realmId))
      if (!disposed && realm === realmOpened) channel.send({ type: 'scene-updated', session, instance, realm: relayRealm, entityId })
    },
    dispose: (): void => {
      close()
      disposed = true
      window.removeEventListener('pagehide', close)
      channel.dispose()
      listeners.clear()
    }
  }
}

function mountPreviewTab(tab: Window, url: string): void {
  // A same-origin shell preserves the editor connection across runtime isolation policies.
  const doc = tab.document
  doc.title = 'Mobile scene preview'
  doc.body.style.cssText = 'margin:0;background:#19191c;overflow:hidden'
  const frame = doc.createElement('iframe')
  frame.title = 'Mobile scene preview'
  frame.allow = 'autoplay; fullscreen; gamepad; cross-origin-isolated'
  frame.style.cssText = 'width:100vw;height:100vh;border:0;display:block'
  frame.src = url
  doc.body.replaceChildren(frame)
}
