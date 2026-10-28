// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { defaultQuality, parseQuality, sessionCommands } from './viewport-quality'

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

  it('starts a Retina screen near 1080p at 30 fps, and keeps what the creator chose there', () => {
    const dense = defaultQuality(2)
    expect(parseQuality(null, dense)).toEqual({ renderScale: '0.5', grass: 'low', fpsCap: '30' })
    expect(parseQuality('{"renderScale":"1"}', dense)).toEqual({ renderScale: '1', grass: 'low', fpsCap: '30' })
    expect(defaultQuality(1.5)).toEqual(parseQuality(null))
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
