import { entityName } from '@scene/custom-components'
import { isUiEntity, state } from '@scene/state'
import { isReservedEntity } from '@dcl-editor/contract'
import { attachScript, refreshScriptEverywhere } from '../script/attach'
import { attachablePath } from '../script/template'

export interface AttachedTo {
  id: string
  name: string
}

// One per turn, made when it starts: a script the assistant creates goes on the entity selected then.
// A rewrite refreshes the params on every entity running the script, whichever turn attached it.
export function scriptAttacher() {
  const target = state.activeEntity
  return async (path: string, content: string, created: boolean): Promise<AttachedTo | null> => {
    if (attachablePath(path) !== path) return null
    try {
      if (!created) {
        await refreshScriptEverywhere(path, content)
        return null
      }
      if (target === null || isReservedEntity(target) || state.snapshot[target] === undefined || isUiEntity(state.snapshot, target)) return null
      if (!(await attachScript(target, path, content))) return null
      return { id: target, name: entityName(state.snapshot, target) ?? `#${target}` }
    } catch (error) {
      console.error('could not attach the new script:', path, error)
      return null
    }
  }
}
