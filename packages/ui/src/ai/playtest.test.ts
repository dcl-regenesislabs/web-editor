// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { leavePhone, playtest } from './playtest'

const mock = vi.hoisted(() => ({
  state: { frozen: false, saveStatus: '' },
  play: vi.fn(async () => {}), restart: vi.fn(async () => {}),
  command: vi.fn(async (_command: string, _args?: string[]) => '(1, 2, 3)'),
  snapshot: vi.fn(async (): Promise<Record<string, Record<string, unknown>>> => ({ '2': { Transform: { rotation: { x: 0, y: 0, z: 0, w: 1 } } }, '512': { UiText: { value: '3 / 5' } } })),
  serverLogs: [] as Array<{ seq: number; level: 'log' | 'error' | 'system'; msg: string }>
}))
vi.mock('@scene/state', () => ({ state: mock.state }))
vi.mock('@scene/inspector', () => ({ syncFrozenState: async () => {} }))
vi.mock('../actions/playback', () => ({ uiPlay: mock.play }))
vi.mock('../boot/boot', () => ({ restartScene: mock.restart }))
vi.mock('../engine/console', () => ({ consoleCommand: mock.command, getEngineWindow: () => window }))
vi.mock('../engine/cmd', () => ({ cmd: {
  crdtSnapshot: () => mock.snapshot(), sceneLogs: async () => ''
} }))
vi.mock('../engine/hosted', () => ({ hostV1: () => ({ previewServerLogs: () => mock.serverLogs }) }))

beforeEach(() => {
  vi.clearAllMocks()
  mock.state.frozen = false
  mock.state.saveStatus = ''
  mock.serverLogs = []
  document.body.innerHTML = '<canvas tabindex="0"></canvas>'
})
afterEach(() => vi.useRealTimers())

describe('assistant playtesting', () => {
  it('releases held interaction keys when a turn is cancelled', async () => {
    const controller = new AbortController()
    const released: string[] = []
    const canvas = document.querySelector('canvas')!
    canvas.addEventListener('keydown', () => controller.abort())
    canvas.addEventListener('keyup', (event) => released.push(event.code))
    await expect(playtest({ action: 'input', keys: ['E', 'F'], durationMs: 5000 }, controller.signal)).rejects.toThrow()
    expect(released).toEqual(['KeyE', 'KeyF'])
    expect(mock.command).not.toHaveBeenCalled()
  })

  it('refuses a blocked Play and never sends player input in edit mode', async () => {
    mock.state.frozen = true
    mock.state.saveStatus = 'Missing checkpoint'
    await expect(playtest({ action: 'start' }, new AbortController().signal)).rejects.toThrow('Missing checkpoint')
    await expect(playtest({ action: 'input', keys: ['E'] }, new AbortController().signal)).rejects.toThrow('Start playtesting')
    expect(mock.command).not.toHaveBeenCalled()
  })

  it('says where a blocked walk stopped instead of failing silently', async () => {
    mock.command.mockImplementation(async (command: string) => {
      if (command === 'walk_player_to') throw 'walk failed or timed out'
      return '(4, 1, 3)'
    })
    try {
      await expect(playtest({ action: 'walk', to: { x: 5, y: 1, z: 3 } }, new AbortController().signal)).rejects.toThrow('The player is at (4, 1, 3)')
    } finally {
      mock.command.mockImplementation(async () => '(1, 2, 3)')
    }
  })

  it('reports observed player position and HUD without changing game state', async () => {
    expect(await playtest({ action: 'status' }, new AbortController().signal)).toEqual({
      playing: true, platform: 'desktop', position: { x: 1, y: 2, z: 3 }, hud: ['3 / 5'], errors: [], serverErrors: []
    })
    expect(mock.command).toHaveBeenCalledTimes(1)
    expect(mock.command).toHaveBeenCalledWith('player_position')
  })

  it('leaves a never-stored key out of the server errors and keeps real ones', async () => {
    const missing = (path: string) =>
      `ERROR Error in http://localhost:5173/preview/p2783cc72b315a4007247c83beeba2b69/${path} endpoint {"response":{"ok":false,"status":404,"statusText":"","headers":{},"body":"{\\"message\\":\\"not found\\"}"}}`
    mock.serverLogs = [
      { seq: 1, level: 'error', msg: missing('values/serverState%3Agame.saved') },
      { seq: 2, level: 'error', msg: missing('players/0x4b6596de0587b6cf28867f07a39e31cbfa526caa/values/game') },
      { seq: 3, level: 'error', msg: 'ERROR Error in http://localhost:5173/preview/p2783cc72b315a4007247c83beeba2b69/values/score endpoint {"response":{"ok":false,"status":500}}' }
    ]
    const { serverErrors } = (await playtest({ action: 'status' }, new AbortController().signal)) as { serverErrors: string[] }
    expect(serverErrors).toEqual([mock.serverLogs[2].msg])
  })

  it('bounds durations and rejects arbitrary keys and nonfinite targets', async () => {
    for (const request of [
      { action: 'input', keys: ['Meta'] }, { action: 'input', keys: ['W'] }, { action: 'input', keys: ['E'], durationMs: Infinity },
      { action: 'wait', durationMs: 5001 }, { action: 'walk', to: { x: NaN, y: 0, z: 0 } },
      { action: 'click', x: -1, y: 0.5 }
    ]) await expect(playtest(request, new AbortController().signal)).rejects.toThrow()
    expect(mock.command).not.toHaveBeenCalled()
  })

  it('plays as on a phone until stopped, and a turn never leaves the creator on one', async () => {
    vi.useFakeTimers()
    const run = async (request: Record<string, unknown>) => {
      const pending = playtest(request, new AbortController().signal)
      await vi.runAllTimersAsync()
      return pending
    }
    expect(await run({ action: 'start', platform: 'mobile' })).toMatchObject({ playing: true, platform: 'mobile' })
    expect(mock.command).toHaveBeenCalledWith('mobile_ui', ['on'])
    await run({ action: 'start', platform: 'mobile' })
    expect(mock.command.mock.calls.filter(([command]) => command === 'mobile_ui')).toHaveLength(1)
    expect(await run({ action: 'stop' })).toMatchObject({ platform: 'desktop' })
    expect(mock.command).toHaveBeenLastCalledWith('player_position')
    expect(mock.command.mock.calls.filter(([command]) => command === 'mobile_ui').map(([, args]) => args)).toEqual([['on'], ['off']])

    await run({ action: 'start', platform: 'mobile' })
    mock.restart.mockClear()
    await leavePhone()
    expect(mock.command).toHaveBeenCalledWith('mobile_ui', ['off'])
    expect(mock.restart).toHaveBeenCalledTimes(1)
    await leavePhone()
    expect(mock.restart).toHaveBeenCalledTimes(1)
    await expect(playtest({ action: 'start', platform: 'tablet' }, new AbortController().signal)).rejects.toThrow('desktop or mobile')
  })

  it('presses as soon as the awaited text is on the HUD, and says when it never came', async () => {
    vi.useFakeTimers()
    const hud = mock.snapshot.getMockImplementation()!
    onTestFinished(() => { mock.snapshot.mockImplementation(hud) })
    let polls = 0
    mock.snapshot.mockImplementation(async () => ({ '512': { UiText: { value: ++polls < 3 ? 'Esperando…' : '¡PICA!' } } }))
    const pressed: number[] = []
    document.querySelector('canvas')!.addEventListener('keydown', () => pressed.push(polls))
    const pending = playtest({ action: 'input', keys: ['E'], durationMs: 100, waitFor: 'PICA' }, new AbortController().signal)
    await vi.runAllTimersAsync()
    await pending
    expect(pressed).toEqual([3])

    mock.snapshot.mockImplementation(async () => ({}))
    const never = playtest({ action: 'input', keys: ['E'], waitFor: 'PICA' }, new AbortController().signal)
    const failed = expect(never).rejects.toThrow('did not appear')
    await vi.runAllTimersAsync()
    await failed
    expect(pressed).toEqual([3])
  })
})
