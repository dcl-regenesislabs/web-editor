import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { IconButton } from '../../ds'
import { setStoredFlag, storedFlag, usePersistentFlag, usePersistentNum } from '../../core/persist'
import { dragCapture } from '../../core/drag'
import { IconExpand } from '../../icons'
import { registerCss } from '../../ds/styles/registry'
import { cmd } from '../../engine/cmd'
import { engineFrames, type EngineFrames } from '../../engine/engine-frames'
import { ViewportQualitySection } from './ViewportQualitySection'
import { useUnusedFiles } from '../../unused-files'
import { sceneBudget, sceneModels, type ModelRow } from '../../scene-budget'
import { uiFocusEntity, uiSelectEntity } from '../../actions/selection'
import { useSceneFindings } from './scene-checks'
import css from './scene-insights.css?inline'

registerCss('features/editor/scene-insights', 'features', css)

const REFRESH_MS = 2000
// a model drawing more than this share of the scene's triangle limit is worth a look
const HEAVY_SHARE = 0.25

// open across reloads, shared by the toolbar button and the dock
let open = storedFlag('insights-open', false)
const listeners = new Set<() => void>()
export function toggleInsights(): void {
  open = !open
  setStoredFlag('insights-open', open)
  for (const listener of listeners) listener()
}
export function useInsightsOpen(): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener) }, () => open)
}

type Budget = Awaited<ReturnType<typeof sceneBudget>>
type Stats = { tick: number; entities: number; status: string; at: number }

function useFps(): number | null {
  const [fps, setFps] = useState<number | null>(null)
  useEffect(() => {
    let frames = 0
    let start = performance.now()
    let id = requestAnimationFrame(function count(now) {
      frames++
      if (now - start >= 1000) {
        setFps(Math.round((frames * 1000) / (now - start)))
        frames = 0
        start = now
      }
      id = requestAnimationFrame(count)
    })
    return () => cancelAnimationFrame(id)
  }, [])
  return fps
}

// the engine's own frame rate; the page's when this engine reports none
function useFrames(): { engine: EngineFrames | null; page: number | null } {
  const page = useFps()
  const [engine, setEngine] = useState<EngineFrames | null>(() => engineFrames())
  useEffect(() => {
    const timer = setInterval(() => setEngine(engineFrames()), 1000)
    return () => clearInterval(timer)
  }, [])
  return { engine, page }
}

function parseStats(text: string): Stats | null {
  const field = (name: string): string | undefined => new RegExp(`^${name}: (.*)$`, 'm').exec(text)?.[1]
  const tick = Number(field('tick'))
  const entities = Number(field('entities'))
  return Number.isFinite(tick) && Number.isFinite(entities) ? { tick, entities, status: field('status') ?? '', at: performance.now() } : null
}

// the limits are soft: amber from 80%, never red
const tone = (used: number, limit: number): string => (limit > 0 && used / limit >= 0.8 ? 'near' : 'ok')

const compact = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString())

function Meter(props: { label: string; used: number; limit: number; unit?: string; wide?: boolean; hard?: boolean }): JSX.Element {
  const share = props.limit > 0 ? Math.min(1, props.used / props.limit) : 0
  const label = `${props.wide === true ? props.used.toLocaleString() : compact(props.used)} / ${props.wide === true ? props.limit.toLocaleString() : compact(props.limit)}${props.unit ?? ''}`
  return (
    <div className={`eui-insights-meter ${tone(props.used, props.limit)}${props.wide === true ? ' wide' : ''}`} data-tip={`${props.label}: ${props.used.toLocaleString()} of ${props.limit.toLocaleString()}${props.unit ?? ''}${props.hard === true ? '; Genesis City refuses a deployment above it, a World takes up to 10,000' : ' (soft limit)'}`}>
      <span className="name">{props.label}</span>
      <span className="track"><span className="fill" style={{ width: `${share * 100}%` }} /></span>
      <span className="value">{label}</span>
    </div>
  )
}

const severity = (fps: number): string => (fps >= 40 ? 'good' : fps >= 25 ? 'normal' : 'bad')

export function SceneInsightsDock(): JSX.Element | null {
  const isOpen = useInsightsOpen()
  return isOpen ? <Dock /> : null
}

function Dock(): JSX.Element {
  const [expanded, setExpanded] = usePersistentFlag('insights-expanded', false)
  // docked at the bottom until dragged; double-click the grip to dock it again
  const [moved, setMoved] = usePersistentFlag('insights-moved', false)
  const [x, setX] = usePersistentNum('insights-x', 16)
  const [y, setY] = usePersistentNum('insights-y', 16)
  const dockRef = useRef<HTMLDivElement>(null)
  const frames = useFrames()
  const fps = frames.engine?.fps ?? frames.page
  const fromEngine = frames.engine !== null
  const findings = useSceneFindings()
  const [budget, setBudget] = useState<Budget | null>(null)
  const [models, setModels] = useState<ModelRow[] | null>(null)
  const [stats, setStats] = useState<{ now: Stats; ticksPerSecond: number | null } | null>(null)
  // collapsed too: the warning count shows there
  const files = useUnusedFiles()
  const unused = files.unused ?? []
  const older = files.older ?? []

  useEffect(() => {
    let alive = true
    let last: Stats | null = null
    // each part on its own, and one refresh at a time: an engine that stops answering must not hold up the rest
    let busy = false
    const refresh = async (): Promise<void> => {
      if (busy) return
      busy = true
      void cmd.sceneStats().then((text) => {
        const now = parseStats(text)
        if (!alive || now === null) return
        const ticksPerSecond = last !== null && now.at > last.at ? Math.round(((now.tick - last.tick) * 1000) / (now.at - last.at)) : null
        setStats({ now, ticksPerSecond })
        last = now
      }, () => {})
      const budget = sceneBudget().then((b) => { if (alive) setBudget(b) })
      const rows = sceneModels().then((m) => { if (alive) setModels(m) })
      await Promise.allSettled([budget, rows])
      busy = false
    }
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const select = (id: string): void => {
    uiSelectEntity(id, false, false)
    uiFocusEntity(id)
  }
  const triangleLimit = budget?.limits.triangles ?? 0
  const heavy = (models ?? []).filter((m) => triangleLimit > 0 && (m.triangles * m.entities.length) / triangleLimit > HEAVY_SHARE)
  const warnings = [
    ...(budget?.over ?? []).map((key) => key === 'files'
      ? `Over the ${budget?.parcels}-parcel limit of ${budget?.limits.files} files: Genesis City would refuse it, though a World takes up to 10,000. Delete unused files or add parcels.`
      : `Over the ${budget?.parcels}-parcel soft limit for ${key}: explorers warn about it, and slower devices may struggle.`),
    ...heavy.map((m) => `${m.src} draws ${Math.round(((m.triangles * m.entities.length) / triangleLimit) * 100)}% of the scene's triangle limit.`),
    ...(models ?? []).flatMap((m) => m.warnings.map((w) => `${m.src}: ${w}`)),
    ...unused.map((f) => `${f} is not used by any entity or script.`),
    ...(older.length > 0 ? [`${older.length} older build${older.length === 1 ? '' : 's'} of models in the scene ${older.length === 1 ? 'is' : 'are'} kept for undo: delete them from Assets.`] : []),
    ...findings.map((f) => `${f.title}: ${f.detail}`)
  ]

  const placement = moved ? { left: x, top: y, bottom: 'auto', transform: 'none' } : undefined
  const clamp = (nx: number, ny: number, rect: DOMRect): [number, number] => [
    Math.max(8, Math.min(window.innerWidth - rect.width - 8, nx)),
    Math.max(8, Math.min(window.innerHeight - rect.height - 8, ny))
  ]
  // a position stored on a bigger window, or a window made smaller, must not strand the dock off-screen
  useEffect(() => {
    if (!moved) return
    const fix = (): void => {
      const dock = dockRef.current
      if (dock === null) return
      const [nx, ny] = clamp(x, y, dock.getBoundingClientRect())
      if (nx !== x) setX(nx)
      if (ny !== y) setY(ny)
    }
    fix()
    window.addEventListener('resize', fix)
    return () => window.removeEventListener('resize', fix)
  }, [moved, x, y, expanded])
  const startDrag = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    const dock = dockRef.current
    if (dock === null) return
    const rect = dock.getBoundingClientRect()
    const offX = e.clientX - rect.left
    const offY = e.clientY - rect.top
    let dragging = false
    dragCapture(e, (ev) => {
      if (!dragging) {
        dragging = true
        setMoved(true)
      }
      const [nx, ny] = clamp(ev.clientX - offX, ev.clientY - offY, rect)
      setX(nx)
      setY(ny)
    })
  }

  return (
    <div ref={dockRef} className={`eui-insights-dock${expanded ? ' expanded' : ''}${moved ? ' moved' : ''}`} style={placement} role="region" aria-label="Scene insights">
      {expanded && (
        <div className="eui-insights">
          <section>
            <h3>Performance</h3>
            <div className="eui-insights-stats">
              <div data-tip={fromEngine ? 'Frames the engine rendered over the last 2 s' : 'This engine reports no frames: the editor page’s own rate'}>
                <b className={fps === null ? '' : severity(fps)}>{fps ?? '…'}</b><span>{fromEngine ? 'engine fps' : 'page fps'}</span>
              </div>
              {frames.engine !== null && (
                <div data-tip="Average time per frame, and the slowest 5% of frames: spikes show as a gap between them">
                  <b className={frames.engine.p95Ms !== null && frames.engine.p95Ms > 33 ? 'bad' : ''}>{frames.engine.frameMs ?? '…'}<small> / {frames.engine.p95Ms ?? '…'} ms</small></b><span>frame time · slowest 5%</span>
                </div>
              )}
              <div data-tip={budget === null ? undefined : `Counts ${budget.megabytesOf}`}>
                <b>{budget?.used.megabytes ?? '…'}<small> MB</small></b><span>deploy size</span>
              </div>
              <div><b>{stats?.ticksPerSecond ?? '…'}</b><span>scene ticks / s{stats !== null && !/running/.test(stats.now.status) ? ' · paused' : ''}</span></div>
              <div><b>{stats?.now.entities ?? '…'}</b><span>live entities</span></div>
            </div>
          </section>
          <ViewportQualitySection />
          <section>
            <h3>Limits{budget !== null ? ` · ${budget.parcels} parcel${budget.parcels === 1 ? '' : 's'}` : ''}</h3>
            {budget === null ? <p>Counting…</p> : (
              <div className="eui-insights-limits">
                <Meter wide label="Triangles" used={budget.used.triangles} limit={budget.limits.triangles} />
                <Meter wide label="Entities" used={budget.used.entities} limit={budget.limits.entities} />
                <Meter wide label="Bodies" used={budget.used.bodies} limit={budget.limits.bodies} />
                <Meter wide label="Materials" used={budget.used.materials} limit={budget.limits.materials} />
                <Meter wide label="Textures" used={budget.used.textures} limit={budget.limits.textures} />
                <Meter wide hard label="Files" used={budget.used.files} limit={budget.limits.files} />
              </div>
            )}
          </section>
          <section>
            <h3>Models</h3>
            {models === null ? <p>Reading models…</p> : models.length === 0 ? <p>No models in the scene.</p> : (
              <table className="eui-insights-models">
                <thead>
                  <tr><th>Model</th><th>Copies</th><th>Tris</th><th>Total</th><th>KB</th><th>Textures</th><th>Animations</th></tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.src} className={heavy.includes(m) ? 'heavy' : ''} onClick={() => select(m.entities[0].id)} data-tip={`Select ${m.entities.map((e) => e.name).join(', ')}`}>
                      <td>{m.src.replace(/^models\//, '')}</td>
                      <td>{m.entities.length}</td>
                      <td>{m.triangles.toLocaleString()}</td>
                      <td>{(m.triangles * m.entities.length).toLocaleString()}</td>
                      <td>{m.kb.toLocaleString()}</td>
                      <td>{m.textures}{m.shared > 0 ? ` + ${m.shared} shared` : ''}</td>
                      <td>{m.clips.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section>
            <h3>Warnings</h3>
            {warnings.length === 0 ? <p>Nothing to fix.</p> : <ul className="eui-insights-warnings">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          </section>
        </div>
      )}
      <div className="eui-insights-strip">
        <span className="eui-insights-grip" data-tip="Drag to move · double-click to dock at the bottom" onPointerDown={startDrag} onDoubleClick={() => setMoved(false)} />
        <span className={`eui-insights-fps ${fps === null ? '' : severity(fps)}`} data-tip={fromEngine ? `Engine frame rate${frames.engine?.frameMs != null ? ` · ${frames.engine.frameMs} ms a frame, slowest 5% ${frames.engine.p95Ms} ms` : ''}` : 'The editor page’s frame rate: this engine reports none'}>
          <b>{fps ?? '…'}</b> fps{fromEngine && frames.engine?.frameMs != null ? <small> {frames.engine.frameMs} ms</small> : null}
        </span>
        {budget !== null && (
          <>
            <Meter label="Tris" used={budget.used.triangles} limit={budget.limits.triangles} />
            <Meter label="Textures" used={budget.used.textures} limit={budget.limits.textures} />
            <span className="eui-insights-size" data-tip={`Deploy size: ${budget.megabytesOf}`}>Deploy <b>{budget.used.megabytes} MB</b></span>
          </>
        )}
        <button type="button" className={`eui-insights-warn${warnings.length > 0 ? ' some' : ''}`} onClick={() => setExpanded(true)} data-tip={warnings.length > 0 ? 'Show the warnings' : 'No warnings'}>
          ⚠ {warnings.length}
        </button>
        <IconButton tip={expanded ? 'Collapse' : 'Expand: models, limits, warnings'} aria-label={expanded ? 'Collapse scene insights' : 'Expand scene insights'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <IconExpand />
        </IconButton>
        <IconButton tip="Close scene insights" aria-label="Close scene insights" onClick={toggleInsights}>✕</IconButton>
      </div>
    </div>
  )
}
