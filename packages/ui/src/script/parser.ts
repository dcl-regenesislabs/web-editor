// Parses a script's constructor (or `export function start`) signature into the
// typed param layout the Script inspector renders — the same contract the
// Creator Hub uses, so layouts round-trip between the two. Ported from
// @dcl/inspector's ScriptInspector/parser.ts and kept in step with it: Slider
// and negative defaults (creator-hub#1513), `@event` (#1604), object and array
// params (#1667), `@components` / `@actionsOf` / `@format wallet` (#1748).
// Deliberate forks, which Creator Hub reads as plain strings: `PrefabRef`
// pickers, the ColorHex/EntityName/ZoneName controls, a description from each
// param's own JSDoc, and a mergeLayout that keeps a stored value only where it
// still fits the fresh type. No @dcl/ecs import (RootEntity = 0).
import { parse } from '@babel/parser'
import type {
  ClassMethod,
  Expression,
  Identifier,
  TSParameterProperty,
  TSType,
  TSTypeAnnotation
} from '@babel/types'

type FunctionParameter = ClassMethod['params'][number]
type Comments = { type: string; value: string }[] | null | undefined

export type ActionRef = { entity: number; action: string }

// The plain JSON a layout hands the constructor, nested for object and array
// params; an 'action' param's ActionRef is one of its objects.
export type ScriptValue = number | boolean | string | ScriptValue[] | { [key: string]: ScriptValue }

export type ScriptParam = {
  type:
    | 'number'
    | 'slider'
    | 'boolean'
    | 'string'
    | 'entity'
    | 'action'
    | 'enum'
    | 'prefab'
    | 'prefabList'
    | 'object'
    | 'array'
  value: ScriptValue
  optional?: boolean
  control?: 'color' | 'entityName' | 'entityNames' | 'zone' | 'zones'
  // for 'enum': the string-literal union members, in declaration order
  options?: string[]
  // the param's JSDoc line, carried into the layout so the inspector can show it
  description?: string
  // for 'slider': the range `Slider<min, max, step>` declares
  min?: number
  max?: number
  step?: number
  // for 'object': one param per member of the inline type literal. Editor-only:
  // the runtime receives `value`, never this.
  fields?: Record<string, ScriptParam>
  // for 'array': what one element is, and what a new row starts as
  item?: ScriptParam
  // `@components a, b` on an 'entity': only entities carrying one of these can be picked
  components?: string[]
  // `@actionsOf <key>` on a 'string': names an action of the entity in sibling field <key>
  actionsOf?: string
  // `@format wallet` on a 'string': an Ethereum address
  format?: 'wallet'
}

// `PrefabRef` (and `PrefabRef[]`) is a deliberate, documented fork from Creator
// Hub parser parity: the generated src/scripts/spawnables.ts exports it as a
// branded string, scripts annotate a param with it, and the inspector renders a
// picker over Spawnable prefabs instead of a text field. The value stored is the
// prefab's UUID. `PrefabRef[]` stays 'prefabList', ahead of the generic array.
const PREFAB_REF = 'PrefabRef'
const ARRAY_TYPES = ['Array', 'ReadonlyArray']
const SLIDER_DEFAULT_STEP = 1

export type ScriptAction = {
  methodName: string
  description?: string
  params: Record<string, ScriptParam>
}

export type ScriptLayout = {
  params: Record<string, ScriptParam>
  actions?: ScriptAction[]
  // the `@event <name>` tags a script declares; Creator Hub's Reactions hook them
  events?: string[]
  error?: string
}

const ROOT_ENTITY = 0
const AUTHORING_CONTROLS: Record<string, ScriptParam['control']> = {
  ColorHex: 'color', EntityName: 'entityName', EntityNames: 'entityNames', ZoneName: 'zone', ZoneNames: 'zones'
}

function isRecord(value: unknown): value is { [key: string]: ScriptValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A default expression as the plain JSON it denotes; undefined for anything not
// statically evaluable (a call, an identifier, a spread).
function evaluateLiteral(expression: Expression): ScriptValue | undefined {
  switch (expression.type) {
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'StringLiteral':
      return expression.value
    case 'UnaryExpression':
      return expression.operator === '-' && expression.argument.type === 'NumericLiteral'
        ? -expression.argument.value
        : undefined
    // `clickable: Entity = 0 as Entity` — `Entity` is a branded number, so the
    // only way to write its default is a cast. Without unwrapping it the default
    // falls through to '' and an `entity` param ships holding a string, which no
    // runtime compare against an entity id can ever match.
    case 'TSAsExpression':
      return evaluateLiteral(expression.expression)
    case 'ObjectExpression': {
      const object: { [key: string]: ScriptValue } = {}
      for (const prop of expression.properties) {
        if (prop.type !== 'ObjectProperty' || prop.computed) continue
        const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : undefined
        if (key === undefined || !isExpression(prop.value)) continue
        const value = evaluateLiteral(prop.value)
        if (value !== undefined) object[key] = value
      }
      return object
    }
    case 'ArrayExpression': {
      const array: ScriptValue[] = []
      for (const element of expression.elements) {
        if (element === null || element.type === 'SpreadElement') continue
        const value = evaluateLiteral(element)
        if (value !== undefined) array.push(value)
      }
      return array
    }
  }
  return undefined
}

function isExpression(node: { type: string }): node is Expression {
  return !['ObjectPattern', 'ArrayPattern', 'AssignmentPattern', 'RestElement'].includes(node.type)
}

// The shape a value with no type annotation implies, so the editor can still
// render its members or rows.
function inferParam(value: ScriptValue): ScriptParam {
  if (typeof value === 'number') return { type: 'number', value }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'string') return { type: 'string', value }
  if (Array.isArray(value)) {
    return { type: 'array', value, item: value.length > 0 ? inferParam(value[0]) : { type: 'string', value: '' } }
  }
  const fields: Record<string, ScriptParam> = {}
  for (const [key, field] of Object.entries(value)) fields[key] = inferParam(field)
  return { type: 'object', value, fields }
}

function getValueAndTypeFromExpression(expression: Expression): ScriptParam {
  const value = evaluateLiteral(expression)
  return value === undefined ? { type: 'string', value: '' } : inferParam(value)
}

// `-90` in a type position is a unary expression around the literal
function numericLiteral(type: TSType): number | undefined {
  if (type.type !== 'TSLiteralType') return undefined
  const literal = type.literal
  if (literal.type === 'NumericLiteral') return literal.value
  if (literal.type === 'UnaryExpression' && literal.operator === '-' && literal.argument.type === 'NumericLiteral') {
    return -literal.argument.value
  }
  return undefined
}

// `Slider<min, max, step>`; without valid literal bounds it is a plain number
function sliderParam(args: TSType[]): ScriptParam {
  const min = args.length > 0 ? numericLiteral(args[0]) : undefined
  const max = args.length > 1 ? numericLiteral(args[1]) : undefined
  const step = args.length > 2 ? numericLiteral(args[2]) : SLIDER_DEFAULT_STEP
  if (min === undefined || max === undefined || step === undefined || min >= max || step <= 0) {
    return { type: 'number', value: 0 }
  }
  return { type: 'slider', value: min, min, max, step }
}

function isPrefabRefType(typeAnnotation: TSType): boolean {
  return (
    typeAnnotation.type === 'TSTypeReference' &&
    typeAnnotation.typeName.type === 'Identifier' &&
    typeAnnotation.typeName.name === PREFAB_REF
  )
}

// `T[]` and `Array<T>` — the same list, written two ways; undefined when not a list.
function listElement(typeAnnotation: TSType): TSType | null | undefined {
  if (typeAnnotation.type === 'TSArrayType') return typeAnnotation.elementType
  if (
    typeAnnotation.type === 'TSTypeReference' &&
    typeAnnotation.typeName.type === 'Identifier' &&
    ARRAY_TYPES.includes(typeAnnotation.typeName.name)
  ) {
    return typeAnnotation.typeParameters?.params[0] ?? null
  }
  return undefined
}

function getValueAndTypeFromType(typeAnnotation: TSType): ScriptParam {
  const element = listElement(typeAnnotation)
  if (element !== undefined) {
    if (element !== null && isPrefabRefType(element)) return { type: 'prefabList', value: [] }
    return { type: 'array', value: [], item: element === null ? { type: 'string', value: '' } : getValueAndTypeFromType(element) }
  }
  switch (typeAnnotation.type) {
    case 'TSNumberKeyword':
      return { type: 'number', value: 0 }
    case 'TSBooleanKeyword':
      return { type: 'boolean', value: false }
    case 'TSTypeReference':
      if (typeAnnotation.typeName.type === 'Identifier') {
        const name = typeAnnotation.typeName.name
        const control = AUTHORING_CONTROLS[name]
        if (control !== undefined) return { type: 'string', value: '', control }
        if (name === 'Entity') return { type: 'entity', value: ROOT_ENTITY }
        if (name === 'ActionCallback') return { type: 'action', value: { entity: ROOT_ENTITY, action: '' } }
        if (name === PREFAB_REF) return { type: 'prefab', value: '' }
        if (name === 'Slider') return sliderParam(typeAnnotation.typeParameters?.params ?? [])
      }
      break
    // an inline object type, `{ x: number; y: number }`. Named interfaces are not
    // resolved (there is no type checker here), so nested shapes are written inline.
    case 'TSTypeLiteral': {
      const fields: Record<string, ScriptParam> = {}
      const value: { [key: string]: ScriptValue } = {}
      for (const member of typeAnnotation.members) {
        if (
          member.type === 'TSPropertySignature' &&
          member.key.type === 'Identifier' &&
          member.typeAnnotation?.type === 'TSTypeAnnotation'
        ) {
          const field = annotate(getValueAndTypeFromType(member.typeAnnotation.typeAnnotation), member.leadingComments)
          fields[member.key.name] = member.optional === true ? { ...field, optional: true } : field
          value[member.key.name] = field.value
        }
      }
      return { type: 'object', value, fields }
    }
    case 'TSUnionType': {
      // a union of string literals ("'3D text' | '2D UI'") is an enum: render
      // as a dropdown of exactly those choices
      const literals: string[] = []
      let allLiterals = true
      for (const subType of typeAnnotation.types) {
        if (subType.type === 'TSUndefinedKeyword') continue
        if (subType.type === 'TSLiteralType' && subType.literal.type === 'StringLiteral') {
          literals.push(subType.literal.value)
        } else {
          allLiterals = false
        }
      }
      if (allLiterals && literals.length > 0) {
        return { type: 'enum', value: literals[0], options: literals }
      }
      // otherwise (e.g. string | undefined) — first non-undefined type wins
      for (const subType of typeAnnotation.types) {
        if (subType.type !== 'TSUndefinedKeyword') {
          return getValueAndTypeFromType(subType)
        }
      }
      break
    }
  }
  return { type: 'string', value: '' }
}

// Editor hints in a param's (or an object member's) JSDoc. They only shape the
// pickers; the runtime still receives the plain value. On a list, the hint
// applies to each element.
type ParamTags = { components?: string[]; actionsOf?: string; format?: 'wallet' }

function extractParamTags(comments: Comments): ParamTags {
  const tags: ParamTags = {}
  for (const comment of comments ?? []) {
    if (comment.type !== 'CommentBlock') continue
    for (const raw of comment.value.split('\n')) {
      const line = raw.trim().replace(/^\*\s?/, '')
      const components = /^@components\s+(.+)/.exec(line)
      if (components !== null) {
        tags.components = components[1].split(/[\s,]+/).filter((name) => name !== '')
        continue
      }
      const actionsOf = /^@actionsOf\s+([A-Za-z_$][\w$]*)/.exec(line)
      if (actionsOf !== null) {
        tags.actionsOf = actionsOf[1]
        continue
      }
      if (/^@format\s+wallet\b/.test(line)) tags.format = 'wallet'
    }
  }
  return tags
}

function applyParamTags(param: ScriptParam, tags: ParamTags): ScriptParam {
  if (param.type === 'array' && param.item !== undefined) return { ...param, item: applyParamTags(param.item, tags) }
  if (param.type === 'entity' && tags.components !== undefined && tags.components.length > 0) {
    return { ...param, components: tags.components }
  }
  if (param.type === 'string') {
    return {
      ...param,
      ...(tags.actionsOf !== undefined ? { actionsOf: tags.actionsOf } : {}),
      ...(tags.format !== undefined ? { format: tags.format } : {})
    }
  }
  return param
}

// A param's (or member's) own comment: its tags, and its description.
function annotate(param: ScriptParam, comments: Comments): ScriptParam {
  const tagged = applyParamTags(param, extractParamTags(comments))
  const description = extractJSDocDescription(comments)
  return description === undefined ? tagged : { ...tagged, description }
}

// The declared type supplies the shape (slider range, object fields, array item),
// the default expression the value. A container default is read through its
// declared shape, so a partial or partly unevaluable literal still leaves every
// declared key with a value of the right kind.
function withDefault(typed: ScriptParam, expression: Expression): ScriptParam {
  const value = evaluateLiteral(expression)
  switch (typed.type) {
    case 'object':
      return seedFields(typed, reconcileValue(typed, value))
    case 'array':
      return { ...typed, value: reconcileValue(typed, value) }
    case 'prefabList':
      return { ...typed, value: Array.isArray(value) ? value.filter((ref) => typeof ref === 'string') : [] }
  }
  // a named type the parser can't resolve (`config: DoorConfig = { … }`) reads as a string;
  // its default says what it really is, and a string field would show "[object Object]"
  if (typed.type === 'string' && value !== undefined && typeof value !== 'string') return inferParam(value)
  return { ...typed, value: value ?? '' }
}

// An object's members take their defaults from the authored literal, not the
// type: a stored member that stops fitting then falls back to what the script
// wrote, as a top-level param does.
function seedFields(param: ScriptParam, value: ScriptValue): ScriptParam {
  if (param.fields === undefined || !isRecord(value)) return { ...param, value }
  const fields: Record<string, ScriptParam> = {}
  for (const [key, field] of Object.entries(param.fields)) fields[key] = seedFields(field, value[key] ?? field.value)
  return { ...param, value, fields }
}

// keeps a slider's value inside its declared range, whatever the script's default says
function clampSlider(param: ScriptParam): ScriptParam {
  if (param.type !== 'slider' || param.min === undefined || param.max === undefined) return param
  const value = typeof param.value === 'number' && Number.isFinite(param.value) ? param.value : param.min
  return { ...param, value: Math.min(Math.max(value, param.min), param.max) }
}

function getIdentifier(param: FunctionParameter | TSParameterProperty): Identifier | undefined {
  if (param.type === 'Identifier') {
    return param
  } else if (param.type === 'TSParameterProperty' && param.parameter.type === 'Identifier') {
    return param.parameter
  }
  return undefined
}

function assertScriptSignature(params: (FunctionParameter | TSParameterProperty)[]): void {
  const first = getIdentifier(params[0])
  if (
    first === undefined ||
    first.typeAnnotation?.type !== 'TSTypeAnnotation' ||
    first.typeAnnotation.typeAnnotation.type !== 'TSStringKeyword'
  ) {
    throw new Error('First parameter must be "src: string"')
  }
  const second = getIdentifier(params[1])
  if (
    second === undefined ||
    second.typeAnnotation?.type !== 'TSTypeAnnotation' ||
    second.typeAnnotation.typeAnnotation.type !== 'TSTypeReference' ||
    second.typeAnnotation.typeAnnotation.typeName.type !== 'Identifier' ||
    second.typeAnnotation.typeAnnotation.typeName.name !== 'Entity'
  ) {
    throw new Error('Second parameter must be "entity: Entity"')
  }
}

function extractJSDocDescription(
  comments?: { type: string; value: string }[] | null
): string | undefined {
  if (comments == null) return undefined
  for (const comment of comments) {
    if (comment.type === 'CommentBlock') {
      const lines = comment.value.split('\n').map((line) => line.trim().replace(/^\*\s?/, ''))
      const descriptionLines: string[] = []
      for (const line of lines) {
        if (line.startsWith('@')) break // stop at first @tag
        if (line.length > 0) descriptionLines.push(line)
      }
      const description = descriptionLines.join(' ').trim()
      return description.length > 0 ? description : undefined
    }
  }
  return undefined
}

function extractParamsFromFunctionParams(
  params: (FunctionParameter | TSParameterProperty)[]
): Record<string, ScriptParam> {
  const result: Record<string, ScriptParam> = {}

  params.forEach((param) => {
    let identifier: Identifier | undefined
    let optional = false
    let info: ScriptParam = { type: 'string', value: '' }
    // "public param: Type" (constructor parameter property) or a plain parameter
    const inner = param.type === 'TSParameterProperty' ? param.parameter : param

    if (inner.type === 'Identifier') {
      identifier = inner
      optional = identifier.optional === true
      if (identifier.typeAnnotation?.type === 'TSTypeAnnotation') {
        info = getValueAndTypeFromType(identifier.typeAnnotation.typeAnnotation)
      }
    } else if (inner.type === 'AssignmentPattern' && inner.left.type === 'Identifier') {
      identifier = inner.left
      optional = true
      // with a type annotation (e.g. "target: Entity = 512"), type comes from
      // the annotation and the default value from the expression
      const typeAnnotation = identifier.typeAnnotation
      info =
        typeAnnotation?.type === 'TSTypeAnnotation'
          ? withDefault(getValueAndTypeFromType(typeAnnotation.typeAnnotation), inner.right)
          : getValueAndTypeFromExpression(inner.right)
    }

    if (identifier === undefined) return
    result[identifier.name] = { ...annotate(clampSlider(info), param.leadingComments), optional }
  })

  return result
}

// `@event <name>` tags, wherever the script's JSDoc carries them
function extractEvents(comments: Comments): string[] {
  const events: string[] = []
  for (const comment of comments ?? []) {
    if (comment.type !== 'CommentBlock') continue
    for (const raw of comment.value.split('\n')) {
      const match = /^@event\s+([A-Za-z0-9_-]+)/.exec(raw.trim().replace(/^\*\s?/, ''))
      if (match !== null && !events.includes(match[1])) events.push(match[1])
    }
  }
  return events
}

export type ScriptParseResult = {
  params: Record<string, ScriptParam>
  actions: ScriptAction[]
  events: string[]
  error?: string
}

export function getScriptParams(content: string): ScriptParseResult {
  let params: Record<string, ScriptParam> = {}
  const actions: ScriptAction[] = []
  let events: string[] = []

  try {
    const ast = parse(content, { sourceType: 'module', plugins: ['typescript', 'jsx'] })

    for (const statement of ast.program.body) {
      // function-based scripts: export function start(src: string, entity: Entity, ...)
      if (
        statement.type === 'ExportNamedDeclaration' &&
        statement.declaration?.type === 'FunctionDeclaration' &&
        statement.declaration.id?.name === 'start'
      ) {
        assertScriptSignature(statement.declaration.params)
        params = extractParamsFromFunctionParams(statement.declaration.params.slice(2))
        events = extractEvents([...(statement.leadingComments ?? []), ...(statement.declaration.leadingComments ?? [])])
        break
      }

      // class-based scripts: export class MyScript { constructor(src, entity, ...) }
      if (
        statement.type === 'ExportNamedDeclaration' &&
        statement.declaration?.type === 'ClassDeclaration'
      ) {
        const classDeclaration = statement.declaration
        const constructor = classDeclaration.body.body.find(
          (member): member is ClassMethod =>
            member.type === 'ClassMethod' && member.kind === 'constructor'
        )
        if (constructor !== undefined) {
          assertScriptSignature(constructor.params)
          params = extractParamsFromFunctionParams(constructor.params.slice(2))
        }
        events = extractEvents([
          ...(statement.leadingComments ?? []),
          ...(classDeclaration.leadingComments ?? []),
          ...(constructor?.leadingComments ?? [])
        ])

        // @action-tagged methods (kept for Creator Hub layout compatibility)
        for (const member of classDeclaration.body.body) {
          if (member.type === 'ClassMethod' && member.kind === 'method') {
            const leadingComments = member.leadingComments
            const hasActionTag = leadingComments?.some(
              (comment) => comment.type === 'CommentBlock' && comment.value.includes('@action')
            )
            if (hasActionTag === true && member.key.type === 'Identifier') {
              actions.push({
                methodName: member.key.name,
                description: extractJSDocDescription(leadingComments),
                params: extractParamsFromFunctionParams(member.params)
              })
            }
          }
        }
        break
      }
    }

    return { params, actions, events }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : ''
    console.warn('Failed to parse script params:', error)
    return { params, actions, events, error: errorMessage }
  }
}

// The layout a parse result becomes. `events` is left out when there are none,
// so a script without `@event` tags keeps the layout it always had.
export function layoutOf(result: ScriptParseResult): ScriptLayout {
  const { params, actions, events, error } = result
  return { params, actions, ...(events.length > 0 ? { events } : {}), error }
}

// The layout string a Script component entry carries, parsed fresh from source.
export function freshLayout(content: string): string {
  return JSON.stringify(layoutOf(getScriptParams(content)))
}

export function parseLayout(layout?: string): ScriptLayout | undefined {
  if (layout === undefined || layout === '') return undefined
  try {
    return JSON.parse(layout) as ScriptLayout
  } catch (error) {
    console.warn('Failed to parse script layout:', error)
    return undefined
  }
}

const ENTITY_MARKER = /^\{entity:\d+\}$/

// Does a stored value still fit the freshly parsed param? The runner passes
// layout values positionally into the constructor and its defaults only cover
// `undefined`, so a value that stopped fitting must fall back to the fresh
// default here — it would otherwise reach the script as-is.
function valueFits(param: ScriptParam, value: ScriptValue | undefined): boolean {
  switch (param.type) {
    case 'number':
    case 'slider':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
    case 'prefab':
      return typeof value === 'string'
    case 'enum':
      return typeof value === 'string' && (param.options ?? []).includes(value)
    case 'entity':
      // folder composites hold `{entity:<localId>}` markers where a placed
      // instance holds an engine id — both are that param's honest shape
      return (
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && ENTITY_MARKER.test(value))
      )
    case 'action':
    case 'object':
      return isRecord(value)
    case 'prefabList':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    case 'array':
      return Array.isArray(value)
  }
}

// A stored value read through a fresh param: objects key by key (a dropped key
// goes, a new one gets its default), arrays row by row against the fresh item,
// a slider clamped to its fresh range, and any leaf that no longer fits falls
// back to the fresh default.
function reconcileValue(param: ScriptParam, stored: ScriptValue | undefined): ScriptValue {
  if (param.type === 'object' && param.fields !== undefined) {
    if (!isRecord(stored)) return param.value
    const result: { [key: string]: ScriptValue } = {}
    for (const [key, field] of Object.entries(param.fields)) {
      result[key] = key in stored ? reconcileValue(field, stored[key]) : field.value
    }
    return result
  }
  if (param.type === 'array' && param.item !== undefined) {
    const item = param.item
    return Array.isArray(stored) ? stored.map((row) => reconcileValue(item, row)) : param.value
  }
  if (!valueFits(param, stored) || stored === undefined) return param.value
  if (param.type === 'slider' && typeof stored === 'number' && param.min !== undefined && param.max !== undefined) {
    return Math.min(Math.max(stored, param.min), param.max)
  }
  return stored
}

// Re-parse merge: the fresh parse (source) is authoritative for everything a
// script declares — params, order, types, defaults, options, ranges, fields,
// optionality, doc lines, events. The stored layout (target) contributes exactly
// one thing: the edited VALUE, reconciled against the fresh param. A param the
// script dropped vanishes; one it added appears with its default; a value whose
// type no longer matches, whose enum option was removed, or whose stored shape
// is wrong falls back to the fresh default.
export function mergeLayout(source: ScriptLayout, target: ScriptLayout): ScriptLayout {
  const layout: ScriptLayout = { params: {}, actions: [] }
  for (const [name, value] of Object.entries(source.params)) {
    const targetParam = target.params[name]
    layout.params[name] =
      targetParam === undefined || value.type !== targetParam.type
        ? value
        : { ...value, value: reconcileValue(value, targetParam.value) }
  }
  layout.actions = source.actions
  if (source.events !== undefined && source.events.length > 0) layout.events = source.events
  layout.error = source.error
  return layout
}
