// A fixed game camera. While this player stands inside the rig's area (or all
// the time, with 'always'), their view switches to a camera that looks at the
// rig from above along the rig's heading, far enough back that the whole area
// fits on their screen — a phone's wide canvas included. Leaving the area hands
// the default camera back.
//
// The rig's own Transform is the whole authoring surface: its position is where
// the camera looks, its rotation is which way is up on screen, and its scale is
// the area in metres — the volume the editor draws while building, and the
// TriggerArea that decides "inside" while playing.
//
// The camera itself is a separate root entity: a VirtualCamera inherits its
// entity's scale, and the rig's scale is the area, not something to film with.
import {
  MainCamera,
  Transform,
  TriggerArea,
  UiCanvasInformation,
  VirtualCamera,
  engine,
  triggerAreaEventsSystem,
  type Entity
} from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { isMobile } from '@dcl/sdk/platform'
import { localPlayerPosition } from '~runtime/playerPositions'
import { entityWorld } from '~runtime/sceneNames'
import { Membership } from '~runtime/pure/membership'
import {
  CAMERA_FOV_DEG,
  aspectFor,
  cameraOnTop,
  cameraPose,
  claimCamera,
  framingDistance,
  pitchFor,
  releaseCamera,
  yawOf,
  type CameraPose,
  type RigClaims
} from '~runtime/pure/cameraRig'
import type { Vec3 } from '~runtime/pure/worldTransform'

// Collision layers by value: the SDK renamed CL_RESERVED2 to CL_MAIN_PLAYER, and
// this script compiles against whatever pin the creator's project carries. The
// local avatar alone carries 8, so the area reacts to the player at this screen.
const CL_MAIN_PLAYER = 8
const SPHERE_MESH = 1
// A player on the boundary crosses it every few frames; without this the view
// would snap back and forth.
const EXIT_GRACE_S = 0.3
const FOLLOW_EYE_M = 1
const MOVED_EPSILON = 1e-3
// Several rigs in one scene agree on who owns the screen through this key.
const CLAIMS_KEY = '__dclCameraRig_v1'

export class CameraRig {
  private camera: Entity | null = null
  private members = new Membership<Entity>()
  private pose: CameraPose | null = null

  constructor(
    public src: string,
    public entity: Entity,
    /** How the camera looks at the area */
    public mode: 'top-down' | 'isometric' | 'follow' = 'isometric',
    /** When the camera takes over */
    public activeWhen: 'inside this area' | 'always' = 'inside this area',
    /** Degrees the camera looks down from the horizon, for isometric and follow. Top-down looks straight down. */
    public angle: number = 55,
    /** Metres from the camera to what it looks at. 0 fits the whole area on screen. */
    public distance: number = 0,
    /** Metres of ground the shot must show across and deep. 0 uses this rig's own area (its scale); follow uses 10. */
    public fitSize: number = 0,
    /** Seconds the view takes to glide into this camera. 0 cuts straight to it. */
    public transitionSeconds: number = 0.6
  ) {}

  start(): void {
    // The camera is one player's screen; a Multiplayer Server has none.
    if (isServer()) return
    const camera = engine.addEntity()
    Transform.create(camera, { position: Transform.getOrNull(this.entity)?.position ?? { x: 0, y: 0, z: 0 } })
    // Built as a value, not a literal, so an older SDK pin without `fov` still
    // type-checks; its encoder drops the field and the explorer's default is 60.
    const settings = {
      defaultTransition: {
        transitionMode: { $case: 'time' as const, time: Math.max(0, this.transitionSeconds) }
      },
      fov: CAMERA_FOV_DEG
    }
    VirtualCamera.create(camera, settings)
    this.camera = camera

    if (this.activeWhen === 'always') {
      TriggerArea.deleteFrom(this.entity)
      return
    }
    if (TriggerArea.getOrNull(this.entity)?.mesh === SPHERE_MESH) {
      TriggerArea.setSphere(this.entity, CL_MAIN_PLAYER)
    } else {
      TriggerArea.setBox(this.entity, CL_MAIN_PLAYER)
    }
    // Stay as well as enter: a player who spawns inside the area never crosses
    // into it, and the engine's enter fires only on the crossing.
    triggerAreaEventsSystem.onTriggerEnter(this.entity, (result) => this.seen(result.trigger?.entity))
    triggerAreaEventsSystem.onTriggerStay(this.entity, (result) => this.seen(result.trigger?.entity))
    triggerAreaEventsSystem.onTriggerExit(this.entity, (result) => this.gone(result.trigger?.entity))
  }

  update(dt: number): void {
    const camera = this.camera
    if (camera === null) return
    this.members.tick(dt, EXIT_GRACE_S)
    const active = this.activeWhen === 'always' || this.members.size > 0
    if (active) this.aim(camera)
    const claims = rigClaims()
    if (active) claimCamera(claims, camera)
    else releaseCamera(claims, camera)
    applyClaims(claims)
  }

  private aim(camera: Entity): void {
    const rig = entityWorld(this.entity)
    if (rig === null) return
    let target: Vec3 = rig.position
    if (this.mode === 'follow') {
      const feet = localPlayerPosition()
      if (feet === null && this.pose !== null) return
      if (feet !== null) target = { x: feet.x, y: feet.y + FOLLOW_EYE_M, z: feet.z }
    }
    const mobile = isMobile()
    const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
    const pitchDeg = pitchFor(this.mode, this.angle)
    const distance = framingDistance({
      mode: this.mode,
      distance: this.distance,
      fitSize: this.fitSize,
      area: rig.scale,
      pitchDeg,
      aspect: aspectFor(canvas, mobile),
      mobile
    })
    const pose = cameraPose(target, yawOf(rig.rotation), pitchDeg, distance)
    if (this.pose !== null && samePose(this.pose, pose)) return
    this.pose = pose
    Transform.createOrReplace(camera, { position: pose.position, rotation: pose.rotation })
  }

  // result.trigger.entity is the avatar that moved; the area is triggeredEntity.
  private seen(raw?: number): void {
    const who = toEntity(raw)
    if (who !== undefined) this.members.touch(who)
  }

  private gone(raw?: number): void {
    const who = toEntity(raw)
    if (who !== undefined) this.members.drop(who)
  }
}

function toEntity(raw?: number): Entity | undefined {
  return raw === undefined || raw === 0 ? undefined : (raw as Entity)
}

function samePose(a: CameraPose, b: CameraPose): boolean {
  const p = Math.abs(a.position.x - b.position.x) + Math.abs(a.position.y - b.position.y) + Math.abs(a.position.z - b.position.z)
  const r =
    Math.abs(a.rotation.x - b.rotation.x) +
    Math.abs(a.rotation.y - b.rotation.y) +
    Math.abs(a.rotation.z - b.rotation.z) +
    Math.abs(a.rotation.w - b.rotation.w)
  return p < MOVED_EPSILON && r < MOVED_EPSILON
}

function isClaims(value: unknown): value is RigClaims<Entity> {
  return typeof value === 'object' && value !== null && Array.isArray((value as { order?: unknown }).order)
}

function rigClaims(): RigClaims<Entity> {
  const globals = globalThis as unknown as Record<string, unknown>
  const current = globals[CLAIMS_KEY]
  if (isClaims(current)) return current
  const created: RigClaims<Entity> = { order: [], applied: null }
  globals[CLAIMS_KEY] = created
  return created
}

function applyClaims(claims: RigClaims<Entity>): void {
  const wanted = cameraOnTop(claims)
  if (wanted === claims.applied) return
  if (wanted !== null) {
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: wanted })
  } else if (MainCamera.getOrNull(engine.CameraEntity)?.virtualCameraEntity === claims.applied) {
    // Only undo our own write: a cutscene camera a script set meanwhile stays.
    MainCamera.createOrReplace(engine.CameraEntity, {})
  }
  claims.applied = wanted
}
