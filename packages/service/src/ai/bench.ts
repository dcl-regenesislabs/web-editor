// The same prompt run several times per release, compared: one run varies too much between model samples to say a
// change helped, so a release is judged on the spread of its runs (docs/ASSISTANT-BENCHMARK.md).
import type { TurnRecord } from './session-log.ts'

export interface BenchRun {
  release: string
  name: string
  turns: TurnRecord[]
}

export interface RunSummary {
  release: string
  name: string
  /** Turns before the one that built: a plan question is one. */
  turnsToBuild: number
  minutes: number
  calls: number
  cost: number
  toolCalls: number
  failedToolCalls: number
  failedBuilds: number
  playtests: number
  mobileChecks: number
  /** Context the model re-read from the cache, the bulk of the cost. */
  cacheReadTokens: number
  outputTokens: number
}

export interface Spread { mean: number; min: number; max: number }

export type ReleaseSummary = { release: string; runs: number } & Record<Exclude<keyof RunSummary, 'release' | 'name'>, Spread>

const BUILDING = new Set(['write_file', 'edit_file', 'scene_request', 'build'])

export function summarizeRun(run: BenchRun): RunSummary {
  const sum = (pick: (turn: TurnRecord) => number) => run.turns.reduce((total, turn) => total + pick(turn), 0)
  const steps = run.turns.flatMap((turn) => turn.steps)
  const building = run.turns.findIndex((turn) => turn.steps.some((step) => BUILDING.has(step.tool)))
  return {
    release: run.release,
    name: run.name,
    turnsToBuild: building === -1 ? run.turns.length : building,
    minutes: sum((turn) => turn.ms) / 60_000,
    calls: sum((turn) => turn.usage?.calls ?? 0),
    cost: sum((turn) => turn.usage?.cost ?? 0),
    toolCalls: sum((turn) => turn.toolCalls),
    failedToolCalls: sum((turn) => turn.failedToolCalls),
    failedBuilds: sum((turn) => turn.failedBuilds),
    playtests: steps.filter((step) => step.tool === 'playtest').length,
    mobileChecks: steps.filter((step) => step.tool === 'mobile_check').length,
    cacheReadTokens: sum((turn) => turn.usage?.tokens?.cacheRead ?? 0),
    outputTokens: sum((turn) => turn.usage?.tokens?.output ?? 0)
  }
}

const METRICS = ['turnsToBuild', 'minutes', 'calls', 'cost', 'toolCalls', 'failedToolCalls', 'failedBuilds', 'playtests',
  'mobileChecks', 'cacheReadTokens', 'outputTokens'] as const

export function summarizeReleases(runs: RunSummary[]): ReleaseSummary[] {
  const releases = [...new Set(runs.map((run) => run.release))]
  return releases.map((release) => {
    const mine = runs.filter((run) => run.release === release)
    const spread = (metric: typeof METRICS[number]): Spread => {
      const values = mine.map((run) => run[metric])
      return { mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values) }
    }
    return { release, runs: mine.length, ...Object.fromEntries(METRICS.map((metric) => [metric, spread(metric)])) } as ReleaseSummary
  })
}

function format(metric: typeof METRICS[number], value: number): string {
  if (metric === 'cost') return value.toFixed(2)
  if (metric === 'minutes') return value.toFixed(1)
  if (metric === 'cacheReadTokens' || metric === 'outputTokens') return `${(value / 1000).toFixed(0)}k`
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** A markdown table: one row per metric, one column per release, mean with min–max when the runs differ. */
export function benchTable(releases: ReleaseSummary[]): string {
  const head = `| | ${releases.map((release) => `${release.release} (${release.runs} runs)`).join(' | ')} |`
  const rule = `|---|${releases.map(() => '---|').join('')}`
  const rows = METRICS.map((metric) => `| ${metric} | ${releases.map((release) => {
    const { mean, min, max } = release[metric]
    return min === max ? format(metric, mean) : `${format(metric, mean)} (${format(metric, min)}–${format(metric, max)})`
  }).join(' | ')} |`)
  return [head, rule, ...rows].join('\n')
}
