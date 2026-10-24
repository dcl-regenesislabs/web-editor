import { expect, it, vi } from 'vitest'
import type { Entity } from '@dcl/sdk/ecs'
import { createUiTheme } from '../../runtime-modules/pure/uiTheme'
import { ServerClock } from '../../prefabs/server-clock/scripts/server-clock'

const host = vi.hoisted(() => ({ items: [] as Array<{ slot: string; render: () => unknown }> }))
vi.mock('@dcl/sdk/ecs', () => ({
  TextShape: { deleteFrom: () => {}, createOrReplace: () => {} },
  VisibilityComponent: { createOrReplace: () => {} }
}))
vi.mock('@dcl/sdk/network', () => ({ isServer: () => false }))
vi.mock('~runtime/timeSync', () => ({ initTimeSync: () => {}, getServerTime: () => Date.UTC(2026, 0, 1, 12), isTimeSyncReady: () => true }))
vi.mock('~runtime/uiTheme', () => ({ UI_CANVAS: { virtualWidth: 1920, virtualHeight: 1080 }, sceneUiTheme: () => createUiTheme() }))
vi.mock('@dcl/sdk/react-ecs', () => ({
  default: { createElement: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props, children }) },
  UiEntity: 'entity', Label: 'label'
}))
vi.mock('~runtime/hudLayout', () => ({ addHudItem: (slot: string, render: () => unknown) => { host.items.push({ slot, render }); return () => {} } }))

it('places two clocks in their own screen columns, each with its own label', () => {
  const first = new ServerClock('', 512 as Entity, 'FIRST', true, '2D UI', 'top left')
  const second = new ServerClock('', 513 as Entity, 'SECOND', true, '2D UI', 'top right')
  first.start(); second.start()
  first.update(1); second.update(1)
  expect(host.items.map((item) => item.slot)).toEqual(['left', 'right'])
  const left = JSON.stringify(host.items[0].render())
  const right = JSON.stringify(host.items[1].render())
  expect(left).toContain('FIRST')
  expect(left).not.toContain('SECOND')
  expect(right).toContain('SECOND')
  expect(left).toContain('12:00:00')
  expect(right).toContain('12:00:00')
})
