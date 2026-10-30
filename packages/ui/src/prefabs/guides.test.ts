// Guards the per-prefab AI guides (packages/desktop/prefabs/<slug>/ai.md) and the
// boundary between them and the assistant's core prompt. Two failure modes this
// suite exists for: a guide that drifts from the params/API it documents (the
// creator's copy is the one the assistant reads, and nothing else checks it), and
// per-prefab knowledge growing back into ASSISTANT_PROMPT — the same rule written
// twice, aging apart, is how the prompt contradicted itself about the zone param.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getScriptParams } from '../script/parser'
import { buildGuideIndex } from '../ai/roster'
import { ASSET_PATH_TOKEN, SCRIPT_COMPONENT, isRecord, parsePrefabComposite, parsePrefabData } from './format'
import {
  PREFABS_ROOT,
  filesUnder,
  hasRuntimeModules,
  prefabFolders,
  readPrefabFile as read,
  runtimeSpecifiers
} from './builtin-fixtures'

const SHARED_PROMPT_TS = new URL('../../../contract/src/assistant-prompt.ts', import.meta.url)
const STORE_TS = new URL('../panels/prefab-store.ts', import.meta.url)

// The name the guide ships under, the name the store looks for and the name the
// index points the assistant at are one string — see the last test in this file.
const GUIDE_FILE = 'ai.md'
const MAX_GUIDE_BYTES = 6144
// The cap exists to catch RE-GROWTH, not to fight ordinary edits — the vocabulary
// lint below is what keeps per-prefab content out. Raise deliberately for a new
// editor CAPABILITY, never as part of adding a prefab.
const MAX_PROMPT_CHARS = 36400

function hasGuide(folder: string): boolean {
  return existsSync(fileURLToPath(new URL(`${folder}/${GUIDE_FILE}`, PREFABS_ROOT)))
}

const guidedFolders = prefabFolders().filter(hasGuide)

function guide(folder: string): string {
  return read(`${folder}/${GUIDE_FILE}`)
}

interface FrontMatter {
  prefab: string
  claims: Record<string, string[]>
}

// Deliberately strict: front-matter is the machine-readable half of a guide, so a
// missing fence or a mistyped key must fail here rather than be silently ignored.
function frontMatter(text: string): FrontMatter {
  // A Windows checkout may hand this file over with CRLF endings (autocrlf) —
  // parse what git gives us rather than requiring a particular checkout config.
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') throw new Error('guide does not open with a --- front-matter fence')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error('front-matter is never closed')
  const out: FrontMatter = { prefab: '', claims: {} }
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon < 0) throw new Error(`front-matter line is not key: value — ${line}`)
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'prefab') out.prefab = value
    else if (key.startsWith('claims-')) out.claims[key] = value.split(',').map((t) => t.trim()).filter((t) => t !== '')
    else throw new Error(`unknown front-matter key "${key}"`)
  }
  return out
}

// Every script the composite points at, as a folder-relative path.
function scriptPaths(folder: string): string[] {
  const composite = parsePrefabComposite(read(`${folder}/composite.json`), folder)
  const out: string[] = []
  for (const component of composite.components) {
    if (component.name !== SCRIPT_COMPONENT) continue
    for (const entry of Object.values(component.data)) {
      const json = entry.json
      const value = isRecord(json) && Array.isArray(json.value) ? json.value : []
      for (const item of value) {
        if (!isRecord(item) || typeof item.path !== 'string') continue
        out.push(item.path.replace(`${ASSET_PATH_TOKEN}/`, ''))
      }
    }
  }
  return out
}

const promptSource = readFileSync(SHARED_PROMPT_TS, 'utf8')

// The prompts are template literals in code no test can import (electron, the
// service), so they are extracted as text — escaped backticks inside are skipped
// so the scan stops at the real terminator.
function extractPrompt(source: string, opener: string): string {
  const start = source.indexOf(opener)
  if (start < 0) throw new Error(`${opener} was renamed or is no longer a template literal`)
  const from = start + opener.length
  let i = from
  while (i < source.length) {
    if (source[i] === '\\') i += 2
    else if (source[i] === '`') break
    else i++
  }
  if (i >= source.length) throw new Error(`${opener} is unterminated`)
  return source.slice(from, i)
}

// The core prompt both assistants get. spawnPoints in it is scene.json's field (sceneSettings), not the
// spawn-points prefab's vocabulary.
const PROMPT = {
  text: () => extractPrompt(promptSource, 'export const ASSISTANT_PROMPT = `'),
  vocabulary: promptSource,
  max: MAX_PROMPT_CHARS,
  exempt: ['spawnPoints']
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('per-prefab AI guides', () => {
  const folders = prefabFolders()

  // Carried runtime modules are exactly what makes a prefab something another
  // script imports and therefore needs documenting. Both directions: the 23 seats
  // and admin-tools expose no API, and a guide nobody is told to read only rots.
  it('ships a guide iff the prefab carries runtime modules', () => {
    for (const folder of folders) {
      const guided = hasGuide(folder)
      const why = guided ? 'ai.md exists but nothing here is importable' : 'ai.md is missing'
      expect(guided, `${folder}: ${why}`).toBe(hasRuntimeModules(folder))
    }
  })

  it('guides the prefabs that expose an API, and no others', () => {
    expect(guidedFolders).toEqual([
      'announcer',
      'game-flow',
      'health-respawn',
      'leaderboard',
      'run-progress',
      'server-clock',
      'spawner',
      'trigger-zone',
      'ui-theme'
    ])
  })

  // The prompt ORDERS the assistant to read a guide before it writes code that
  // touches that prefab, so a guide is what it writes from. A verb the game API
  // no longer has reads as current API from in there — and a rename in the
  // runtime never touches markdown, which is why this is a test and not a habit.
  const DELETED_VERBS = ['game.send(', 'game.onMessage(', 'game.onStart(']

  it('never hands the assistant a verb the game API no longer has', () => {
    for (const folder of guidedFolders) {
      const text = guide(folder)
      for (const verb of DELETED_VERBS) {
        expect(text.includes(verb), `${folder}/ai.md still teaches ${verb}`).toBe(false)
      }
    }
  })

  it('names its own folder in the front-matter', () => {
    for (const folder of guidedFolders) {
      expect(frontMatter(guide(folder)).prefab, folder).toBe(folder)
    }
  })

  it('follows the required section order', () => {
    for (const folder of guidedFolders) {
      const text = guide(folder)
      const name = parsePrefabData(read(`${folder}/data.json`), folder, 'fallback').name
      const headings = [`# ${name} — AI guide`, '## When to use', '## API', "## Do / Don't", '## Example']
      let at = -1
      for (const heading of headings) {
        const found = text.indexOf(heading)
        expect(found, `${folder} is missing "${heading}"`).toBeGreaterThan(-1)
        expect(found, `${folder}: "${heading}" is out of order`).toBeGreaterThan(at)
        at = found
      }
    }
  })

  it('shows exactly one Example', () => {
    for (const folder of guidedFolders) {
      expect(count(guide(folder), '\n## Example'), folder).toBe(1)
    }
  })

  // The cap is the whole point: every line competes with the user's request in a
  // paid, latency-bound context, and monotonic growth is what killed the monolith.
  it('stays under the size cap', () => {
    for (const folder of guidedFolders) {
      const bytes = Buffer.byteLength(guide(folder))
      expect(bytes, `${folder}/ai.md is ${bytes} bytes`).toBeLessThanOrEqual(MAX_GUIDE_BYTES)
    }
  })

  // A guide that no longer names a param is how the assistant ends up setting one
  // that does not exist — word-boundary matched, so a rename fails instead of
  // passing on a substring of the old name.
  it('names every inspector param its scripts expose', () => {
    for (const folder of guidedFolders) {
      const text = guide(folder)
      const paths = scriptPaths(folder)
      expect(paths.length, `${folder} references no scripts`).toBeGreaterThan(0)
      for (const rel of paths) {
        const { params, error } = getScriptParams(read(`${folder}/${rel}`))
        expect(error, `${folder}/${rel}`).toBeUndefined()
        for (const param of Object.keys(params)) {
          expect(new RegExp(`\\b${param}\\b`).test(text), `${folder}/ai.md never mentions "${param}"`).toBe(true)
        }
      }
    }
  })

  // Wire names are the one thing two prefabs can silently fight over: a duplicate
  // rpc method or comms message is a runtime mystery, so it is a failing test.
  it('claims globals, rpc methods and messages uniquely across prefabs', () => {
    const owner = new Map<string, string>()
    for (const folder of guidedFolders) {
      for (const tokens of Object.values(frontMatter(guide(folder)).claims)) {
        for (const token of tokens) {
          expect(owner.get(token), `${token} is claimed by both ${owner.get(token)} and ${folder}`).toBeUndefined()
          owner.set(token, folder)
        }
      }
    }
    expect(owner.size).toBeGreaterThan(0)
  })

  it('only claims names its own code defines', () => {
    // A claimed wire name is often defined in a runtime module rather than in the
    // prefab's own script — the prefab used to carry that module, and now reaches
    // the one shared copy through `~runtime/`. Either way it is code this prefab
    // ships, so both count as "its own".
    const MASTERS = new URL('../../../desktop/runtime-modules/', import.meta.url)
    for (const folder of guidedFolders) {
      const scripts = new URL(`${folder}/scripts/`, PREFABS_ROOT)
      const sources = [
        ...filesUnder(scripts).map((rel) => readFileSync(new URL(rel, scripts), 'utf8')),
        ...runtimeSpecifiers(folder).map((spec) => {
          const rel = spec.slice('~runtime/'.length)
          const file = filesUnder(MASTERS).find((name) => name === `${rel}.ts` || name === `${rel}.tsx`)
          if (file === undefined) throw new Error(`Missing runtime module ${spec}`)
          return readFileSync(new URL(file, MASTERS), 'utf8')
        })
      ].join('\n')
      for (const tokens of Object.values(frontMatter(guide(folder)).claims)) {
        for (const token of tokens) {
          expect(sources.includes(token), `${folder} claims ${token} but no script in it defines that name`).toBe(true)
        }
      }
    }
  })
})

describe('the core prompt and the guides do not overlap', () => {
  const { text, vocabulary, max, exempt } = PROMPT
  // Per-prefab vocabulary. Each of these lives in exactly one guide; seeing one
  // here means a rule was copied instead of moved, and the copies will age apart.
  const BANNED = [
    'zoneOf',
    'onZone(',
    'playersInZone',
    'publishZone',
    'emitZone',
    'exitDelay',
    'fireWhen',
    'cooldown',
    'verifyZoneEntry',
    'verifiedInZone',
    'getServerTime',
    'initTimeSync',
    '__dclZoneBus',
    'requestSpawn',
    'retireSpawned',
    '__dclSpawnPoints',
    'spawnPoints'
  ]

  it('keeps per-prefab vocabulary out of the core prompt', () => {
    for (const token of BANNED.filter((banned) => !exempt.includes(banned))) {
      expect(
        vocabulary.includes(token),
        `the prompt mentions "${token}" — that belongs in the prefab's ai.md`
      ).toBe(false)
    }
  })

  // The capsule needs one import line to place a zone and react to it on the same
  // turn, before any guide is on disk. Once each: a second mention is the API
  // reference growing back.
  it('spends the zone bus vocabulary exactly once, on the capsule import', () => {
    expect(count(vocabulary, 'zoneBus')).toBe(1)
    expect(count(vocabulary, 'isInZone')).toBe(1)
  })

  // The sanctioned exception to MOVE-never-duplicate: these two survive a skipped
  // read because either one silently breaks the scene. Their rationale is in the
  // guide; the ban itself stays here.
  it('keeps the two scene-breaking NEVERs in core', () => {
    const prompt = text()
    expect(prompt).toContain('NEVER hand-roll proximity')
    expect(prompt).toContain('triggerAreaEventsSystem')
  })

  // The rules that must survive an empty scene: with nothing spawnable and no
  // Game Config, the turn context emits neither block, so the prompt is the only
  // place that says content is a prefab and tuned numbers are not params.
  it('keeps the spawnable and Game Config rules in core', () => {
    const prompt = text()
    expect(prompt).toContain('every project prefab is spawnable')
    expect(prompt).toContain('engine.addEntity')
    expect(prompt).toContain('[Spawnable prefabs]')
    expect(prompt).toContain('Game Config')
    // the guarantee rule routes to each prefab's guide instead of stating one
    expect(prompt).toMatch(/what a clone actually guarantees/)
  })

  it('makes the guide pull mandatory and says where guides live', () => {
    const prompt = text()
    expect(prompt).toContain('PREFAB GUIDES')
    expect(prompt).toContain('[Prefab guides]')
    expect(prompt).toContain(`custom/<slug>/${GUIDE_FILE}`)
    expect(prompt).toMatch(/MUST read/)
    expect(prompt).toContain(`custom/trigger_zone/${GUIDE_FILE}`)
  })

  // Multiplayer is the other rule set that must survive an empty scene: no
  // prefab and no guide can tell the assistant which side a line runs on, and
  // the bridge sentence is the only thing that stops code copied from
  // docs.decentraland.org from leaking room.* into a script.
  it('teaches the game API and the bridge from the documented room.* calls', () => {
    const prompt = text()
    expect(prompt).toContain("import { game } from './runtime/game'")
    expect(prompt).toContain(
      "game.request/game.onRequest and game.broadcast/game.onBroadcast are the Multiplayer Server's room.send/room.onMessage with the envelope handled for you"
    )
    expect(prompt).toContain('game.state.round is reserved')
    // the only sanctioned mention of the raw transport is the bridge itself
    expect(count(prompt, 'room.send')).toBe(1)
  })

  // The prompt used to assert there is no isServer(), which was false while eight
  // of our own scripts called it. What replaces it is the whole model, so each
  // half is pinned: both sides run every script, the check is the official
  // import, the branch has a home and a direction, and nothing on the client
  // answers the server.
  it('teaches the isServer() branch, not a callback that implies the side', () => {
    const prompt = text()
    expect(prompt).not.toContain('there is no isServer()')
    expect(prompt).toContain("import { isServer } from '@dcl/sdk/network'")
    expect(prompt).toContain('EVERY script runs on BOTH sides')
    expect(prompt).toContain('INSIDE a method, NEVER at module scope')
    expect(prompt).toContain('Never the inverted')
    expect(prompt).toContain('There is NO server→client request')
    // the four verbs the split produced, and neither of the two it replaced
    for (const verb of ['game.request(', 'game.onRequest(', 'game.broadcast(', 'game.onBroadcast(']) {
      expect(prompt, `the prompt never shows ${verb}`).toContain(verb)
    }
    expect(prompt).not.toContain('game.send(')
    expect(prompt).not.toContain('game.onMessage(')
    expect(prompt).toContain('game.onReady(')
    expect(prompt).not.toContain('game.onStart(')
    // the Trigger Area verb is a server verb now, and its twin is gone
    expect(prompt).toContain('game.onEnterArea(name, fn)')
    expect(prompt).not.toContain('game.onExitArea')
  })

  // The O(1) property as a test: prefab #27 adds one index line and zero prompt
  // bytes. If this fails, the fix is to move the new text into a guide.
  it('keeps the prompt bounded — O(1) in prefab count', () => {
    const prompt = text()
    expect(prompt.length, 'extraction produced something implausible').toBeGreaterThan(4000)
    expect(prompt.length, `the prompt is ${prompt.length} chars`).toBeLessThan(max)
  })

})

describe('the guide filename', () => {
  // Three files have to agree on one filename or the index points at nothing: the
  // prefab folders ship it, refreshPrefabs detects it, buildGuideIndex cites it.
  it('agrees with the store and the index on the guide filename', () => {
    expect(readFileSync(STORE_TS, 'utf8')).toContain(`/${GUIDE_FILE}`)
    const index = buildGuideIndex([
      { folder: 'custom/trigger_zone', name: 'Trigger Zone', version: '0.3.0', description: 'A zone.' }
    ])
    expect(index).toContain(`guide: custom/trigger_zone/${GUIDE_FILE}`)
  })
})
