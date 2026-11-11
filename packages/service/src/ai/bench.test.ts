import { describe, expect, it } from 'vitest'
import { benchTable, summarizeReleases, summarizeRun } from './bench.ts'
import type { StepRecord, TurnRecord } from './session-log.ts'

function step(n: number, tool: string, ok = true): StepRecord {
  return { n, tool, thinkMs: 100, toolMs: 50, ok, chars: 10 }
}

function turn(steps: StepRecord[], over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turnId: 't', projectId: 'p', conversation: 'c', startedAt: '', endedAt: '', ms: 60_000, outcome: 'completed',
    prompt: 'make a game', steps, toolCalls: steps.length, failedToolCalls: steps.filter((s) => !s.ok).length,
    builds: 0, failedBuilds: 0,
    usage: { cost: 1, tokens: { input: 0, output: 1000, cacheRead: 100_000, cacheWrite: 0 }, calls: 10, unreported: 0 },
    ...over
  }
}

describe('the assistant benchmark', () => {
  it('counts the plan turn before the one that built', () => {
    const run = summarizeRun({ release: 'v1', name: 'a', turns: [
      turn([step(1, 'read_file')]),
      turn([step(1, 'write_file'), step(2, 'build'), step(3, 'playtest'), step(4, 'mobile_check'), step(5, 'playtest', false)])
    ] })
    expect(run).toMatchObject({ turnsToBuild: 1, minutes: 2, calls: 20, cost: 2, toolCalls: 6, failedToolCalls: 1, playtests: 2, mobileChecks: 1 })
  })

  it('reports a release by the spread of its runs', () => {
    const one = summarizeRun({ release: 'v1', name: 'a', turns: [turn([step(1, 'build')])] })
    const two = summarizeRun({ release: 'v1', name: 'b', turns: [turn([step(1, 'build')], { ms: 180_000 })] })
    const next = summarizeRun({ release: 'v2', name: 'c', turns: [turn([step(1, 'build')])] })
    const [v1, v2] = summarizeReleases([one, two, next])
    expect(v1.runs).toBe(2)
    expect(v1.minutes).toEqual({ mean: 2, min: 1, max: 3 })
    expect(v2.minutes).toEqual({ mean: 1, min: 1, max: 1 })
    const table = benchTable([v1, v2])
    expect(table).toContain('| v1 (2 runs) | v2 (1 runs) |')
    expect(table).toContain('| minutes | 2.0 (1.0–3.0) | 1.0 |')
  })
})
