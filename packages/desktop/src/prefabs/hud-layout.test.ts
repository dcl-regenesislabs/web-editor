import { expect, it, vi } from 'vitest'
import { addHudItem } from '../../runtime-modules/hudLayout'

const host = vi.hoisted(() => ({ systems: [] as Array<() => void>, controls: [] as string[] }))
vi.mock('@dcl/sdk/react-ecs', () => ({
  default: { createElement: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props, children }) },
  UiEntity: 'entity',
  ReactEcsRenderer: { addUiRenderer: () => {} }
}))
vi.mock('@dcl/sdk/ecs', () => ({
  engine: { addEntity: () => 600, addSystem: (system: () => void) => host.systems.push(system) },
  TouchScreenControls: {
    hideAll: () => host.controls.push('hideAll'), hideJoystick: () => host.controls.push('hideJoystick'),
    showAll: () => host.controls.push('showAll'), showJoystick: () => host.controls.push('showJoystick')
  }
}))
vi.mock('@dcl/sdk/platform', () => ({ isMobile: () => true }))
vi.mock('~runtime/uiTheme', () => ({ UI_CANVAS: { virtualWidth: 1920, virtualHeight: 1080, screenInset: 'interactable' } }))

it('hides the phone controls while a modal is open and brings them back on every way it closes', () => {
  let open = false
  const remove = addHudItem('modal', () => null, { open: () => open })
  const tick = () => { for (const system of host.systems) system() }

  tick()
  expect(host.controls).toEqual([])
  open = true
  tick(); tick()
  expect(host.controls).toEqual(['hideAll', 'hideJoystick'])
  open = false
  tick()
  expect(host.controls).toEqual(['hideAll', 'hideJoystick', 'showAll', 'showJoystick'])

  open = true
  tick()
  remove()
  tick()
  expect(host.controls.slice(-2)).toEqual(['showAll', 'showJoystick'])
})
