import { afterEach, describe, expect, it } from 'vitest'
import type { EditorShell, HostState, ProjectInfo, SyncStatus } from '@dcl-editor/contract'
import { CreateHome } from './CreateHome'
import { mount, run } from '../../test/render'

function hostState(projects: ProjectInfo[]): HostState {
  return {
    recentProjects: [],
    projects,
    logs: [],
    bevyWebDir: '',
    editorSceneDir: '',
    webPort: 0,
    scenePort: 0,
    editorScenePort: 0,
    favourites: []
  }
}

const scene: ProjectInfo = { path: 'p1', name: 'p1', title: 'My scene', world: null, parcels: 1, thumbnail: null, remoteOnly: true }

afterEach(() => {
  window.editorShell = undefined
})

describe('the Create page', () => {
  it('says the scenes are loading, not synced, until the account’s list has arrived', async () => {
    let status: SyncStatus = { account: 'on', state: 'synced', projects: {}, revision: 0, loading: true }
    let push: (next: SyncStatus) => void = () => {}
    let listed: ProjectInfo[] = []
    const shell: EditorShell = {
      pickProject: async () => {},
      openProject: async () => {},
      getState: async () => hostState(listed),
      onStackLog: () => {},
      syncStatus: async () => status,
      onSyncStatus: (cb) => {
        push = cb
        return () => {}
      }
    }
    window.editorShell = shell
    const view = mount(<CreateHome />)
    await view.settle()
    expect(view.text()).toContain('Loading your scenes…')
    expect(view.text()).not.toContain('Synced with your account.')
    expect(view.all('.eui-create-card.skeleton').length).toBeGreaterThan(0)

    listed = [scene]
    status = { account: 'on', state: 'synced', projects: {}, revision: 1 }
    run(() => push(status))
    await view.settle()
    expect(view.text()).toContain('Synced with your account.')
    expect(view.text()).not.toContain('Loading your scenes…')
    expect(view.text()).toContain('My scene')
    expect(view.all('.eui-create-card.skeleton')).toHaveLength(0)
    view.unmount()
  })
})
