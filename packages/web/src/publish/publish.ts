// Publishing a scene to a World from the page: a production build, the entity
// (entity.ts), the hosting page's confirmation and signature, and the upload
// (upload.ts). The editor holds no key: it hands the entity id to
// host.signDeployment and sends the auth chain that comes back. A creator without
// a NAME publishes to a shared world instead (shared.ts): the project service
// signs, after checking the entity, and the upload is the same.
import type { PublishProgress, PublishedScene, ScenePublishResult } from '@dcl-editor/contract'
import type { BuildResult } from '@dcl-editor/scene-compiler'
import { trackCreator } from '@ui/analytics'
import type { DclEditorHostV1 } from '@ui/engine/hosted'
import { buildDeployment, type Deployment } from './entity'
import { PublishError } from './errors'
import { type PoolClient, type SharedLease, createPoolClient, placeInZone } from './shared'
import { uploadDeployment, validAuthChain } from './upload'
import { worldRealm } from './worlds'

export interface PublishSource {
  host: DclEditorHostV1
  // write worldConfiguration.name into the project's scene.json
  setWorld(id: string, world: string): Promise<void>
  files(id: string): Promise<Map<string, Uint8Array>>
  build(id: string, files: Map<string, Uint8Array>): Promise<BuildResult & { sdkVersion: string }>
  // keep what was published with the project
  published(id: string, scene: PublishedScene): Promise<void>
  // the shared worlds; by default the project service's, when the host has one
  pool?: PoolClient
}

export interface Publisher {
  publish(id: string, world: string, onProgress: (progress: PublishProgress) => void): Promise<ScenePublishResult>
  // publish to a zone of a shared world the project service lends; absent without one
  publishShared?: (id: string, onProgress: (progress: PublishProgress) => void) => Promise<ScenePublishResult>
  // stop the publish under way; the server may still finish an upload it has received
  stop(): void
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const size = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

const CANCELLED: ScenePublishResult = { ok: false, reason: 'cancelled', message: 'Publishing was cancelled.', retryable: true }
const NOT_SIGNED_IN: ScenePublishResult = { ok: false, reason: 'not-signed-in', message: 'Sign in to publish', retryable: false }
const failed = (message: string, retryable: boolean): ScenePublishResult => ({ ok: false, reason: 'failed', message, retryable })

// A `failed` result's code for analytics, in the warehouse's snake_case.
class Failure {
  code = 'unexpected'
  set(code: string): this {
    this.code = code.replace(/-/g, '_')
    return this
  }
}

export function createPublisher(source: PublishSource): Publisher {
  const { host } = source
  const projects = host.services.projects
  const pool = source.pool ?? (projects === null ? undefined : createPoolClient(projects, (url, init) => host.signedFetch(url, init)))
  const server = host.services.worldsContent.replace(/\/+$/, '')
  let running: AbortController | null = null

  // a world holds several scenes, and without a position the link lands on its spawn, not this one
  function position(deployment: Deployment): string {
    const base = (deployment.entity.metadata.scene as { base?: unknown } | undefined)?.base
    return typeof base === 'string' ? `&position=${encodeURIComponent(base)}` : ''
  }

  // null: a NAME's world, signed by the creator in the hosting page
  async function run(id: string, target: string | null, say: (progress: PublishProgress) => void, signal: AbortSignal, failure: Failure): Promise<ScenePublishResult> {
    const { address, isGuest } = host.identity()
    if (isGuest || address === null) return NOT_SIGNED_IN
    let lease: SharedLease | null = null
    if (target === null && pool !== undefined) {
      say({ step: 'building', line: 'Finding you a place in a shared world…' })
      lease = await pool.lease()
      say({ step: 'building', line: `${lease.world}, parcels from ${lease.zone.x},${lease.zone.y} (${lease.zone.size}×${lease.zone.size})` })
    } else if (target !== null) {
      await source.setWorld(id, target)
    }
    const world = lease?.world ?? (target as string)
    if (signal.aborted) return CANCELLED
    say({ step: 'building', line: 'Building the scene for publishing…' })
    const files = await source.files(id)
    const built = await source.build(id, files)
    if (signal.aborted) return CANCELLED
    if (!built.ok) {
      // the shape the publish dialog reads a file and a line out of
      for (const d of built.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')) {
        say({ step: 'building', line: d.file === undefined ? `ERROR: ${d.message}` : `${d.file}:${d.line ?? 1}:${d.column ?? 0}: ERROR: ${d.message}` })
      }
      const crash = built.events.find((event) => event.type === 'failed')
      if (crash?.type === 'failed' && built.diagnostics.length === 0) say({ step: 'building', line: crash.message })
      failure.set('build')
      return failed('The build failed.', false)
    }

    // built last of all: the signature is over an id that holds this timestamp,
    // and the server takes it for five minutes
    const placed = lease === null ? files : new Map([...files, ['scene.json', placeInZone(files.get('scene.json'), lease)]])
    const deployment = await buildDeployment({ files: placed, outputs: built.outputs, world, sdkVersion: built.sdkVersion, timestamp: Date.now() })
    let authChain: unknown
    if (lease !== null && pool !== undefined) {
      if (deployment.bytes > lease.maxSceneBytes) {
        failure.set('too_large')
        return failed(`This scene is ${size(deployment.bytes)} and a scene in a shared world can be ${size(lease.maxSceneBytes)} at most. Remove or shrink its largest files.`, false)
      }
      say({ step: 'signing', line: `Asking the shared world to sign ${deployment.fileCount} files, ${size(deployment.bytes)}, as ${deployment.entityId}` })
      const entityFile = deployment.files.get(deployment.entityId)
      authChain = await pool.sign(new TextDecoder().decode(entityFile), deployment.bytes)
    } else {
      say({ step: 'signing', line: `Waiting for your confirmation: ${deployment.fileCount} files, ${size(deployment.bytes)}, as ${deployment.entityId}` })
      try {
        authChain = await host.signDeployment({
          world,
          entityId: deployment.entityId,
          title: deployment.title,
          fileCount: deployment.fileCount,
          bytes: deployment.bytes
        })
      } catch (error) {
        const why = describe(error)
        if (why === 'cancelled') return CANCELLED
        if (why === 'not-signed-in') return NOT_SIGNED_IN
        failure.set('sign_failed')
        return failed(`Decentraland could not sign this publish: ${why}`, true)
      }
    }
    if (signal.aborted) return CANCELLED
    if (!validAuthChain(authChain, deployment.entityId)) {
      failure.set('no_signature')
      return failed('Decentraland did not return a signature for this scene.', true)
    }

    say({ step: 'uploading', line: `Uploading to ${world} (${server})…` })
    const said = await uploadDeployment({
      server,
      world,
      deployment,
      authChain,
      signal,
      onProgress: (line) => say({ step: 'uploading', line }),
      onRetry: (attempt, why) => say({ step: 'uploading', line: `Trying again (${attempt} of 3): ${why}` })
    })
    if (said !== '') say({ step: 'uploading', line: said })
    // the service checks what landed against what it signed; a scene it takes down fails the next publish, not this one
    if (lease !== null) await pool?.published(deployment.entityId).catch((error: unknown) => console.warn('[editor] the shared world did not confirm the publish', error))
    const published: PublishedScene = {
      world,
      entityId: deployment.entityId,
      url: `${host.pageDir}?realm=${encodeURIComponent(worldRealm(server, world))}${position(deployment)}`,
      files: deployment.fileCount,
      bytes: deployment.bytes,
      at: Date.now()
    }
    await source.published(id, published).catch((error: unknown) => console.warn('[editor] could not record the publish', error))
    return { ok: true, published }
  }

  async function start(id: string, target: string | null, onProgress: (progress: PublishProgress) => void): Promise<ScenePublishResult> {
    if (running !== null) return failed('A scene is already being published.', false)
    const controller = new AbortController()
    running = controller
    const failure = new Failure()
    const result = await run(id, target, onProgress, controller.signal, failure)
      .catch((error: unknown) => {
        if (!(error instanceof PublishError)) return failed(describe(error), true)
        if (error.reason === 'cancelled') return CANCELLED
        if (error.detail !== undefined) onProgress({ step: 'uploading', line: `The server answered: ${error.detail}` })
        failure.set(error.reason)
        return failed(error.message, error.retryable)
      })
      .finally(() => {
        running = null
      })
    const world = result.ok ? result.published.world : (target ?? 'shared')
    const shared = target === null
    if (result.ok) {
      trackCreator('scene_published', { project_id: id, world, shared, files: result.published.files, bytes: result.published.bytes })
    } else {
      trackCreator('publish_failed', { project_id: id, world, shared, error: result.reason === 'failed' ? failure.code : result.reason.replace(/-/g, '_'), retryable: result.retryable })
    }
    return result
  }

  return {
    publish: (id, world, onProgress) => start(id, world, onProgress),
    ...(pool === undefined ? {} : { publishShared: (id: string, onProgress: (progress: PublishProgress) => void) => start(id, null, onProgress) }),
    stop() {
      running?.abort()
    }
  }
}
