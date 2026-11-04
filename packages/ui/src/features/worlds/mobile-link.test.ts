import { describe, expect, it } from 'vitest'
import { mobileJumpInUrl } from './endpoints'

describe('mobileJumpInUrl', () => {
  it('names the world in full, .dcl.eth included, and lands on its base parcel', () => {
    expect(mobileJumpInUrl('RegenesisGuests.dcl.eth', '-120,-150')).toBe(
      'https://mobile.dclexplorer.com/open?position=-120%2C-150&realm=regenesisguests.dcl.eth'
    )
  })

  it('leaves the position out when the base is unknown', () => {
    expect(mobileJumpInUrl('mine.dcl.eth', null)).toBe('https://mobile.dclexplorer.com/open?realm=mine.dcl.eth')
  })
})
