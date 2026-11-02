import { beforeEach, expect, it, vi } from 'vitest'
import { addHudItem, declareTouchButtons, hudSpace } from '../../runtime-modules/hudLayout'

interface Touch { touchInputs: Array<{ inputAction: number; hide: boolean; icon?: { tex: { $case: string; texture: { src: string } } } }>; mainAction?: number; hideJoystick: boolean }

const host = vi.hoisted(() => ({
  systems: [] as Array<() => void>,
  touch: [] as Touch[],
  preview: null as { modal: number } | null,
  renderers: [] as Array<{ ui: () => unknown; options: { screenInset?: string; zIndex?: number } }>
}))
vi.mock('@dcl/sdk/react-ecs', () => ({
  default: { createElement: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props, children }) },
  UiEntity: 'entity',
  InteractableArea: 'interactable-area',
  ReactEcsRenderer: { addUiRenderer: (_entity: unknown, ui: () => unknown, options: { screenInset?: string; zIndex?: number }) => { host.renderers.push({ ui, options }) } }
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
  if (host.renderers.length === 0) throw new Error('nothing mounted')
  return host.renderers.flatMap((renderer) => elementIds(renderer.ui()))
}

// the props of the first element carrying this elementId
function find(node: unknown, id: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, id)
      if (hit !== null) return hit
    }
    return null
  }
  const element = node as { component?: unknown; type?: unknown; props?: Record<string, unknown> | null; children?: unknown[] }
  const kind = element.component ?? element.type
  if (typeof kind === 'function') return find((kind as (props: unknown) => unknown)({ ...element.props, children: element.children }), id)
  if ((element.props?.uiTransform as { elementId?: unknown } | undefined)?.elementId === id) return element.props ?? null
  return find(element.props?.children, id) ?? find(element.children, id)
}

// the right column's stack: the element whose children hold hud:right:0
function rightColumn(): { position?: { bottom?: number }; overflow?: string; height?: unknown } | null {
  for (const renderer of host.renderers) {
    const tree = renderer.ui() as { children?: unknown[]; props?: { children?: unknown } }
    for (const child of [tree.children ?? [], tree.props?.children ?? []].flat(3)) {
      const stack = child as { component?: unknown; type?: unknown; props?: Record<string, unknown> }
      const kind = stack.component ?? stack.type
      if (typeof kind !== 'function' || stack.props?.slot !== 'right') continue
      const drawn = (kind as (props: unknown) => { props?: { uiTransform?: Record<string, unknown> } } | null)(stack.props)
      return (drawn?.props?.uiTransform ?? null) as ReturnType<typeof rightColumn>
    }
  }
  return null
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

it('draws the icon a script gives a button, keeps the first one given, and accepts bare actions beside it', () => {
  removers.push(
    declareTouchButtons([{ action: 1, icon: 'assets/images/action-icons/pick-up.png' }, 2], { main: 1 }),
    declareTouchButtons([{ action: 1, icon: 'assets/images/other.png' }, { action: 8 }])
  )
  tick()
  const inputs = host.touch.at(-1)?.touchInputs ?? []
  expect(hidden(host.touch.at(-1))).toEqual([0, 10, 11, 12, 13])
  expect(inputs.find((input) => input.inputAction === 1)?.icon).toEqual({ tex: { $case: 'texture', texture: { src: 'assets/images/action-icons/pick-up.png' } } })
  expect(inputs.filter((input) => input.icon !== undefined)).toHaveLength(1)
  expect('icon' in (inputs.find((input) => input.inputAction === 2) ?? {})).toBe(false)
})

it('names every item for the mobile check and opens the modal the editor previews', () => {
  let open = false
  removers.push(
    addHudItem('left', () => ({ component: 'panel', props: {}, children: [] }) as never),
    addHudItem('modal', () => ({ component: 'dialog', props: {}, children: [] }) as never, { open: () => open })
  )
  expect(render()).toEqual(['hud:left:0', 'hud:modals:1'])
  host.preview = { modal: 0 }
  expect(render()).toEqual(['hud:left:0', 'hud:modals:1', 'hud:modal:0'])
  tick()
  expect(host.touch.at(-1)?.hideJoystick).toBe(true)
  host.preview = { modal: -1 }
  open = true
  expect(render()).toEqual(['hud:left:0', 'hud:modals:1', 'hud:modal:0'])
})

it('draws windows in their own full-screen layer in front of the HUD', () => {
  removers.push(addHudItem('modal', () => ({ component: 'dialog', props: {}, children: [] }) as never, { open: () => true }))
  expect(host.renderers.map((renderer) => renderer.options)).toEqual([
    { virtualWidth: 1920, virtualHeight: 1080, screenInset: 'interactable' },
    { virtualWidth: 1920, virtualHeight: 1080, screenInset: 'none', zIndex: 10 }
  ])
})

it('closes every window for the HUD measurement, keeping the declared touch buttons, but not a modal that never closes', () => {
  removers.push(
    declareTouchButtons([1], { main: 1 }),
    addHudItem('modal', () => ({ component: 'tutorial', props: {}, children: [] }) as never, { open: () => true }),
    addHudItem('modal', () => ({ component: 'stuck', props: {}, children: [] }) as never)
  )
  host.preview = { modal: -2 }
  expect(render()).toEqual(['hud:modals:2', 'hud:modal:1'])
  tick()
  expect(hidden(host.touch.at(-1))).toEqual([0, 2, 8, 10, 11, 12, 13])
  expect(host.touch.at(-1)?.hideJoystick).toBe(false)
  host.preview = null
  expect(render()).toEqual(['hud:modals:2', 'hud:modal:0', 'hud:modal:1'])
})

it('dims the screen behind a window with close() and closes it on a tap there', () => {
  let open = true
  const close = vi.fn(() => { open = false })
  removers.push(
    addHudItem('modal', () => ({ component: 'shop', props: {}, children: [] }) as never, { open: () => open, close }),
    addHudItem('modal', () => ({ component: 'notice', props: {}, children: [] }) as never, { open: () => true })
  )
  const tree = host.renderers.map((renderer) => renderer.ui())
  const backdrop = find(tree, 'hud:modal:0')
  expect(backdrop?.uiBackground).toBeDefined()
  expect((backdrop?.uiTransform as { pointerFilter?: string }).pointerFilter).toBe('block')
  ;(backdrop?.onMouseDown as () => void)()
  expect(close).toHaveBeenCalledOnce()
  const plain = find(tree, 'hud:modal:1')
  expect(plain?.uiBackground).toBeUndefined()
  expect((plain?.uiTransform as { pointerFilter?: string }).pointerFilter).toBe('none')
})

it('ends the phone right column above the action buttons the scene declares', () => {
  removers.push(addHudItem('right', () => ({ component: 'orders', props: {}, children: [] }) as never))
  expect(rightColumn()).toMatchObject({ position: { bottom: 293 }, overflow: 'hidden' })
  expect(hudSpace('right')).toBe(643 - 20 - 293)
  const one = declareTouchButtons([1])
  expect(rightColumn()).toMatchObject({ position: { bottom: 168 } })
  const two = declareTouchButtons([2, 8])
  expect(rightColumn()).toMatchObject({ position: { bottom: 248 } })
  expect(hudSpace('right')).toBe(643 - 20 - 248)
  const four = declareTouchButtons([10])
  expect(rightColumn()).toMatchObject({ position: { bottom: 293 } })
  removers.push(one, two, four)
  expect(hudSpace('left')).toBe(108)
  expect(rightColumn()?.height).toBeUndefined()
})
