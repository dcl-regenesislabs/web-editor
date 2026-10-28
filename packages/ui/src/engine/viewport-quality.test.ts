// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { parseQuality, sessionCommands } from './viewport-quality'

describe('parseQuality', () => {
  it('defaults on a first run', () => {
    expect(parseQuality(null)).toEqual({ renderScale: '0.75', grass: 'low', fpsCap: '60' })
  })

  it('keeps stored choices', () => {
    expect(parseQuality('{"renderScale":"0.5","grass":"off","fpsCap":"30"}')).toEqual({ renderScale: '0.5', grass: 'off', fpsCap: '30' })
  })

  it('drops values that name nothing it offers, including the old grass shells', () => {
    expect(parseQuality('{"renderScale":"0.3","grass":"full","fpsCap":60,"idle":false}')).toEqual({ renderScale: '0.75', grass: 'low', fpsCap: '60' })
  })

  it('reads garbage as a first run', () => {
    expect(parseQuality('not json')).toEqual(parseQuality(null))
  })
})

describe('sessionCommands', () => {
  const q = parseQuality(null)

  it('sends every setting to a fresh engine', () => {
    expect(sessionCommands(null, q)).toEqual([['render_scale', '0.75'], ['grass', 'low'], ['fps', '60']])
  })

  it('sends only what changed', () => {
    expect(sessionCommands(q, { ...q, grass: 'off' })).toEqual([['grass', 'off']])
    expect(sessionCommands(q, q)).toEqual([])
  })
})
