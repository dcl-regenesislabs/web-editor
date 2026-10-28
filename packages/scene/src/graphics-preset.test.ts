import { describe, it, expect } from 'vitest'
import { editorGraphicsTargets } from './graphics-preset'
import type { EngineSetting } from './bevy-api/interface'

const named = (name: string, variants: string[]): EngineSetting => ({
  name,
  value: 0,
  namedVariants: variants.map((v) => ({ name: v }))
})
const numeric = (name: string): EngineSetting => ({ name, value: 0, namedVariants: [] })

const valueOf = (targets: Array<{ name: string; value: number }>, name: string): number | undefined =>
  targets.find((t) => t.name === name)?.value

describe('editorGraphicsTargets', () => {
  const engine = [
    named('Bloom', ['Off', 'Low', 'High']),
    named('Depth of Field', ['Off', 'Low', 'High']),
    named('Anti-aliasing', ['Off', 'FXAA (Low)', 'FXAA (High)', 'MSAA 2x']),
    named('Shadow settings', ['Off', 'Low', 'High']),
    numeric('Shadow Distance')
  ]

  it('turns bloom and depth of field off over the Low column', () => {
    const targets = editorGraphicsTargets(engine)
    expect(valueOf(targets, 'Bloom')).toBe(0)
    expect(valueOf(targets, 'Depth of Field')).toBe(0)
  })

  it('keeps the rest of the Low column', () => {
    const targets = editorGraphicsTargets(engine)
    expect(valueOf(targets, 'Anti-aliasing')).toBe(1)
    expect(valueOf(targets, 'Shadow settings')).toBe(1)
    expect(valueOf(targets, 'Shadow Distance')).toBe(20)
  })

  it('sets each setting once', () => {
    const names = editorGraphicsTargets(engine).map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('skips settings or variants this engine does not have', () => {
    const targets = editorGraphicsTargets([named('Bloom', ['Low', 'High'])])
    expect(targets).toEqual([])
  })
})
