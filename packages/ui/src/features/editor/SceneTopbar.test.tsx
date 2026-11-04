import { afterEach, describe, expect, it } from 'vitest'
import { state } from '@scene/state'
import { mount, run } from '../../test/render'
import { SceneTopbar } from './SceneTopbar'

afterEach(() => {
  run(() => {
    state.status = 'logging-in'
    state.frozen = false
  })
})

describe('the entry-mode top bar', () => {
  it('offers Play while the scene is paused, since entry mode has no toolbar', () => {
    run(() => {
      state.status = 'ready'
      state.frozen = true
    })
    const view = mount(<SceneTopbar logsOpen={false} onToggleLogs={() => {}} entry />)
    expect(view.byText('Play', 'button')).not.toBeNull()
    run(() => {
      state.frozen = false
    })
    expect(view.byText('Play', 'button')).toBeNull()
    view.unmount()
  })

  it('leaves Play to the toolbar in the whole editor', () => {
    run(() => {
      state.status = 'ready'
      state.frozen = true
    })
    const view = mount(<SceneTopbar logsOpen={false} onToggleLogs={() => {}} />)
    expect(view.byText('Play', 'button')).toBeNull()
    view.unmount()
  })
})
