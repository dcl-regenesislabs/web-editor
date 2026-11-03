import { afterEach, describe, expect, it } from 'vitest'
import { SceneChecksCard, fixRequest } from './SceneChecksCard'
import { aiStore } from '../../panels/ai-store'
import { resetSceneChecksForTest, revealSceneChecks, setSceneFindings, type SceneFinding } from './scene-checks'
import { clearPrefabReveal, prefabStore } from '../../panels/prefab-store'
import { mount, run } from '../../test/render'
import { state } from '@scene/state'
import { unusedFiles } from '../../unused-files'
import { THUMBNAIL_FIX_ACTION } from './scene-check-thumbnail'

const blocker: SceneFinding = {
  id: 'server-pool-multi-entity',
  level: 'blocker',
  title: 'Zombie cannot be server-owned',
  detail: 'The server can only own a prefab made of one entity — Zombie has 3.',
  folder: 'custom/zombie',
  fix: { label: 'Show prefab', action: 'reveal-prefab' }
}

const warning: SceneFinding = {
  id: 'spawnable-trigger-area',
  level: 'warning',
  title: 'Clones of Zombie share one TriggerArea',
  detail: 'Only one copy can own a trigger area.',
  folder: 'custom/zombie'
}

const playBlocker: SceneFinding = {
  id: 'spawned-only-server-half',
  level: 'play-blocker',
  title: 'Player Rig runs on the Multiplayer Server, so it cannot be spawn-only',
  detail: 'The half of its script that runs on the Multiplayer Server only ever runs on a placed copy.',
  entityId: '512',
  folder: 'custom/player-rig',
  fix: { label: 'Select entity', action: 'select-entity' }
}

const spawning: SceneFinding = {
  id: 'unspawnable-prefab-ref',
  level: 'blocker',
  title: 'Zombie is not Spawnable',
  detail: 'Open Placement & spawning on Zombie and turn Spawnable on, or pick another prefab in the inspector.',
  entityId: '512',
  folder: 'custom/zombie',
  fix: { label: 'Select entity', action: 'select-entity' }
}

const noThumbnail: SceneFinding = {
  id: 'no-thumbnail',
  level: 'warning',
  title: 'No thumbnail yet',
  detail: 'The map shows a 16:9 picture of the scene.',
  fix: { label: 'Make one with the assistant', action: THUMBNAIL_FIX_ACTION }
}

afterEach(() => {
  resetSceneChecksForTest()
  run(() => {
    clearPrefabReveal()
    state.frozen = false
    unusedFiles.unused = null
    unusedFiles.older = null
  })
})

describe('SceneChecksCard render', () => {
  it('renders nothing when the project is clean', () => {
    const view = mount(<SceneChecksCard />)
    expect(view.container.innerHTML).toBe('')
    view.unmount()
  })

  it('leads with the blocking count and marks the card blocking', () => {
    setSceneFindings([blocker, warning])
    const view = mount(<SceneChecksCard />)
    expect(view.find('.eui-checks')?.className).toContain('blocking')
    expect(view.text()).toContain('1 problem blocking Play · 1 warning')
    expect(view.byText('Play anyway', 'button')).not.toBeNull()
    view.unmount()
  })

  it('offers no Play-anyway escape when nothing blocks', () => {
    setSceneFindings([warning])
    const view = mount(<SceneChecksCard />)
    expect(view.find('.eui-checks')?.className).not.toContain('blocking')
    expect(view.text()).toContain('1 thing to look at')
    expect(view.byText('Play anyway', 'button')).toBeNull()
    view.unmount()
  })

  it('starts collapsed and lists every finding once opened', () => {
    setSceneFindings([blocker, playBlocker, warning])
    const view = mount(<SceneChecksCard />)
    expect(view.find('.eui-checks-list')).toBeNull()
    expect(view.find('.eui-checks-head .bar')?.getAttribute('aria-expanded')).toBe('false')
    view.click(view.find('.eui-checks-head .bar'))
    expect(view.all('.eui-checks-list li')).toHaveLength(3)
    expect(view.find('.eui-checks-head .bar')?.getAttribute('aria-expanded')).toBe('true')
    view.unmount()
  })

  it('does not fold two findings of one rule into a single dismissal', () => {
    const first = { ...warning, entityId: '7' }
    const second = { ...warning, entityId: '8' }
    setSceneFindings([first, second])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-stall-x'))
    expect(view.container.innerHTML).toBe('')
    run(() => setSceneFindings([second]))
    expect(view.find('.eui-checks')).not.toBeNull()
    view.unmount()
  })

  it('labels play-blockers as blocking and warnings as warnings', () => {
    setSceneFindings([playBlocker, warning])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-checks-head .bar'))
    const chips = view.all('.eui-checks-list li .eui-ds-chip').map((c) => c.textContent)
    expect(chips).toEqual(['Blocks Play', 'Warning'])
    const tones = view.all('.eui-checks-list li .eui-ds-chip').map((c) => c.className)
    expect(tones[0]).toContain('danger')
    expect(tones[1]).not.toContain('danger')
    view.unmount()
  })

  it('renders a fix link only for findings that carry one', () => {
    setSceneFindings([blocker, warning])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-checks-head .bar'))
    expect(view.all('.eui-checks-list li .act')).toHaveLength(1)
    expect(view.byText('Show prefab', 'button')).not.toBeNull()
    view.unmount()
  })


  it('offers the assistant for the thumbnail even before one is signed in', () => {
    setSceneFindings([noThumbnail])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-checks-head .bar'))
    expect(view.byText('Make one with the assistant', 'button')).not.toBeNull()
    view.unmount()
  })

  it('lists unused files as one more finding while editing', () => {
    run(() => {
      state.frozen = true
    })
    const view = mount(<SceneChecksCard />)
    run(() => {
      unusedFiles.unused = ['models/tree.glb', 'assets/audio/old.mp3']
      unusedFiles.older = []
    })
    view.click(view.find('.eui-checks-head .bar'))
    expect(view.byText('Unused files')).not.toBeNull()
    expect(view.byText('Review', 'button')).not.toBeNull()
    view.unmount()
  })

  it('dismisses until the findings change, and comes back when they do', () => {
    setSceneFindings([warning])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-stall-x'))
    expect(view.container.innerHTML).toBe('')
    run(() => setSceneFindings([blocker, warning]))
    expect(view.find('.eui-checks')).not.toBeNull()
    view.unmount()
  })

  it('re-opens on a refused Play even after it was dismissed', () => {
    setSceneFindings([blocker])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-stall-x'))
    expect(view.container.innerHTML).toBe('')
    run(revealSceneChecks)
    expect(view.find('.eui-checks-list')).not.toBeNull()
    view.unmount()
  })

  it('comes back when only the numbers in a dismissed finding changed', () => {
    setSceneFindings([warning])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-stall-x'))
    expect(view.container.innerHTML).toBe('')
    run(() => setSceneFindings([{ ...warning, detail: 'Only one copy can own a trigger area — pool max is now 70.' }]))
    expect(view.find('.eui-checks')).not.toBeNull()
    view.unmount()
  })

  it('keeps two findings of the same id and folder apart', () => {
    setSceneFindings([warning, { ...warning, entityId: '7' }])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-checks-head .bar'))
    expect(view.all('.eui-checks-list li')).toHaveLength(2)
    view.unmount()
  })
})

// Warnings are ambient: they may update the collapsed bar's count, but only a
// blocker or play-blocker arriving is allowed to open the card by itself.
describe('SceneChecksCard auto-open', () => {
  it('opens itself when a blocker appears while mounted', () => {
    setSceneFindings([warning])
    const view = mount(<SceneChecksCard />)
    expect(view.find('.eui-checks-list')).toBeNull()
    run(() => setSceneFindings([blocker, warning]))
    expect(view.find('.eui-checks-list')).not.toBeNull()
    view.unmount()
  })

  it('opens itself when a play-blocker appears while mounted', () => {
    setSceneFindings([warning])
    const view = mount(<SceneChecksCard />)
    run(() => setSceneFindings([playBlocker, warning]))
    expect(view.find('.eui-checks-list')).not.toBeNull()
    view.unmount()
  })

  it('stays collapsed when only warnings change — the count just updates', () => {
    setSceneFindings([warning])
    const view = mount(<SceneChecksCard />)
    run(() => setSceneFindings([warning, { ...warning, entityId: '7' }]))
    expect(view.find('.eui-checks-list')).toBeNull()
    expect(view.text()).toContain('2 things to look at')
    view.unmount()
  })

  it('does not re-open for a blocker it already showed', () => {
    setSceneFindings([blocker])
    const view = mount(<SceneChecksCard />)
    run(() => setSceneFindings([blocker, warning]))
    expect(view.find('.eui-checks-list')).toBeNull()
    view.unmount()
  })

  it('a new blocker beats an earlier dismissal', () => {
    setSceneFindings([warning])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-stall-x'))
    expect(view.container.innerHTML).toBe('')
    run(() => setSceneFindings([blocker, warning]))
    expect(view.find('.eui-checks-list')).not.toBeNull()
    view.unmount()
  })
})

describe('SceneChecksCard fix with the assistant', () => {
  // onBuildEvent: the card's health hook wires itself to the shell it finds
  const shellHost = window as unknown as { editorShell?: { aiSend: () => Promise<void>; onBuildEvent: () => void } }
  afterEach(() => {
    delete shellHost.editorShell
    run(() => {
      aiStore.ask = null
    })
  })

  it('offers nothing to the assistant when there is none', () => {
    setSceneFindings([warning])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-checks-head .bar'))
    expect(view.byText('Fix', 'button')).toBeNull()
    view.unmount()
  })

  it('sends one finding to the assistant, title and detail', () => {
    shellHost.editorShell = { aiSend: async () => {}, onBuildEvent: () => {} }
    setSceneFindings([warning])
    const view = mount(<SceneChecksCard />)
    view.click(view.find('.eui-checks-head .bar'))
    view.click(view.all('.eui-checks-list li .act button').find((b) => b.textContent === 'Fix') ?? null)
    expect(aiStore.ask).toBe(fixRequest([warning]))
    expect(aiStore.ask).toContain(warning.title)
    expect(aiStore.ask).toContain(warning.detail)
    view.unmount()
  })

  it('fixes them all from the collapsed bar, keeping the thumbnail for the creator', () => {
    shellHost.editorShell = { aiSend: async () => {}, onBuildEvent: () => {} }
    setSceneFindings([blocker, warning, noThumbnail])
    const view = mount(<SceneChecksCard />)
    view.click(view.byText('Fix all', 'button'))
    expect(aiStore.ask).toBe(fixRequest([blocker, warning]))
    view.unmount()
  })
})
