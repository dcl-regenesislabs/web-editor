import { beforeEach, expect, it, vi } from 'vitest'
import { addHudItem, declareTouchButtons } from '../../runtime-modules/hudLayout'

interface Touch { touchInputs: Array<{ inputAction: number; hide: boolean }>; mainAction?: number; hideJoystick: boolean }

const host = vi.hoisted(() => ({
  systems: [] as Array<() => void>,
  touch: [] as Touch[],
  preview: null as { modal: number } | null,
  renderer: null as null | (() => unknown)
}))
vi.mock('@dcl/sdk/react-ecs', () => ({
  default: { createElement: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props, children }) },
  UiEntity: 'entity',
  ReactEcsRenderer: { addUiRenderer: (_entity: unknown, ui: () => unknown) => { host.renderer = ui } }
}))
vi.mock('@dcl/sdk/ecs', () => ({
  engine: {
    RootEntity: 0,
    addEntity: () => 600,
    addSystem: (system: () => void) => host.systems.push(system),
    getComponentOrNull: () => null,
    defineComponent: () => ({ getOrNull: () => host.preview })
  },
  Schemas: { Int: 'int' },
  InputAction: { IA_POINTER: 0, IA_PRIMARY: 1, IA_SECONDARY: 2, IA_JUMP: 8, IA_ACTION_3: 10, IA_ACTION_4: 11, IA_ACTION_5: 12, IA_ACTION_6: 13 },
  TouchScreenControls: { createOrReplace: (_entity: unknown, value: Touch) => host.touch.push(value) }
}))
vi.mock('@dcl/sdk/platform', () => ({ isMobile: () => true }))
vi.mock('~runtime/uiTheme', () => ({ UI_CANVAS: { virtualWidth: 1920, virtualHeight: 1080, screenInset: 'interactable' } }))

const tick = () => { for (const system of host.systems) system() }
const hidden = (touch: Touch | undefined) => touch?.touchInputs.filter((input) => input.hide).map((input) => input.inputAction)

// walks the element tree whatever the JSX transform produced, rendering function components (Stack) in place
function elementIds(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) elementIds(child, out)
    return out
  }
  const element = node as { component?: unknown; type?: unknown; props?: Record<string, unknown> | null; children?: unknown[] }
  const kind = element.component ?? element.type
  if (typeof kind === 'function') return elementIds((kind as (props: unknown) => unknown)({ ...element.props, children: element.children }), out)
  const transform = element.props?.uiTransform as { elementId?: unknown } | undefined
  if (typeof transform?.elementId === 'string') out.push(transform.elementId)
  elementIds(element.props?.children, out)
  elementIds(element.children, out)
  return out
}
function render(): string[] {
  if (host.renderer === null) throw new Error('nothing mounted')
  return elementIds(host.renderer())
}

let removers: Array<() => void> = []
beforeEach(() => {
  for (const remove of removers) remove()
  removers = []
  host.touch = []
  host.preview = null
  tick()
  host.touch = []
})

it('hides the phone controls while a modal is open and restores the declared buttons on every way it closes', () => {
  let open = false
  removers.push(declareTouchButtons([1, 2], { main: 1 }))
  const remove = addHudItem('modal', () => null, { open: () => open })

  tick()
  expect(hidden(host.touch.at(-1))).toEqual([0, 8, 10, 11, 12, 13])
  expect(host.touch.at(-1)?.mainAction).toBe(1)
  expect(host.touch.at(-1)?.hideJoystick).toBe(false)
  open = true
  tick(); tick()
  expect(host.touch).toHaveLength(2)
  expect(hidden(host.touch.at(-1))).toEqual([0, 1, 2, 8, 10, 11, 12, 13])
  expect(host.touch.at(-1)?.hideJoystick).toBe(true)
  open = false
  tick()
  expect(hidden(host.touch.at(-1))).toEqual([0, 8, 10, 11, 12, 13])

  open = true
  tick()
  remove()
  tick()
  expect(hidden(host.touch.at(-1))).toEqual([0, 8, 10, 11, 12, 13])
  expect(host.touch.at(-1)?.hideJoystick).toBe(false)
})

it('leaves the explorer defaults alone until a script declares buttons or a modal opens', () => {
  removers.push(addHudItem('left', () => null))
  tick()
  expect(host.touch).toEqual([])
})

it('shows the union of what every script declares', () => {
  removers.push(declareTouchButtons([1]), declareTouchButtons([2, 8]))
  tick()
  expect(hidden(host.touch.at(-1))).toEqual([0, 10, 11, 12, 13])
})

it('names every item for the mobile check and opens the modal the editor previews', () => {
  let open = false
  removers.push(
    addHudItem('left', () => ({ component: 'panel', props: {}, children: [] }) as never),
    addHudItem('modal', () => ({ component: 'dialog', props: {}, children: [] }) as never, { open: () => open })
  )
  expect(render()).toEqual(['hud:left:0', 'hud:modals:1'])
  host.preview = { modal: 0 }
  expect(render()).toEqual(['hud:left:0', 'hud:modal:0', 'hud:modals:1'])
  tick()
  expect(host.touch.at(-1)?.hideJoystick).toBe(true)
  host.preview = { modal: -1 }
  open = true
  expect(render()).toEqual(['hud:left:0', 'hud:modal:0', 'hud:modals:1'])
})
