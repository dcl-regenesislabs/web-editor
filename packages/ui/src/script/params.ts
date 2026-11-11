// Batch parameter changes into one component write and one undo step.
import { state, componentKey } from '@scene/state'
import { entityName } from '@scene/custom-components'
import { SCRIPT_COMPONENT } from '@scene/allowed-components'
import { uiSetComponentValue } from '../actions/components'
import { resolvePrefabRef, type ParamValue, type PrefabRefChoice } from '../ai/request-format'
import { scriptItems } from './attach'
import { parseLayout, type ScriptLayout, type ScriptParam } from './parser'

type Coerced = { value: ScriptParam['value'] } | { problem: string }

function labelOf(entityId: string): string {
  return entityName(state.snapshot, entityId) ?? `#${entityId}`
}

// One prefab name from the assistant → the UUID a `PrefabRef` param stores.
function coerceRef(value: ParamValue, prefabs: PrefabRefChoice[]): { id: string } | { problem: string } {
  if (typeof value !== 'string') return { problem: 'expects one prefab name, not a list' }
  return resolvePrefabRef(value, prefabs)
}

function coerceEntity(value: ParamValue): Coerced {
  if (value === 0 || value === '0' || value === '') return { value: 0 }
  if (typeof value !== 'string' && typeof value !== 'number') return { problem: 'expects an entity name or ID' }
  const ref = String(value).trim()
  const matches = state.snapshot[ref] !== undefined ? [ref] : Object.keys(state.snapshot).filter((id) =>
    entityName(state.snapshot, id)?.trim().toLowerCase() === ref.toLowerCase())
  if (matches.length === 0) return { problem: `references an entity that does not exist: "${ref}"` }
  if (matches.length > 1) return { problem: `references an ambiguous entity name: "${ref}"; use its ID` }
  const id = Number(matches[0])
  return Number.isSafeInteger(id) && id > 0 ? { value: id } : { problem: 'references an invalid entity ID' }
}

// A request carries JSON scalars; a param carries a declared type. Coerce where
// the intent is unambiguous, refuse WITH A REASON where it isn't — a silently
// wrong enum is the failure mode this whole feature exists to avoid, and a
// refusal the assistant cannot read is one it will repeat next turn.
function coerce(param: ScriptParam, value: ParamValue, prefabs: PrefabRefChoice[]): Coerced {
  switch (param.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? { value: n } : { problem: `expects a number, not ${JSON.stringify(value)}` }
    }
    case 'slider': {
      const n = typeof value === 'number' ? value : Number(value)
      const min = param.min ?? -Infinity
      const max = param.max ?? Infinity
      if (!Number.isFinite(n)) return { problem: `expects a number, not ${JSON.stringify(value)}` }
      return n >= min && n <= max ? { value: n } : { problem: `expects a number from ${min} to ${max}` }
    }
    case 'boolean':
      if (typeof value === 'boolean') return { value }
      if (value === 'true') return { value: true }
      if (value === 'false') return { value: false }
      return { problem: 'expects true or false' }
    case 'enum': {
      const s = String(value)
      if (param.options?.includes(s) === true) return { value: s }
      return { problem: `only accepts ${(param.options ?? []).map((o) => `"${o}"`).join(', ')}` }
    }
    case 'string':
      if (param.control === 'color' && (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value))) {
        return { problem: 'expects a color in #RRGGBB format' }
      }
      return { value: Array.isArray(value) ? value.join(', ') : String(value) }
    case 'entity':
      return coerceEntity(value)
    case 'prefab': {
      const resolved = coerceRef(value, prefabs)
      return 'problem' in resolved ? resolved : { value: resolved.id }
    }
    case 'prefabList': {
      // A comma-separated string is what a pre-typed layout held, so both read.
      const wanted = Array.isArray(value) ? value : String(value).split(',')
      const ids: string[] = []
      for (const entry of wanted) {
        const resolved = coerceRef(entry, prefabs)
        if ('problem' in resolved) return resolved
        if (resolved.id !== '' && !ids.includes(resolved.id)) ids.push(resolved.id)
      }
      return { value: ids }
    }
    case 'object':
    case 'array':
      return { problem: `is a ${param.type === 'object' ? 'group of settings' : 'list'}, which only the inspector can set` }
    case 'action':
      return { problem: 'is an action picker, which only the inspector can set' }
  }
}

// Set params by name across whichever of the entity's scripts declare them,
// through the Script component's own update path (the same write the inspector's
// param fields and its ↻ refresh make). Answers with the names that landed, so a
// caller can say what it actually changed.
async function applyParams<V>(
  entityId: string,
  values: Record<string, V>,
  resolve: (param: ScriptParam, value: V) => Coerced,
  problems: string[]
): Promise<string[]> {
  const items = scriptItems(entityId)
  if (items.length === 0) {
    problems.push(`"${labelOf(entityId)}" has no script, so its settings were left alone`)
    return []
  }
  // A param that exists but would not take the value gets ITS OWN reason;
  // "no setting called X" is reserved for a name no script on the entity has.
  const missing = new Set(Object.keys(values))
  const refused = new Map<string, string>()
  let changed = false
  const next = items.map((item) => {
    const layout = parseLayout(item.layout)
    if (layout === undefined) return item
    const params = { ...layout.params }
    let touched = false
    for (const [name, value] of Object.entries(values)) {
      const param = params[name]
      if (param === undefined) continue
      const coerced = resolve(param, value)
      if ('problem' in coerced) {
        refused.set(name, coerced.problem)
        continue
      }
      missing.delete(name)
      refused.delete(name)
      params[name] = { ...param, value: coerced.value }
      touched = true
    }
    if (!touched) return item
    changed = true
    const updated: ScriptLayout = { ...layout, params }
    return { ...item, layout: JSON.stringify(updated) }
  })
  if (changed) {
    await uiSetComponentValue(
      componentKey(entityId, SCRIPT_COMPONENT),
      entityId,
      SCRIPT_COMPONENT,
      JSON.stringify({ value: next })
    )
  }
  for (const name of missing) {
    const reason = refused.get(name)
    problems.push(
      reason === undefined
        ? `"${labelOf(entityId)}" has no setting called "${name}"`
        : `"${name}" on "${labelOf(entityId)}" ${reason}`
    )
  }
  return Object.keys(values).filter((name) => !missing.has(name))
}

/** Resolves typed values and references, then writes. */
export async function setScriptParams(
  entityId: string,
  values: Record<string, ParamValue>,
  prefabs: PrefabRefChoice[],
  problems: string[]
): Promise<string[]> {
  return applyParams(entityId, values, (param, value) => coerce(param, value, prefabs), problems)
}

/** Values already resolved by an inspector gesture, written as given. */
export async function writeScriptParamValues(
  entityId: string,
  values: Record<string, ScriptParam['value']>,
  problems: string[]
): Promise<string[]> {
  return applyParams(entityId, values, (_param, value) => ({ value }), problems)
}
