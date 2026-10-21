import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowUpRight, Maximize2, Minus, X } from 'lucide-react'
import type { PhonePreviewState } from '@dcl-editor/contract'
import { Spinner } from '../../ds'
import { registerCss } from '../../ds/styles/registry'
import { getHost } from '../../engine/hosted'
import css from './phone-preview.css?inline'

registerCss('features/phone-preview', 'features', css)

const CLOSED: PhonePreviewState = { mode: 'closed', url: null, ready: false }
const snapshot = (): PhonePreviewState => window.editorShell?.phonePreviewState?.() ?? CLOSED
const subscribe = (listener: () => void): (() => void) => window.editorShell?.onPhonePreviewState?.(listener) ?? (() => {})

export function PhonePreviewPane({ left, right, panelControls }: { left: number; right: number; panelControls?: ReactNode }): JSX.Element | null {
  const preview = useSyncExternalStore(subscribe, snapshot)
  const [error, setError] = useState<string | null>(null)
  const screen = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const embedded = preview.mode === 'embedded' || preview.mode === 'minimized'
  useEffect(() => {
    const host = getHost()
    host?.setViewportActive?.(preview.mode !== 'embedded')
    return () => host?.setViewportActive?.(true)
  }, [preview.mode])
  useEffect(() => {
    if (screen.current === null) return
    const element = screen.current
    const resize = (): void => { if (element.clientWidth > 0) setScale(element.clientWidth / 1600) }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [embedded])
  if (preview.mode === 'closed') return null
  const move = (mode: 'embedded' | 'minimized' | 'tab'): void => {
    setError(null)
    void window.editorShell?.phonePreview?.(mode).then((result) => {
      if (result.ok) return
      if (result.reason === 'no-scene') setError('The scene is still starting. Try again in a moment.')
      else if (mode === 'tab') setError('The preview could not open in a tab. Allow pop-ups for this page and try again.')
      else setError('The mobile preview is not available right now.')
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }
  const expandLabel = preview.mode === 'minimized' ? 'Restore preview' : preview.mode === 'tab' ? 'Move preview here' : 'Open preview in tab'
  return (
    <section className="eui-phone-preview" data-mode={preview.mode} aria-label="Mobile preview" style={{ left, right }}>
      <header className="eui-phone-preview-bar">
        <div className="eui-phone-preview-controls" role="group" aria-label="Preview window controls">
          <button type="button" className="eui-phone-preview-control close" aria-label="Close preview" data-tip="Close preview" onClick={() => window.editorShell?.closePhonePreview?.()}>
            <span><X aria-hidden="true" /></span>
          </button>
          <button type="button" className="eui-phone-preview-control minimize" aria-label="Minimize preview" data-tip="Minimize and pause preview" disabled={preview.mode !== 'embedded'} onClick={() => move('minimized')}>
            <span><Minus aria-hidden="true" /></span>
          </button>
          <button type="button" className="eui-phone-preview-control expand" aria-label={expandLabel} data-tip={expandLabel} onClick={() => move(preview.mode === 'embedded' ? 'tab' : 'embedded')}>
            <span>{preview.mode === 'embedded' ? <ArrowUpRight aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</span>
          </button>
        </div>
        <div className="eui-phone-preview-title">
          <strong>Mobile preview</strong>
          <span>{preview.mode === 'minimized' ? 'Paused' : preview.mode === 'tab' ? 'Open in another tab' : '1600 × 720'}</span>
        </div>
        {!preview.ready && preview.mode !== 'minimized' && <Spinner size="xs" />}
        {panelControls !== undefined && <div className="eui-phone-preview-panels" role="group" aria-label="Editor panels">{panelControls}</div>}
      </header>
      {error !== null && <p className="eui-phone-preview-error" role="alert">{error}</p>}
      {embedded && preview.url !== null && (
        <div className="eui-phone-preview-stage" hidden={preview.mode === 'minimized'}>
          <div className="eui-phone-preview-screen" ref={screen}>
            <iframe title="Mobile scene preview" src={preview.url} allow="autoplay; fullscreen; gamepad; cross-origin-isolated" style={{ transform: `scale(${scale})` }} />
          </div>
        </div>
      )}
    </section>
  )
}
