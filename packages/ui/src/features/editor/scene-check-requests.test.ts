import { describe, expect, it } from 'vitest'
import { BUILTIN_SCENE_CHECKS } from './scene-check-rules'
import { REQUEST_CHECK_IDS, REQUEST_SCENE_CHECKS } from './scene-check-requests'
import { check, context, entityScripts, scriptRow } from './scene-check-fixtures'

// requestUse as the assistant once wrote it (kitchenClient.ts).
const KITCHEN_CLIENT = `import { game } from './runtime/game'
import { msg } from './i18n'

let lastUse = 0
let busy = false
export function requestUse(station: string): void {
  const t = Date.now()
  if (busy || t - lastUse < 120) return
  lastUse = t
  busy = true
  game.request<{ ok: boolean; err?: MsgKey; sfx?: string }>('use', { s: station }).then((r) => {
    busy = false
    if (r === undefined || r === null) return
    if (!r.ok) { play('error', 0.6); if (r.err) showToast(msg(r.err)); return }
    const s = r.sfx !== undefined ? SFX[r.sfx] : undefined
    if (s !== undefined) play(s, 0.8, r.sfx === 'chop' ? 0.9 + Math.random() * 0.2 : 1)
  }).catch(() => { busy = false })
}
`
const CLIENT = 'src/scripts/kitchenClient.ts'
const DROPPED = '.catch(() => { busy = false })'
const run = check(REQUEST_CHECK_IDS.swallowed)

it('registers with the shared registry', () => {
  const rules = REQUEST_SCENE_CHECKS.map(([, rule]) => rule)
  const registered = BUILTIN_SCENE_CHECKS.filter(([, rule]) => rules.includes(rule))
  expect(registered.map(([id]) => id)).toEqual(Object.values(REQUEST_CHECK_IDS))
})

describe('a refused request the script drops', () => {
  it('flags a dropped requestUse, even in a helper no entity carries', () => {
    expect(run(context({ scripts: { [CLIENT]: KITCHEN_CLIENT } }))).toEqual([
      {
        id: 'swallowed-request-error',
        level: 'warning',
        title: 'kitchenClient.ts drops a refused request',
        detail:
          "The .catch on game.request('use') neither tells the player nor logs: when the server refuses it or it times out, the player pressed a key and nothing happens. Show them why (a toast or a sound) and log it with console.warn.",
        entityId: undefined,
        fix: undefined
      }
    ])
  })

  it('points at the entity when the script is placed', () => {
    const found = run(
      context({ snapshot: { '7': entityScripts([scriptRow(CLIENT)]) }, scripts: { [CLIENT]: KITCHEN_CLIENT } })
    )
    expect(found[0].entityId).toBe('7')
    expect(found[0].fix).toEqual({ label: 'Select entity', action: 'select-entity' })
  })

  it('goes quiet once the catch shows it, or hands it to a function', () => {
    const shown = KITCHEN_CLIENT.replace(DROPPED, ".catch((e) => { busy = false; showToast(msg('busy')) })")
    const handed = KITCHEN_CLIENT.replace(DROPPED, '.catch(retryLater)')
    expect(run(context({ scripts: { [CLIENT]: shown } }))).toEqual([])
    expect(run(context({ scripts: { [CLIENT]: handed } }))).toEqual([])
  })

  it('never reads a carried runtime module', () => {
    expect(run(context({ scripts: { 'src/scripts/runtime/outcomes.ts': KITCHEN_CLIENT } }))).toEqual([])
  })

  it('one line per file and message, however many calls drop it', () => {
    const twice = `${KITCHEN_CLIENT}\nexport function again() { game.request('use', {}).catch(() => {}) }\n`
    expect(run(context({ scripts: { [CLIENT]: twice } }))).toHaveLength(1)
  })
})
