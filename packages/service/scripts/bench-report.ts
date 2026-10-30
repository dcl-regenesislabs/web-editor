// Compares assistant benchmark runs downloaded from /admin/ (docs/ASSISTANT-BENCHMARK.md):
//   node packages/service/scripts/bench-report.ts <folder>
// <folder>/<release>/<run>.json holds what /admin/api/sessions/<wallet>/<conversation> answered for one run.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { benchTable, summarizeReleases, summarizeRun, type RunSummary } from '../src/ai/bench.ts'
import type { TurnRecord } from '../src/ai/session-log.ts'

const folder = process.argv[2]
if (folder === undefined) throw new Error('Usage: node packages/service/scripts/bench-report.ts <folder>')
const runs: RunSummary[] = []
for (const release of (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
  for (const file of (await readdir(join(folder, release))).filter((name) => name.endsWith('.json')).sort()) {
    const { turns } = JSON.parse(await readFile(join(folder, release, file), 'utf8')) as { turns: TurnRecord[] }
    runs.push(summarizeRun({ release, name: file.replace(/\.json$/, ''), turns }))
  }
}
if (runs.length === 0) throw new Error(`No runs under ${folder}: expected <release>/<run>.json`)
console.log(benchTable(summarizeReleases(runs)))
