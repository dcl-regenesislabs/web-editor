import { describe, it, expect } from 'vitest'
import { decodePng, encodePng, parseSvg, rasterize, staleIcons } from './build-action-icons.mjs'

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="white">${body}</svg>`
const at = (alpha, x, y, size = 16) => alpha[y * size + x]

describe('the icon rasterizer', () => {
  it('paints white, cuts back with black, and anti-aliases the edge', () => {
    const alpha = rasterize(parseSvg(svg('<rect x="0" y="0" width="16" height="16"/><circle cx="8" cy="8" r="4" fill="black"/>')), 16)
    expect(at(alpha, 0, 0)).toBe(255)
    expect(at(alpha, 8, 8)).toBe(0)
    expect(at(alpha, 11, 10)).toBeGreaterThan(0)
    expect(at(alpha, 11, 10)).toBeLessThan(255)
  })

  it('strokes with round caps and applies a group transform', () => {
    const alpha = rasterize(parseSvg(svg('<g transform="rotate(90 8 8)"><line x1="2" y1="8" x2="14" y2="8" stroke="white" stroke-width="2"/></g>')), 16)
    expect(at(alpha, 7, 3)).toBe(255)
    expect(at(alpha, 3, 7)).toBe(0)
  })

  it('refuses what it cannot draw the way a browser would', () => {
    expect(() => parseSvg(svg('<ellipse cx="8" cy="8" rx="4" ry="2"/>'))).toThrow(/outside the icon subset/)
    expect(() => parseSvg(svg('<rect width="4" height="4" fill="red"/>'))).toThrow(/white paints, black cuts/)
  })

  it('writes a PNG whose pixels read back as written', () => {
    const alpha = rasterize(parseSvg(svg('<polygon points="0,0 16,0 0,16"/>')), 16)
    expect(decodePng(encodePng(alpha, 16))).toEqual({ size: 16, alpha })
  })
})

describe('the shipped action icons', () => {
  it('match their SVG sources, and the editor carries the same bytes', () => {
    expect(staleIcons()).toEqual([])
  })
})
