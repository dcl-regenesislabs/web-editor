import { useSyncExternalStore } from 'react'
import { Segmented } from '../../ds'
import { onViewportQuality, setViewportQuality, viewportQuality, type FpsCap, type GrassDetail, type RenderScale } from '../../engine/viewport-quality'

const SCALE_OPTIONS: ReadonlyArray<{ value: RenderScale; label: string }> = [
  { value: '0.5', label: '50%' },
  { value: '0.75', label: '75%' },
  { value: '1', label: '100%' }
]
const GRASS_OPTIONS: ReadonlyArray<{ value: GrassDetail; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'mid', label: 'Mid' },
  { value: 'high', label: 'High' }
]
const FPS_OPTIONS: ReadonlyArray<{ value: FpsCap; label: string }> = [
  { value: '30', label: '30' },
  { value: '45', label: '45' },
  { value: '60', label: '60' }
]

// the editor's own viewport only: what players see is their explorer's settings
export function ViewportQualitySection(): JSX.Element {
  const quality = useSyncExternalStore(onViewportQuality, viewportQuality)
  return (
    <section>
      <h3>Viewport quality</h3>
      <div className="eui-insights-quality">
        <span data-tip="Share of the screen’s pixels the 3D view renders at. Lower runs cooler on a Retina screen and looks softer">3D resolution</span>
        <Segmented aria-label="3D resolution" value={quality.renderScale} options={SCALE_OPTIONS} onChange={(renderScale) => setViewportQuality({ renderScale })} />
        <span data-tip="Grass on empty parcels around the scene: the largest GPU cost in an empty scene">Grass</span>
        <Segmented aria-label="Grass" value={quality.grass} options={GRASS_OPTIONS} onChange={(grass) => setViewportQuality({ grass })} />
        <span data-tip="Most frames the engine draws a second; play sessions use it too">Frame rate cap</span>
        <Segmented aria-label="Frame rate cap" value={quality.fpsCap} options={FPS_OPTIONS} onChange={(fpsCap) => setViewportQuality({ fpsCap })} />
      </div>
    </section>
  )
}
