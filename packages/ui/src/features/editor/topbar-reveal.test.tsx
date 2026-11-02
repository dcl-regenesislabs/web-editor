import { useRef } from 'react'
import { describe, expect, it } from 'vitest'
import { mount } from '../../test/render'
import { usePointerNearBar } from './topbar-reveal'

function Bar(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const near = usePointerNearBar(ref)
  return <div ref={ref} className={`bar${near ? ' near' : ''}`} />
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
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 20 }))
      expect(bar.classList.contains('near')).toBe(true)
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 300 }))
      expect(bar.classList.contains('near')).toBe(false)
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = before
    }
    view.unmount()
  })
})
