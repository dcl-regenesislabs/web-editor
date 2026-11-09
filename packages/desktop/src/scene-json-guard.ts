// scene.json is the source of truth for a scene's metadata. The scene's dev server runs the
// inspector's data layer (`--data-layer`), which loads assets/scene/main.composite and writes its
// copy of the metadata back over scene.json. At start it loads the composite's copy, runs migrations
// that flush the engine (the Tags one does whenever the root has no tags), and only then reads
// scene.json; the flushed copy reaches scene.json when its transaction lands after the providers are
// registered, which is a race on file timing. A composite holding the inspector's default copy (a
// one-parcel "Test Scene", or the one it creates when the scene has no composite) then overwrites
// the title, the parcels and the spawn points.
//
// So: the composite is fixed from scene.json before the server starts, the editor's own scene.json
// writes update both files, and while a scene is open a write that carries the inspector default is
// put back.
import fs from 'node:fs'
import path from 'node:path'
import { alignCompositeMetadata, guardSceneJsonWrite, type SceneJsonMetadata } from '@dcl-editor/contract'

// where the data layer reads and writes the composite (the inspector's own path)
const COMPOSITE = path.join('assets', 'scene', 'main.composite')

type Log = (line: string) => void

function readScene(dir: string): SceneJsonMetadata | null {
  try {
    const json: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8'))
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as SceneJsonMetadata) : null
  } catch {
    return null
  }
}

const sceneText = (scene: SceneJsonMetadata): string => JSON.stringify(scene, null, 2) + '\n'

// Each scene.json text the editor wrote on purpose, so the guard lets it through even when it
// is what a default copy would write (a creator may name a one-parcel scene "Test Scene").
const ownWrites = new Map<string, Set<string>>()

function noteOwnWrite(dir: string, text: string): void {
  const key = path.resolve(dir)
  const set = ownWrites.get(key) ?? new Set<string>()
  set.add(text)
  ownWrites.set(key, set)
}

function takeOwnWrite(dir: string, text: string): boolean {
  return ownWrites.get(path.resolve(dir))?.delete(text) ?? false
}

// Point the composite's copy at scene.json. Returns whether the composite was written.
export function alignComposite(dir: string, scene: SceneJsonMetadata, log?: Log): boolean {
  const file = path.join(dir, COMPOSITE)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const aligned = alignCompositeMetadata(text, scene)
  if (aligned === null) return false
  fs.writeFileSync(file, aligned)
  log?.(`· main.composite scene metadata set from scene.json (${scene.display?.title ?? ''})`)
  return true
}

// Before the scene's server starts. A scene with no composite gets the template's, with its own
// metadata, instead of the default copy the data layer would create.
export function alignSceneOnOpen(dir: string, templateComposite: string | null, log?: Log): void {
  const scene = readScene(dir)
  if (scene === null) return
  const file = path.join(dir, COMPOSITE)
  if (!fs.existsSync(file) && templateComposite !== null) {
    try {
      const aligned = alignCompositeMetadata(fs.readFileSync(templateComposite, 'utf8'), scene)
      if (aligned !== null) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, aligned)
        log?.('· main.composite created with the scene metadata of scene.json')
      }
    } catch (e) {
      log?.(`⚠ could not create main.composite: ${String(e)}`)
    }
    return
  }
  alignComposite(dir, scene, log)
}

// The editor's own scene.json writes (Scene settings, Rename, the world name): scene.json, and
// the composite's copy with it.
export function writeSceneJson(dir: string, scene: SceneJsonMetadata): void {
  const text = sceneText(scene)
  noteOwnWrite(dir, text)
  fs.writeFileSync(path.join(dir, 'scene.json'), text)
  alignComposite(dir, scene)
}

export function renameScene(dir: string, title: string): void {
  const scene = readScene(dir)
  if (scene === null) throw new Error(`${dir} has no readable scene.json`)
  writeSceneJson(dir, { ...scene, display: { ...(scene.display ?? {}), title: title.trim() } })
}

export interface SceneJsonGuard {
  // look at scene.json now (the watcher calls it; tests call it directly)
  check(): void
  close(): void
}

// While a scene is open: every scene.json change is compared with the last one kept, and one that
// carries the inspector default goes back to it.
export function guardSceneJson(dir: string, log: Log, watch = true): SceneJsonGuard {
  ownWrites.delete(path.resolve(dir))
  let kept = readScene(dir)
  const check = (): void => {
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')
    } catch {
      return
    }
    const next = readScene(dir)
    if (next === null) return
    if (takeOwnWrite(dir, text) || kept === null) {
      kept = next
      return
    }
    const repaired = guardSceneJsonWrite(kept, next)
    if (repaired === null) {
      kept = next
      return
    }
    log(`⚠ scene.json was overwritten with the inspector's default scene metadata; put back "${repaired.display?.title ?? ''}" (${(repaired.scene?.parcels ?? []).length} parcels)`)
    writeSceneJson(dir, repaired)
    kept = repaired
  }
  let watcher: fs.FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  if (watch) {
    try {
      // the folder, not the file: a write that replaces the file would end a watch on it
      watcher = fs.watch(dir, (_event, name) => {
        if (name !== null && name.toString() !== 'scene.json') return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          check()
        }, 50)
      })
      watcher.on('error', (e) => log(`⚠ scene.json watch stopped: ${String(e)}`))
    } catch (e) {
      log(`⚠ could not watch scene.json: ${String(e)}`)
    }
  }
  return {
    check,
    close: () => {
      if (timer !== null) clearTimeout(timer)
      watcher?.close()
    }
  }
}
