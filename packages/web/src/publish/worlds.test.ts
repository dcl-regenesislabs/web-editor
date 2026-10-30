import { describe, expect, it } from 'vitest'
import { worldLink } from './worlds'

describe('the link to a published world', () => {
  it('names the .org servers on a .zone page, where a bare world name would resolve against .zone', () => {
    expect(worldLink('https://decentraland.zone/play/', 'https://worlds-content-server.decentraland.org', 'regenesisguests.dcl.eth'))
      .toBe('https://decentraland.zone/play/?realm=regenesisguests.dcl.eth&baseDomain=decentraland.org')
  })

  it('leaves the domain to the page when the world is on the page\'s own servers', () => {
    expect(worldLink('https://decentraland.org/play/', 'https://worlds-content-server.decentraland.org', 'boedo.dcl.eth'))
      .toBe('https://decentraland.org/play/?realm=boedo.dcl.eth')
    expect(worldLink('https://decentraland.zone/play/', 'https://worlds-content-server.decentraland.zone', 'boedo.dcl.eth'))
      .toBe('https://decentraland.zone/play/?realm=boedo.dcl.eth')
  })

  it('points at the world itself on a server that is not Decentraland\'s', () => {
    expect(worldLink('http://localhost:5173/', 'http://localhost:8799', 'boedo.dcl.eth'))
      .toBe(`http://localhost:5173/?realm=${encodeURIComponent('http://localhost:8799/world/boedo.dcl.eth')}`)
  })
})
