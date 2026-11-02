import { useEffect, type RefObject } from 'react'
import { getEngineWindow, onEngineWindow } from '../../engine/console'

// Hiding again only a few pixels below the band keeps a pointer resting on its edge from flickering.
const HIDE_SLACK = 8

// The hidden bar lets clicks through to the canvas, so it can't use :hover to reveal across its
// whole band; track the pointer instead (the engine may run in an iframe). The `near` class is set
// on the element inside the move that earns it, not through a render: a press right after that
// move is hit-tested before React's next render, and while the bar is still click-through the
// press lands on the canvas instead.
export function useRevealNearPointer(barRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const track = (win: Window): (() => void) => {
      const onMove = (e: PointerEvent): void => {
        const bar = barRef.current
        if (bar === null) return
        const top = win === window ? 0 : (win.frameElement?.getBoundingClientRect().top ?? 0)
        const y = e.clientY + top
        const shown = bar.classList.contains('near')
        const next = shown ? y <= bar.offsetHeight + HIDE_SLACK : y <= bar.offsetHeight
        if (next !== shown) bar.classList.toggle('near', next)
      }
      win.addEventListener('pointermove', onMove)
      return () => win.removeEventListener('pointermove', onMove)
    }
    const offHost = track(window)
    let offEngine = getEngineWindow() === window ? () => {} : track(getEngineWindow())
    const offSwap = onEngineWindow((win) => {
      offEngine()
      offEngine = win === window ? () => {} : track(win)
    })
    return () => {
      offHost()
      offEngine()
      offSwap()
    }
  }, [barRef])
}
