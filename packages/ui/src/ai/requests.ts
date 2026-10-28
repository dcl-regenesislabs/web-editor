// The batch scene changes behind scene_request's placePrefab, setParams and
// attachScript: placing a prefab, naming it, sizing it, setting a script param
// on it or on something already placed, attaching a script to a named entity.
//
// One thing is resolved rather than copied: a `PrefabRef` param stores a prefab
// UUID and the assistant only ever sees NAMES, so a name arrives here and
// request-format's resolvePrefabRef turns it into an id — refusing, with the
// reason, when the name is unknown, shared by two prefabs, or points at a prefab
// that is not Spawnable.
//
// Two rules make this safe. Every mutation runs through the same click path a
// human uses (uiPlaceLibraryPrefab / uiSetComponentValue / attachScript), so undo,
// autosave and the bus mirror come for free and there is no invertible-manifest
// machinery to get wrong. And every failure is local: an unknown request type or
// an entity name that doesn't resolve skips that one request and adds a notice
// line — the rest of the batch still lands.
import { state } from '@scene/state'
import { entityName } from '@scene/custom-components'
import { type PrefabPlacement, uiPlaceLibraryPrefab, uiPlacePrefab } from '../actions/prefabs'
import { uiSyncSpawnSpotFromSnapshot } from '../actions/spawn-spot'
import { prefabStore, refreshLibrary, refreshPrefabs } from '../panels/prefab-store'
import { revealInTree } from '../panels/reveal'
import { setScriptParams } from '../script/params'
import { attachScript } from '../script/attach'
import { baseName } from '../script/project-files'
import { log } from '../log'
import {
  parseRequests,
  resolveEntityRef,
  resolvePrefabSource,
  type AttachScriptRequest,
  type PlacePrefabRequest,
  type PrefabRefChoice,
  type SetParamsRequest
} from './request-format'

/** One line for the turn's tool strip, in the shape AiPanel already renders. */
export interface RequestOutcome {
  tool: string
  detail: string
}

export interface RequestRun {
  outcomes: RequestOutcome[]
  /** Things that were skipped — surfaced once, as a single notice. */
  problems: string[]
  /** Scripts a request attached. */
  attached: string[]
}

function labelOf(entityId: string): string {
  return entityName(state.snapshot, entityId) ?? `#${entityId}`
}

function prefabChoices(): PrefabRefChoice[] {
  return prefabStore.items.map((item) => ({
    id: item.data.id,
    name: item.data.name,
    folder: item.folder
  }))
}

async function prefabSources(): Promise<{ folders: string[]; refs: string[] }> {
  await refreshLibrary()
  return {
    folders: prefabStore.items.map((item) => item.folder),
    refs: prefabStore.library.map((entry) => entry.ref)
  }
}

async function runPlace(
  request: PlacePrefabRequest,
  sources: { folders: string[]; refs: string[] },
  out: RequestRun
): Promise<void> {
  const source = resolvePrefabSource(request.slug, sources.folders, sources.refs)
  if (source === null) {
    out.problems.push(`there is no "${request.slug}" prefab, so nothing was placed`)
    return
  }
  const placement: PrefabPlacement = {
    position: request.position,
    scale: request.scale,
    name: request.name
  }
  const rootId =
    source.kind === 'library'
      ? await uiPlaceLibraryPrefab(source.ref, 'assistant', placement)
      : await uiPlacePrefab(source.folder, 'assistant', placement)
  if (rootId === null) {
    out.problems.push(`"${request.slug}" could not be placed`)
    return
  }
  out.outcomes.push({ tool: 'Placed', detail: labelOf(rootId) })
  // Read AFTER the placement: a library prefab copies itself into the project on
  // the way in, so an earlier request this turn may have added the very prefab a
  // later param names.
  if (request.params !== undefined) {
    const applied = await setScriptParams(rootId, request.params, prefabChoices(), out.problems)
    // The inspector's dropdown materializes the Spawn Spot marker; a param the
    // assistant writes must land the same way or 'custom spot' silently means
    // nothing until a human re-picks it.
    await uiSyncSpawnSpotFromSnapshot(rootId, applied)
  }
  // Instantiation already revealed it, but that fires before the snapshot has the
  // new entity, so the tree had nothing to scroll to yet. Ask again now the row
  // exists — same signal a manual placement uses, so the assistant's add lands on
  // the same visible row.
  revealInTree(rootId)
}

async function runAttach(
  request: AttachScriptRequest,
  fallbackTarget: string | null,
  out: RequestRun
): Promise<void> {
  // The AI naming a target is the point: with nothing selected, the script still
  // lands on the door the roster told it about.
  const target = request.to === undefined ? fallbackTarget : resolveEntityRef(state.snapshot, request.to)
  if (target === null || state.snapshot[target] === undefined) {
    out.problems.push(
      request.to === undefined
        ? `nothing was selected, so ${baseName(request.script)} was left unattached`
        : `there is no entity called "${request.to}", so ${baseName(request.script)} was left unattached`
    )
    return
  }
  out.attached.push(request.script)
  if (await attachScript(target, request.script)) {
    out.outcomes.push({ tool: 'Attached', detail: `${baseName(request.script)} to ${labelOf(target)}` })
  }
}

async function runSetParams(request: SetParamsRequest, out: RequestRun): Promise<void> {
  const target = resolveEntityRef(state.snapshot, request.to)
  if (target === null || state.snapshot[target] === undefined) {
    out.problems.push(`there is no entity called "${request.to}", so its settings were left alone`)
    return
  }
  const applied = await setScriptParams(target, request.params, prefabChoices(), out.problems)
  await uiSyncSpawnSpotFromSnapshot(target, applied)
  if (applied.length > 0) {
    out.outcomes.push({ tool: 'Set', detail: `${applied.join(', ')} on ${labelOf(target)}` })
  }
}

export async function runRequestText(text: string, fallbackTarget: string | null): Promise<RequestRun> {
  const parsed = parseRequests(text)
  const out: RequestRun = { outcomes: [], problems: [...parsed.problems], attached: [] }
  if (parsed.requests.length === 0) return out

  // Any param may be a PrefabRef, so the project's prefabs are read whenever a
  // request carries settings; the library (a second, slower round trip) only
  // when something is actually being placed.
  const placing = parsed.requests.some((r) => r.type === 'placePrefab')
  const needsPrefabs = placing || parsed.requests.some((r) => r.type === 'setParams')
  if (needsPrefabs) await refreshPrefabs()
  const sources = placing ? await prefabSources() : { folders: [], refs: [] }

  for (const request of parsed.requests) {
    try {
      if (request.type === 'placePrefab') await runPlace(request, sources, out)
      else if (request.type === 'setParams') await runSetParams(request, out)
      else await runAttach(request, fallbackTarget, out)
    } catch (e) {
      log.error('assistant request failed', request, e)
      out.problems.push(`one of the assistant's changes failed: ${String(e)}`)
    }
  }
  return out
}
