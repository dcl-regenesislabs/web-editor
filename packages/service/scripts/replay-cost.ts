// What recorded sessions would have cost under other prompt-cache and compaction policies (src/ai/replay.ts).
//   node packages/service/scripts/replay-cost.ts docs/transcripts/admin-sessions
// Each folder below the argument that holds a session.jsonl is one conversation.
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseSession, POLICIES, replay } from '../src/ai/replay.ts'
import type { ReplayResult } from '../src/ai/replay.ts'

const root = process.argv[2]
if (root === undefined) {
  console.error('Usage: node packages/service/scripts/replay-cost.ts <folder of session folders>')
  process.exit(1)
}

async function sessionFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    if (name === 'session.jsonl') found.push(path)
    else if ((await stat(path)).isDirectory()) found.push(...await sessionFiles(path))
  }
  return found.sort()
}

const usd = (value: number) => `$${value.toFixed(2)}`
const rows: string[] = []
const totals = { billed: 0, model: 0, policies: POLICIES.map(() => 0) }
const notes: string[] = []
for (const file of await sessionFiles(root)) {
  const session = parseSession(await readFile(file, 'utf8'))
  if (session.calls.length === 0) continue
  const name = basename(join(file, '..'))
  const billed = session.calls.reduce((sum, call) => sum + call.cost, 0) + session.warmCost + session.summaryCost
  const results: ReplayResult[] = POLICIES.map((policy) => replay(session, policy))
  // the model priced the way the session ran; it says how far the other columns can be trusted
  const asRun = replay(session, { ...POLICIES[0], warmForMs: session.warmCost > 0 ? 60 * 60_000 : 0 })
  totals.billed += billed
  totals.model += asRun.cost
  results.forEach((result, i) => { totals.policies[i] += result.cost })
  const minutes = (session.calls.at(-1)!.end - session.calls[0].start) / 60_000
  rows.push(`| ${name.slice(0, 32)} | ${session.calls.length} | ${minutes.toFixed(0)} | ${usd(billed)} | ${usd(asRun.cost)} | ` +
    results.map((result) => `${usd(result.cost)}${result.coldWrites > 0 ? ` (${result.coldWrites} cold)` : ''}${result.compactions > 0 ? ` (${result.compactions}×)` : ''}`).join(' | ') + ' |')
  const today = results[0]
  if (today.coldWrites > 0) notes.push(`- ${name}: ${today.coldWrites} cold rewrites cost ${usd(today.coldCost)} of ${usd(today.cost)} at 5 min`)
}

console.log(`| Session | Calls | Min | Billed | Model as run | ${POLICIES.map((policy) => policy.name).join(' | ')} |`)
console.log(`|---|---|---|---|---|${POLICIES.map(() => '---|').join('')}`)
for (const row of rows) console.log(row)
console.log(`| **Total** | | | **${usd(totals.billed)}** | **${usd(totals.model)}** | ${totals.policies.map((total) => `**${usd(total)}**`).join(' | ')} |`)
if (notes.length > 0) console.log(`\n${notes.join('\n')}`)
