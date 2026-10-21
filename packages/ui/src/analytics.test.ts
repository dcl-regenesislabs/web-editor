import { afterEach, expect, it, vi } from 'vitest'
import { CREATOR_ACTION_EVENT } from '@dcl-editor/contract'
import { trackCreator } from './analytics'
import { type DclEditorHost, type DclEditorHostV1, hostedRoute, setHost } from './engine/hosted'

function v1Host(overrides: Partial<DclEditorHostV1> = {}): DclEditorHostV1 {
  return {
    version: 1,
    engineConsole: vi.fn(async () => ''),
    ...overrides
  } as Partial<DclEditorHostV1> as DclEditorHostV1
}

function decode(line: string): unknown {
  const [command, token, ...rest] = line.split(' ')
  expect(command).toBe('/track')
  expect(rest).toEqual([])
  const binary = atob(token)
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))))
}

afterEach(() => {
  setHost(null)
  hostedRoute.project = null
  vi.useRealTimers()
})

it('does nothing without a host', () => {
  expect(() => trackCreator('editor_opened')).not.toThrow()
})

it('sends through host.track when the host has it', () => {
  const track = vi.fn()
  const host = v1Host({ track })
  setHost(host)
  hostedRoute.project = 'p1'
  trackCreator('play_started', { forced: false })
  expect(track).toHaveBeenCalledWith(CREATOR_ACTION_EVENT, { action: 'play_started', surface: 'web_editor', project_id: 'p1', forced: false })
  expect(host.engineConsole).not.toHaveBeenCalled()
})

it('falls back to the engine console with one base64 token of the batch', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
  const host = v1Host()
  setHost(host)
  trackCreator('project_created', { project_id: 'ñandú-🦤', source: 'template', template: 'café' })
  const line = vi.mocked(host.engineConsole).mock.calls[0][0]
  expect(decode(line)).toEqual([
    {
      event: CREATOR_ACTION_EVENT,
      properties: { action: 'project_created', surface: 'web_editor', project_id: 'ñandú-🦤', source: 'template', template: 'café' },
      timestamp: '2026-10-21T12:00:00.000Z'
    }
  ])
})

it('uses the console on a v0 host', () => {
  const engineConsole = vi.fn(async () => '')
  setHost({ version: 0, engineConsole } as Partial<DclEditorHost> as DclEditorHost)
  trackCreator('editor_opened')
  expect(engineConsole).toHaveBeenCalledOnce()
})

it('never hands a failure back to the caller', async () => {
  const rejecting = v1Host({ engineConsole: vi.fn(() => Promise.reject(new Error('unknown command'))) })
  setHost(rejecting)
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  expect(() => trackCreator('prompt_sent')).not.toThrow()
  await new Promise((resolve) => setTimeout(resolve, 0))
  process.off('unhandledRejection', unhandled)
  expect(unhandled).not.toHaveBeenCalled()

  setHost(v1Host({ track: () => { throw new Error('boom') } }))
  expect(() => trackCreator('prompt_sent')).not.toThrow()
})
