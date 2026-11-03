import { describe, expect, it } from 'vitest'
import { mobileJumpInUrl } from './endpoints'

describe('mobileJumpInUrl', () => {
  it('names the world without .dcl.eth and lands on its base parcel', () => {
    expect(mobileJumpInUrl('RegenesisGuests.dcl.eth', '-150,-150')).toBe('https://mobile.dclexplorer.com/?realm=regenesisguests&position=-150,-150')
  })

  it('leaves the position out when the base is unknown', () => {
    expect(mobileJumpInUrl('mine.dcl.eth', null)).toBe('https://mobile.dclexplorer.com/?realm=mine')
  })
})
