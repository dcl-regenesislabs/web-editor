import type { EditorShell, PhonePreviewCapture } from '@dcl-editor/contract'

export async function captureMobileView(openIfClosed: boolean, signal: AbortSignal): Promise<PhonePreviewCapture> {
  signal.throwIfAborted()
  const shell = window.editorShell
  if (shell?.capturePhonePreview === undefined) throw new Error('This editor does not support mobile preview captures.')
  if (shell.phonePreviewState?.().mode === 'closed' && openIfClosed) {
    const opened = await shell.phonePreview?.('embedded')
    signal.throwIfAborted()
    if (!opened?.ok) throw new Error('The mobile preview could not open. Check Preview → As a phone.')
  }
  await waitForPreview(shell, signal)
  return shell.capturePhonePreview(signal)
}

async function waitForPreview(shell: EditorShell, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = (): void => {}
    const finish = (error?: Error): void => {
      clearTimeout(timeout)
      unsubscribe()
      signal.removeEventListener('abort', abort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const check = (): void => {
      const preview = shell.phonePreviewState?.()
      if (preview === undefined || preview.mode === 'closed') finish(new Error('Open Preview → As a phone before taking a mobile picture.'))
      else if (preview.ready) finish()
    }
    const abort = (): void => finish(signal.reason instanceof Error ? signal.reason : new Error('Mobile capture cancelled.'))
    const timeout = setTimeout(() => finish(new Error('The mobile preview is still loading. Retry when it is ready.')), 60_000)
    unsubscribe = shell.onPhonePreviewState?.(check) ?? unsubscribe
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else check()
  })
}
