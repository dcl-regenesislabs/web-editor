import { describe, expect, it } from 'vitest'
import { sizedSvg } from './icon-png'

describe('sizedSvg', () => {
  it('sizes an SVG that has a viewBox', () => {
    expect(sizedSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" color="#fff"><path/></svg>', 128))
      .toBe('<svg width="128" height="128" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" color="#fff"><path/></svg>')
  })

  it('gives one with only width and height a viewBox before sizing it', () => {
    expect(sizedSvg('<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><g/></svg>', 256))
      .toBe('<svg width="256" height="256" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g/></svg>')
  })

  it('refuses what it cannot scale', () => {
    expect(() => sizedSvg('<svg><g/></svg>', 64)).toThrow('no size')
    expect(() => sizedSvg('<png/>', 64)).toThrow('not an SVG')
  })
})
