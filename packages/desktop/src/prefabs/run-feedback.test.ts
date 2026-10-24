import { beforeEach, describe, expect, it, vi } from 'vitest'
import { advanceRun, freshRun, type RunState } from '../../runtime-modules/pure/runState'

const host = vi.hoisted(() => ({
  now: 1000,
  state: null as RunState | null,
  listeners: new Map<string, (result: Promise<boolean>) => void>(),
  visibility: new Map<number, { visible: boolean; propagateToChildren: boolean }>(),
  render: null as (() => unknown) | null,
  game: {} as Record<string, unknown>,
  server: false,
  createRun: vi.fn(),
  problems: [] as string[],
  entities: { 'Orb 1': 10, 'Orb 1 Glow': 11, Start: 20, 'Checkpoint 1': 21 } as Record<string, number>,
  world: {
    20: { position: { x: 1, y: 1.5, z: 1 }, scale: { x: 4, y: 3, z: 4 } },
    21: { position: { x: 5, y: 4, z: 5 }, scale: { x: 4, y: -2, z: 4 } }
  } as Record<number, { position: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } }>
}))

vi.mock('@dcl/sdk/ecs', () => ({
  engine: { PlayerEntity: 1 },
  PlayerIdentityData: { getOrNull: () => ({ address: '0xada' }) },
  VisibilityComponent: { createOrReplace: (id: number, value: { visible: boolean; propagateToChildren: boolean }) => host.visibility.set(id, value) }
}))
vi.mock('@dcl/sdk/network', () => ({ isServer: () => host.server }))
vi.mock('~runtime/gameHud', () => ({ mountRunHud: (read: () => unknown) => { host.render = read } }))
vi.mock('~runtime/game', () => ({
  game: {
    state: host.game, now: () => host.now,
    onLocalAreaEnter: (name: string, fn: (result: Promise<boolean>) => void) => host.listeners.set(name, fn)
  },
  reportProblem: (name: string, message: string) => host.problems.push(`${name}: ${message}`)
}))
vi.mock('~runtime/runs', () => ({ createRun: host.createRun, restartRun: vi.fn(), runOf: () => host.state }))
vi.mock('~runtime/sceneNames', () => ({
  namedEntity: (name: string) => host.entities[name] ?? null,
  entityWorld: (entity: number) => host.world[entity] ?? null
}))

beforeEach(() => {
  host.now = 1000
  host.state = advanceRun(freshRun(), { type: 'start' }, 500, { checkpoints: [], collectibles: ['Orb 1'] }).state
  host.listeners.clear()
  host.visibility.clear()
  host.render = null
  for (const key of Object.keys(host.game)) delete host.game[key]
  host.server = false
  host.createRun.mockClear()
  host.problems.length = 0
})

describe('Run Progress presentation', () => {
  it.each([true, false])('hides the plain orb and updates the HUD before a 400 ms server reply (accepted=%s)', async (accepted) => {
    const { RunProgress } = await vi.importActual<{ RunProgress: new (src: string, entity: number) => {
      checkpointAreas: string; checkpointMarkers: string; collectibleAreas: string; collectibleVisuals: string
      start(): void; update(): void
    } }>('../../prefabs/run-progress/scripts/run-progress')
    const progress = new RunProgress('', 0)
    progress.checkpointAreas = ''
    progress.checkpointMarkers = ''
    progress.collectibleAreas = 'Orb 1'
    progress.collectibleVisuals = 'Orb 1 Glow'
    progress.start()
    progress.update()
    expect(host.visibility.get(11)?.visible).toBe(true)
    let answer!: (value: boolean) => void
    const validation = new Promise<boolean>((resolve) => { answer = resolve })
    host.listeners.get('Orb 1')!(validation)
    expect(host.state?.collected).toEqual([])
    expect(host.visibility.get(11)).toEqual({ visible: false, propagateToChildren: true })
    expect(host.visibility.has(10)).toBe(false)
    expect(host.render!()).toMatchObject({ collected: 1, notice: '1 / 1 collected' })
    host.now += 399
    progress.update()
    expect(host.visibility.get(11)?.visible).toBe(false)
    host.now += 1
    if (accepted) host.state = { ...host.state!, collected: ['Orb 1'] }
    answer(accepted)
    await validation
    progress.update()
    expect(host.visibility.get(11)?.visible).toBe(!accepted)
    expect(host.render!()).toMatchObject({ collected: accepted ? 1 : 0 })
    host.state = freshRun(null, 2)
    progress.update()
    expect(host.visibility.get(11)?.visible).toBe(true)
  })
})

const load = async () => (await vi.importActual<{ RunProgress: new (src: string, entity: number) => {
  checkpointAreas: string; checkpointMarkers: string; collectibleAreas: string; startArea: string; hud: string; start(): void
} }>('../../prefabs/run-progress/scripts/run-progress')).RunProgress

describe('Run Progress HUD settings', () => {
  it('draws health unless Health & Respawn turns its bar off, and nothing when hidden', async () => {
    const RunProgress = await load()
    host.game.health = { '0xada': 80 }
    const progress = new RunProgress('', 0)
    progress.start()
    expect(host.render!()).toMatchObject({ health: 80, hud: 'Full' })
    host.game.healthBar = false
    expect(host.render!()).toMatchObject({ health: null })

    host.render = null
    const hidden = new RunProgress('', 0)
    hidden.hud = 'Hidden'
    hidden.start()
    expect(host.render).toBeNull()
  })
})

describe('Run Progress course setup', () => {
  it('starts a course whose spawn markers are not placed, respawning on the area floors', async () => {
    const RunProgress = await load()
    host.server = true
    const progress = new RunProgress('', 0)
    progress.checkpointAreas = 'Checkpoint 1'
    progress.checkpointMarkers = 'Spawn 1'
    progress.collectibleAreas = ''
    expect(() => progress.start()).not.toThrow()
    expect(host.createRun).toHaveBeenLastCalledWith(expect.objectContaining({
      startPosition: { x: 1, y: 0, z: 1 },
      checkpoints: [{ area: 'Checkpoint 1', position: { x: 5, y: 3, z: 5 } }]
    }))
    expect(host.problems).toEqual([])

    const bare = new RunProgress('', 0)
    bare.startArea = 'Gate'
    bare.checkpointAreas = 'Checkpoint 1'
    bare.checkpointMarkers = ''
    bare.collectibleAreas = ''
    expect(() => bare.start()).not.toThrow()
    expect(host.createRun).toHaveBeenLastCalledWith(expect.objectContaining({ startPosition: undefined }))
    expect(host.problems).toEqual(['Run Progress: 1 checkpoint areas but 0 spawn markers — give each checkpoint one marker, in the same order.'])
  })
})
