// A refused `game.request` that the script catches and drops: the player
// pressed a key and nothing happened, and nothing said why.
//
// A warning, never a blocker — the scene builds and plays, and the runtime
// prints a card for the refusal anyway. This is the line that tells the author
// to show it to the player, which the runtime cannot do for them.
//
// Every project script is read, not only the placed ones: a game's client half
// usually lives in a helper module a placed script imports.
import { baseName } from '../../script/project-files'
import { swallowedRequests } from '../../script/swallowed-requests'
import { sceneScriptRows } from './scene-check-model'
import type { SceneCheck, SceneFinding } from './scene-checks'

export const REQUEST_CHECK_IDS = {
  /** a `game.request` whose rejection a `.catch` or `catch {}` drops without a word */
  swallowed: 'swallowed-request-error'
} as const

// A carried runtime module is the machinery, not the creator's code.
function isConsumerScript(path: string): boolean {
  return !path.includes('/runtime/')
}

const swallowedRequestError: SceneCheck = (ctx) => {
  const placedAt = new Map<string, string>()
  for (const row of sceneScriptRows(ctx.snapshot)) {
    if (row.entityId !== undefined && !placedAt.has(row.path)) placedAt.set(row.path, row.entityId)
  }
  const out: SceneFinding[] = []
  for (const [path, text] of Object.entries(ctx.scripts)) {
    if (!isConsumerScript(path)) continue
    const seen = new Set<string>()
    for (const found of swallowedRequests(text)) {
      const key = found.name ?? ''
      if (seen.has(key)) continue
      seen.add(key)
      const call = found.name === null ? 'game.request' : `game.request('${found.name}')`
      const where = found.form === 'catch' ? `The .catch on ${call}` : `The catch around ${call}`
      const entityId = placedAt.get(path)
      out.push({
        id: REQUEST_CHECK_IDS.swallowed,
        level: 'warning',
        title: `${baseName(path)} drops a refused request`,
        detail: `${where} neither tells the player nor logs: when the server refuses it or it times out, the player pressed a key and nothing happens. Show them why (a toast or a sound) and log it with console.warn.`,
        entityId,
        fix: entityId === undefined ? undefined : { label: 'Select entity', action: 'select-entity' }
      })
    }
  }
  return out
}

export const REQUEST_SCENE_CHECKS: ReadonlyArray<readonly [string, SceneCheck]> = [
  [REQUEST_CHECK_IDS.swallowed, swallowedRequestError]
]
