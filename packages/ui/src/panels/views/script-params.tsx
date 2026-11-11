import { useEffect, useState, type ReactNode } from 'react'
// The field editors behind a script's params — one row per constructor param,
// typed by what the parser read out of the signature. Split out of script-view
// so the view stays about files (create, attach, rename, run order) and this
// stays about values.
//
// `prefab` / `prefabList` are the Spawnable-prefab pickers: the layout stores a
// prefab UUID, the creator sees names. Option building lives in prefab-options.ts.
import { state, type Snapshot } from '@scene/state'
import { entityName } from '@scene/custom-components'
import { useStore } from '../../core/store'
import type { ScriptParam, ScriptValue } from '../../script/parser'
import { IconButton, MultiSelect, Select, Slider, TextInput, Toggle, type SelectOption } from '../../ds'
import { prettyLabel } from '../fields'
import { prefabStore, refreshPrefabs } from '../prefab-store'
import { NO_SPAWNABLES_YET } from '../../prefabs/copy'
import { paramHint } from './param-visibility'
import { hasSpawnablePrefabs, prefabRefOptions, refOf, refsOf } from './prefab-options'
import { NamedEntityPicker } from './named-entity-picker'
import { actionNames } from './admin-tools'

// Numbers are plain text inputs, not type="number": a native number field renders
// its value through the OS locale, so 0.3 shows as "0,3" wherever the decimal mark
// is a comma and reads like a typo. Displaying String(value) keeps the dot, and a
// comma typed by hand is still accepted here.
function parseNumeric(raw: string): number | null {
  const v = parseFloat(raw.trim().replace(',', '.'))
  return Number.isFinite(v) ? v : null
}

const isRecord = (value: ScriptValue | undefined): value is { [key: string]: ScriptValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function ParamField(props: {
  name: string
  param: ScriptParam
  onChange: (value: ScriptParam['value']) => void
  enumLabels?: Readonly<Record<string, string>>
  enumHints?: Readonly<Record<string, string>>
  // the other members of the object this param sits in, for `@actionsOf`
  siblings?: Readonly<Record<string, ScriptValue>>
  // shown after the control, e.g. a list row's remove button
  trailing?: ReactNode
  label?: string
}): JSX.Element {
  const { name, param, onChange, enumLabels, enumHints, siblings } = props
  const realName = param.optional === true ? `${name} (optional)` : name
  const tip = param.description === undefined ? realName : `${realName} — ${param.description}`
  const hint = param.type === 'enum' ? enumHints?.[String(param.value)] : undefined
  const actionsOf = param.type === 'string' && param.actionsOf !== undefined ? siblings?.[param.actionsOf] : undefined
  const pickAction = typeof actionsOf === 'number'
  return (
    <>
      <div className="eui-prop">
        <span className="plabel param" data-tip={tip}>
          {props.label ?? prettyLabel(name)}
        </span>
        <div className="pvalue">
          {param.type === 'number' && (
            <input
              key={String(param.value)}
              className="eui-num"
              inputMode="decimal"
              spellCheck={false}
              defaultValue={String(param.value)}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                const v = parseNumeric(e.target.value)
                if (v !== null && v !== param.value) onChange(v)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
          )}
          {param.type === 'slider' && <SliderParam name={name} param={param} onChange={onChange} />}
          {param.type === 'string' && param.control === undefined && pickAction && (
            <ActionPicker name={name} entity={actionsOf} value={String(param.value)} onChange={onChange} />
          )}
          {param.type === 'string' && param.control === undefined && !pickAction && (
            <TextInput
              key={String(param.value)}
              placeholder={param.format === 'wallet' ? '0x…' : undefined}
              defaultValue={param.value as string}
              onBlur={(e) => {
                if (e.target.value !== param.value) onChange(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
          )}
          {param.type === 'string' && param.control === 'color' && <>
            <input type="color" className="eui-color-swatch" aria-label={`${name} color`} value={String(param.value)} onChange={(e) => onChange(e.target.value)} />
            <TextInput key={String(param.value)} defaultValue={String(param.value)} aria-label={`${name} hex`}
              onBlur={(e) => {
                if (/^#[\da-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toUpperCase())
                else e.target.value = String(param.value)
              }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          </>}
          {param.type === 'string' && param.control !== undefined && param.control !== 'color' && (
            <NamedEntityPicker name={name} value={String(param.value)} multiple={param.control === 'entityNames' || param.control === 'zones'}
              zones={param.control === 'zone' || param.control === 'zones'} onChange={onChange} />
          )}
          {param.type === 'boolean' && (
            <Toggle size="sm" checked={param.value === true} onChange={(v) => onChange(v)} />
          )}
          {param.type === 'enum' && (
            <Select
              compact
              value={String(param.value)}
              options={(param.options ?? []).map((o) => ({ value: o, label: enumLabels?.[o] ?? o }))}
              onChange={(v) => onChange(v)}
              aria-label={name}
            />
          )}
          {param.type === 'entity' && (
            <EntityPicker value={Number(param.value)} noneHint={paramHint(param)} components={param.components} onChange={(v) => onChange(v)} />
          )}
          {param.type === 'prefab' && (
            <PrefabPicker name={name} value={refOf(param.value)} onChange={(v) => onChange(v)} />
          )}
          {param.type === 'prefabList' && (
            <PrefabListPicker name={name} value={refsOf(param.value)} onChange={(v) => onChange(v)} />
          )}
          {param.type === 'action' && (
            <span
              className="eui-script-dim"
              data-tip="ActionCallback params connect to the smart-items Actions system, which this editor does not use."
            >
              action callback — unsupported
            </span>
          )}
          {param.type === 'object' && <span className="eui-script-dim">{Object.keys(param.fields ?? {}).length} settings</span>}
          {param.type === 'array' && <ListHeader name={name} param={param} onChange={onChange} />}
          {props.trailing}
        </div>
      </div>
      {hint !== undefined && hint !== '' && <div className="eui-param-hint">{hint}</div>}
      {param.type === 'object' && <ObjectFields param={param} onChange={onChange} />}
      {param.type === 'array' && <ListRows name={name} param={param} onChange={onChange} />}
    </>
  )
}

// Commits once the drag ends, not on every step: each commit is a component
// write and an undo step.
function SliderParam(props: { name: string; param: ScriptParam; onChange: (v: number) => void }): JSX.Element {
  const { param } = props
  const committed = typeof param.value === 'number' ? param.value : (param.min ?? 0)
  const [draft, setDraft] = useState(committed)
  useEffect(() => setDraft(committed), [committed])
  const commit = (): void => {
    if (draft !== committed) props.onChange(draft)
  }
  return (
    <span className="eui-script-slider" onPointerUp={commit} onKeyUp={commit} onBlur={commit}>
      <Slider value={draft} min={param.min} max={param.max} step={param.step} onChange={setDraft} aria-label={props.name} />
      <span className="eui-script-dim">{draft}</span>
    </span>
  )
}

function ObjectFields(props: { param: ScriptParam; onChange: (v: ScriptValue) => void }): JSX.Element {
  const value = isRecord(props.param.value) ? props.param.value : {}
  return (
    <div className="eui-param-group">
      {Object.entries(props.param.fields ?? {}).map(([key, field]) => (
        <ParamField
          key={key}
          name={key}
          param={{ ...field, value: value[key] ?? field.value }}
          siblings={value}
          onChange={(v) => props.onChange({ ...value, [key]: v })}
        />
      ))}
    </div>
  )
}

function ListHeader(props: { name: string; param: ScriptParam; onChange: (v: ScriptValue[]) => void }): JSX.Element {
  const rows = Array.isArray(props.param.value) ? props.param.value : []
  const item = props.param.item
  return (
    <>
      <span className="eui-script-dim">{rows.length === 0 ? 'none yet' : `${rows.length}`}</span>
      {item !== undefined && (
        <IconButton tip={`Add to ${prettyLabel(props.name)}`} aria-label={`add ${props.name}`} onClick={() => props.onChange([...rows, item.value])}>
          +
        </IconButton>
      )}
    </>
  )
}

function ListRows(props: { name: string; param: ScriptParam; onChange: (v: ScriptValue[]) => void }): JSX.Element | null {
  const rows = Array.isArray(props.param.value) ? props.param.value : []
  const item = props.param.item
  if (item === undefined || rows.length === 0) return null
  return (
    <div className="eui-param-group">
      {rows.map((row, i) => (
        <ParamField
          key={i}
          name={`${props.name}[${i}]`}
          label={`${i + 1}`}
          param={{ ...item, value: row }}
          onChange={(v) => props.onChange(rows.map((r, j) => (j === i ? v : r)))}
          trailing={
            <IconButton tip="Remove" aria-label={`remove ${props.name} ${i + 1}`} onClick={() => props.onChange(rows.filter((_, j) => j !== i))}>
              ×
            </IconButton>
          }
        />
      ))}
    </div>
  )
}

// `@actionsOf <key>`: the actions authored on the entity the sibling field holds
function ActionPicker(props: { name: string; entity: number; value: string; onChange: (v: string) => void }): JSX.Element {
  const components = useStore(() => state.snapshot[String(props.entity)])
  const names = actionNames(components)
  if (names.length === 0) return <span className="eui-script-dim">no actions on that entity</span>
  const options = names.map((n) => ({ value: n, label: n }))
  if (props.value !== '' && !names.includes(props.value)) options.unshift({ value: props.value, label: `${props.value} (missing)` })
  return <Select compact value={props.value} options={[{ value: '', label: 'none' }, ...options]} onChange={props.onChange} aria-label={props.name} />
}

function EntityPicker(props: {
  value: number
  noneHint?: string
  // `@components`: only entities carrying one of these
  components?: string[]
  onChange: (v: number) => void
}): JSX.Element {
  const snapshot = useStore(() => state.snapshot)
  const wanted = props.components
  const named = Object.keys(snapshot)
    .filter((id) => Number.isFinite(Number(id)) && Number(id) !== 0)
    .filter((id) => wanted === undefined || wanted.some((c) => snapshot[id][c] !== undefined))
    .map((id) => ({ id, name: entityName(snapshot as Snapshot, id) }))
    .filter((row): row is { id: string; name: string } => row.name !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))
  const options: SelectOption[] = [
    { value: '0', label: 'none', hint: props.noneHint },
    ...named.map((row) => ({ value: row.id, label: row.name, hint: `#${row.id}` }))
  ]
  if (!options.some((o) => o.value === String(props.value))) {
    options.splice(1, 0, { value: String(props.value), label: `#${props.value}`, hint: 'unnamed' })
  }
  return (
    <Select
      compact
      value={String(props.value)}
      options={options}
      onChange={(v) => props.onChange(Number(v))}
      aria-label="entity"
    />
  )
}

function PrefabPicker(props: { name: string; value: string; onChange: (v: string) => void }): JSX.Element {
  const items = useStore(() => prefabStore.items)
  useEffect(() => {
    void refreshPrefabs()
  }, [])
  const selected = props.value === '' ? [] : [props.value]
  if (!hasSpawnablePrefabs(items) && selected.length === 0) {
    return <span className="eui-script-dim">{NO_SPAWNABLES_YET}</span>
  }
  return (
    <Select
      compact
      value={props.value}
      options={prefabRefOptions(items, selected, true)}
      onChange={props.onChange}
      aria-label={props.name}
    />
  )
}

function PrefabListPicker(props: {
  name: string
  value: string[]
  onChange: (v: string[]) => void
}): JSX.Element {
  const items = useStore(() => prefabStore.items)
  if (!hasSpawnablePrefabs(items) && props.value.length === 0) {
    return <span className="eui-script-dim">{NO_SPAWNABLES_YET}</span>
  }
  return (
    <MultiSelect
      density="compact"
      value={props.value}
      options={prefabRefOptions(items, props.value)}
      onChange={props.onChange}
      aria-label={props.name}
    />
  )
}
