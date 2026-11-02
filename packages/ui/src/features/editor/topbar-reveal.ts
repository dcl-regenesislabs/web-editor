import { useEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { getEngineWindow, onEngineWindow } from '../../engine/console'

// The hidden bar lets clicks through to the canvas, so it can't use :hover to reveal across its
// whole band; track the pointer instead (the engine may run in an iframe). The reveal commits
// inside the move that earns it: a press right after that move is hit-tested before React's next
// render, and while the bar is still click-through the press lands on the canvas instead.
export function usePointerNearBar(barRef: RefObject<HTMLElement>): boolean {
  const [near, setNear] = useState(false)
  const current = useRef(false)
  useEffect(() => {
    const track = (win: Window): (() => void) => {
      const onMove = (e: PointerEvent): void => {
        const bar = barRef.current
        if (bar === null) return
        const top = win === window ? 0 : (win.frameElement?.getBoundingClientRect().top ?? 0)
        const next = e.clientY + top <= bar.offsetHeight
        if (next === current.current) return
        current.current = next
        flushSync(() => setNear(next))
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
  return near
}
