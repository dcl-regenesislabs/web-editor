import { engine, PlayerIdentityData, VisibilityComponent, type Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { game, reportProblem } from '~runtime/game'
import { mountRunHud, type RunHudProps } from '~runtime/gameHud'
import type { ColorHex, EntityName, EntityNames, ZoneName, ZoneNames } from '~runtime/authoring'
import { createRun, restartRun, runOf } from '~runtime/runs'
import { entityWorld, namedEntity } from '~runtime/sceneNames'
import type { Vec3 } from '~runtime/pure/worldTransform'
import { elapsedRun, freshRun, type RunAction, type RunState } from '~runtime/pure/runState'
import { RunPrediction } from '~runtime/pure/runPrediction'

function list(value: string): string[] {
  return value.split(',').map((name) => name.trim()).filter(Boolean)
}

function named(name: string | undefined) {
  const entity = name?.trim() ? namedEntity(name) : null
  return entity === null ? null : entityWorld(entity)
}

// A missing marker must not stop the course: respawn on the floor of its area, and
// with no area either, let Health & Respawn's respawnAt decide.
function spawnPosition(marker: string | undefined, area: string): Vec3 | undefined {
  const exact = named(marker)
  if (exact !== null) return exact.position
  const zone = named(area)
  console.log(zone === null
    ? `[runProgress] no spawn marker "${marker ?? ''}" or area "${area}" — Health & Respawn's respawnAt is used`
    : `[runProgress] no spawn marker "${marker ?? ''}" — respawning on area "${area}"`)
  if (zone === null) return undefined
  return { ...zone.position, y: zone.position.y - Math.abs(zone.scale.y) / 2 }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export class RunProgress {
  private items: string[] = []
  private points: string[] = []
  private visuals: string[] = []
  private prediction: RunPrediction | null = null
  private notice = ''
  private noticeUntil = 0
  private pending = false
  private lastVisual = ''

  constructor(
    public src: string,
    public entity: Entity,
    public courseId: string = 'course',
    public title: string = 'Sky Lantern Run',
    public objective: string = 'Collect every orb and reach the finish',
    public startArea: ZoneName = 'Start',
    public finishArea: ZoneName = 'Finish',
    public startMarker: EntityName = 'Start Spawn',
    public checkpointAreas: ZoneNames = 'Checkpoint 1, Checkpoint 2, Checkpoint 3',
    public checkpointMarkers: EntityNames = 'Spawn 1, Spawn 2, Spawn 3',
    public collectibleAreas: ZoneNames = 'Orb 1, Orb 2, Orb 3, Orb 4, Orb 5',
    public accentColor: ColorHex = '#FFC459',
    public collectibleVisuals: EntityNames = '',
    /** "Big timer" shows one large clock at the top; "Hidden" draws nothing, for a custom HUD. */
    public hud: 'Full' | 'Big timer' | 'Hidden' = 'Full'
  ) {}

  start(): void {
    this.items = list(this.collectibleAreas)
    this.points = list(this.checkpointAreas)
    this.visuals = list(this.collectibleVisuals)
    if (this.visuals.length !== 0 && this.visuals.length !== this.items.length) throw new Error('Each collectible area needs a matching visual name.')
    const markers = list(this.checkpointMarkers)
    if (isServer() && markers.length !== this.points.length) {
      reportProblem('Run Progress', `${this.points.length} checkpoint areas but ${markers.length} spawn markers — give each checkpoint one marker, in the same order.`)
    }
    if (isServer()) {
      createRun({
        id: this.courseId, startArea: this.startArea, finishArea: this.finishArea,
        startPosition: spawnPosition(this.startMarker, this.startArea),
        checkpoints: this.points.map((area, index) => ({ area, position: spawnPosition(markers[index], area) })),
        collectibles: this.items
      })
      return
    }
    this.prediction = new RunPrediction({ checkpoints: this.points, collectibles: this.items })
    const watch = (area: string, action: RunAction) => game.onLocalAreaEnter(area, (validation) => {
      this.current()
      const predicted = this.prediction!.predict(action, game.now())
      if (predicted.message) this.say(predicted.message)
      this.update()
      void validation.then((accepted) => {
        this.current()
        if (!accepted && predicted.id !== null && this.prediction!.reject(predicted.id)) {
          this.say('Progress could not be confirmed. Try again.')
          this.update()
        }
      })
    })
    watch(this.startArea, { type: 'start' })
    watch(this.finishArea, { type: 'finish' })
    this.points.forEach((area, index) => watch(area, { type: 'checkpoint', index }))
    this.items.forEach((id) => watch(id, { type: 'collect', id }))
    if (this.hud !== 'Hidden') mountRunHud(() => this.hudProps())
  }

  update(): void {
    if (isServer()) return
    const state = this.current()
    if (state === null) return
    const signature = `${state.attempt}:${state.collected.join(',')}`
    if (signature === this.lastVisual) return
    let complete = true
    for (const [index, name] of this.items.entries()) {
      const entity = namedEntity(this.visuals[index] ?? name)
      if (entity === null) { complete = false; continue }
      VisibilityComponent.createOrReplace(entity, { visible: !state.collected.includes(name), propagateToChildren: true })
    }
    if (complete) this.lastVisual = signature
  }

  private player(): string {
    return (PlayerIdentityData.getOrNull(engine.PlayerEntity)?.address ?? '').toLowerCase()
  }

  private current(): RunState | null {
    const state = runOf(this.courseId, this.player())
    this.prediction?.reconcile(state, game.now())
    return this.prediction?.view(game.now()) ?? state
  }

  private say(text: string): void {
    this.notice = text
    this.noticeUntil = game.now() + 3500
  }

  private restart(): void {
    const state = runOf(this.courseId, this.player())
    if (state === null || this.pending) return
    this.pending = true
    this.current()
    const predicted = this.prediction?.predict({ type: 'restart' }, game.now())
    this.update()
    void restartRun(this.courseId, state.attempt).then((result) => {
      if (record(result).ok !== true) throw new Error('Restart was refused')
    }).catch((error: unknown) => {
      if (predicted?.id != null) this.prediction?.reject(predicted.id)
      this.say('Restart failed. Try again.')
      console.log(`[runProgress] restart failed: ${String(error)}`)
    }).finally(() => { this.pending = false })
  }

  private hudProps(): RunHudProps {
    const player = this.player()
    const state = this.current() ?? freshRun()
    const health = game.state.healthBar === false ? null : record(game.state.health)[player]
    const life = record(record(game.state.healthLife)[player])
    return {
      title: this.title, objective: this.objective, phase: state.phase,
      elapsedMs: elapsedRun(state, game.now()), bestMs: state.bestMs,
      checkpoint: state.checkpoint, checkpoints: this.points.length,
      collected: state.collected.length, collectibles: this.items.length,
      health: typeof health === 'number' ? health : null,
      maxHealth: typeof game.state.healthMax === 'number' ? game.state.healthMax : 100,
      respawnSeconds: life.dead === true && typeof life.respawnAt === 'number' ? Math.max(0, life.respawnAt - game.now()) / 1000 : 0,
      notice: game.now() < this.noticeUntil ? this.notice : '',
      accentColor: this.accentColor, restart: () => this.restart(), hud: this.hud === 'Big timer' ? 'Big timer' : 'Full'
    }
  }
}
