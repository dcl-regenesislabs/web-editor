import { act, useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { mount } from '../../test/render'
import { useRevealNearPointer } from './topbar-reveal'

let rerender: () => void = () => {}

function Bar(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [, setTick] = useState(0)
  rerender = () => setTick((n) => n + 1)
  useRevealNearPointer(ref)
  return <div ref={ref} className="bar" />
}

const move = (clientY: number): void => {
  window.dispatchEvent(new PointerEvent('pointermove', { clientY }))
}

describe('the hidden top bar', () => {
  it('is clickable within the move that reaches it, before the next render', () => {
    const view = mount(<Bar />)
    const bar = view.find('.bar')
    if (bar === null) throw new Error('no bar')
    Object.defineProperty(bar, 'offsetHeight', { value: 48 })
    // as in the browser, outside act(): a press right after this move must already find the bar revealed
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const before = env.IS_REACT_ACT_ENVIRONMENT
    env.IS_REACT_ACT_ENVIRONMENT = false
    try {
      move(60)
      expect(bar.classList.contains('near')).toBe(false)
      move(20)
      expect(bar.classList.contains('near')).toBe(true)
      // just past the edge it stays up, so a pointer resting there doesn't flicker it
      move(54)
      expect(bar.classList.contains('near')).toBe(true)
      move(300)
      expect(bar.classList.contains('near')).toBe(false)
      move(54)
      expect(bar.classList.contains('near')).toBe(false)
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = before
    }
    move(20)
    act(() => rerender())
    expect(bar.classList.contains('near')).toBe(true)
    view.unmount()
  })
})
