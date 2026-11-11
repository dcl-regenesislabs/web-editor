// The tools that act on the editor and the running scene, as both assistants offer them: the web one
// through its own tool list, the desktop one through the editor's MCP server. One description and
// one result shape, so a run on either reads the same.

// not assistant.ts's: the service loads contract files directly, and only their types may cross
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const EDITOR_TOOLS = ['list_files', 'search_files', 'read_file', 'edit_file', 'write_file', 'scene_request', 'asset_request', 'build', 'view', 'playtest', 'ui_layout', 'mobile_check'] as const
export type EditorToolName = (typeof EDITOR_TOOLS)[number]

export function isEditorTool(name: string): name is EditorToolName {
  return (EDITOR_TOOLS as readonly string[]).includes(name)
}

const point = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] }

// one playtest action's arguments, sent alone or as one of steps
const playtestAction = {
  platform: { type: 'string', enum: ['desktop', 'mobile'] },
  keys: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  durationMs: { type: 'number', minimum: 0, maximum: 5000 },
  waitFor: { type: 'string' },
  to: point,
  entity: { type: 'string' },
  within: { type: 'number', minimum: 0.5, maximum: 10 },
  timeoutMs: { type: 'number', minimum: 0, maximum: 60000 },
  x: { type: 'number', minimum: 0, maximum: 1 },
  y: { type: 'number', minimum: 0, maximum: 1 }
}

export const EDITOR_TOOL_SCHEMAS: Record<EditorToolName, Record<string, unknown>> = {
  list_files: {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['models', 'images', 'sounds', 'videos', 'data', 'code'] }, match: { type: 'string' } }
  },
  search_files: {
    type: 'object',
    properties: { query: { type: 'string' }, regex: { type: 'boolean' }, match: { type: 'string' } },
    required: ['query']
  },
  read_file: {
    type: 'object',
    properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }, query: { type: 'string' }, regex: { type: 'boolean' } },
    required: ['path']
  },
  edit_file: {
    type: 'object',
    properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' }, all: { type: 'boolean' } },
    required: ['path', 'old', 'new']
  },
  write_file: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' }, revision: { type: ['string', 'null'] } },
    required: ['path', 'content', 'revision']
  },
  scene_request: {
    type: 'object',
    properties: { request: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'], additionalProperties: true } },
    required: ['request']
  },
  asset_request: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['inspect_model', 'search_prefabs', 'import_prefab'] },
      query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, path: { type: 'string' }, ref: { type: 'string' }
    },
    required: ['action']
  },
  build: { type: 'object', properties: {} },
  view: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['editor', 'mobile'] },
      openIfClosed: { type: 'boolean', description: 'Open the mobile preview if closed. Use only when the creator asks to see or check mobile UI.' },
      entity: { type: 'string' }, from: point, lookAt: point
    }
  },
  playtest: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'status', 'input', 'wait', 'walk', 'click', 'steps'] },
      ...playtestAction,
      steps: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'stop', 'input', 'wait', 'walk', 'click', 'waitFor'] },
            ...playtestAction,
            hud: { type: 'string' }, path: { type: 'string' }, equals: {}, changes: { type: 'boolean' }, exists: { type: 'boolean' },
            observe: { type: 'boolean' }
          },
          required: ['action']
        }
      },
      view: { type: 'boolean' },
      path: { type: 'string' }
    },
    required: ['action']
  },
  ui_layout: { type: 'object', properties: {} },
  mobile_check: { type: 'object', properties: {} }
}

export const EDITOR_TOOL_DESCRIPTIONS: Record<EditorToolName, string> = {
  list_files: 'List the project\'s files, optionally only one kind (models, images, sounds, videos, data, code) and those whose path contains match. read_file opens code and data; models, images, sounds and videos are referenced by path.',
  search_files: 'Search the project\'s code and data files for query (case-insensitive text, or a regular expression with regex), optionally only paths containing match. Answers path:line: text for up to 100 hits and the total.',
  read_file: 'Read a project file and its revision. Missing files have a null revision. Whole by default; for a long file read lines offset..offset+limit (1-based), or only the lines matching query, each numbered.',
  edit_file: 'Change part of an existing source file: replace the exact text old (unique in the file, or every one with all) with new. Needs no revision; fails when old is not there exactly once.',
  write_file: 'Create a source file (revision null), or replace one you read whole, only if its revision still matches.',
  asset_request: 'Search the prefab library, import a returned ref into the project without placing it, or inspect a local model for dimensions, pivot, animation names, colliders and dependencies. Search results have nextOffset.',
  scene_request: 'Inspect or change the live scene using the editor actions documented in the system prompt.',
  build: 'Compile and run the project once. Return compiler diagnostics and runtime errors (on the web, also the mobile preview status); does not publish it.',
  playtest: 'Check the running game with the real player controller and UI: a quick run after a build, or reproducing what the creator reports. start reloads the client scene at spawn and plays, as on desktop or, with platform mobile, as on a 1600×720 phone (the scene is told it runs on mobile, gets the mobile interactable area, and the viewport becomes phone-shaped) until stop; stop restores edit mode on desktop and discards client runtime changes. The multiplayer server can retain progress across reloads: click the game restart button and verify its initial HUD before a fresh attempt. status reports player world position, HUD text and runtime errors, and in a scene that uses the game module, game: game.state as this client holds it (round, now and the server life apart; long values cut and marked), changed (the state paths that moved, with before and after: since the action for input, wait, walk and click, since the previous result for status; paths that differ in one key, such as the x of every mover, are one entry like movers.*.x with paths, how many moved, and example, the one that moved most; at most 12 entries, the rest counted) and requests (the last few game.request calls from this client, each with its reply or refused reason; new marks those made during the action). To claim a mechanic works, show it in changed or in a reply, not in HUD text or position alone: an action whose changed is empty and whose request was refused or never sent did nothing. input holds the interaction keys E/F for durationMs (0–5000), and with waitFor first waits (up to 15 s) for HUD text containing it, for presses inside a short window; wait advances time; walk uses the controller towards to in world metres, on the ground only. walk with entity instead of to walks straight at that entity (a name from the outline) and succeeds within `within` m of it (default 1.5), reporting distance. click presses at x/y fractions of the viewport: a scene UI button, or a 3D object under that point (an NPC, a lever) found in a view picture first. With path (a game.state path such as movers or movers.3), game adds read: that value with far more of it than state shows, or exists false. Does not grant progress. Use view during play to see the HUD and route. steps runs up to 20 of these actions in one call, in order, within 180 s, and stops at the first that fails (ok false, failedStep, error; the rest skipped); start may be the first step and stop the last. Each step reports ok, ms, and the changed and requests since the step before it (the game is read after every step unless it has observe false); input and click report hudChangedAfterMs, the first HUD change after the press (null when none came within 1 s). The result adds game, changed since before the first step with every request of the run and its reply or refused reason, then position, HUD and errors, and a picture with view true. A step waitFor waits up to timeoutMs (default 10000, at most 60000) for game.state at path to equals a value, to change (changes true) or to exist (exists true or false), or for hud text: use it instead of a fixed wait. Check a core loop in one steps call and rerun from the failing step, e.g. {action:"steps",steps:[{action:"start"},{action:"walk",entity:"Crate"},{action:"input",keys:["E"]},{action:"waitFor",path:"carry.held",exists:true},{action:"walk",entity:"Counter"},{action:"input",keys:["E"]},{action:"waitFor",path:"score",changes:true}],view:true}.',
  ui_layout: 'Measure the screen UI as the engine laid it out right now, for the layout checks of the scene-ui skill (L1–L8). Needs a running playtest: start it with platform mobile to measure the phone layout. Changes nothing, so open each dialog or panel (playtest click or input) and measure it open too. Returns the platform, the canvas the scene was told (width, height, interactableArea, in canvas units), every visible UI node that has an elementId (entity, parent, elementId, draw order, rect [x, y, w, h] in canvas units from the top-left, pointer when it takes presses, text, fontSize, visibleRect when clipped; nodes without one are only counted, so name every node you need to check) and a picture. Native touch controls are not drawn. When nothing can be measured it returns measured false, unmeasurable (no-ui, no-element-ids, sdk-has-no-element-id or explorer-has-no-layout-feedback), why and instead, with the picture: that is not a pass, do what instead says.',
  mobile_check: 'Check the screen UI on a phone, the same way every time: plays the scene as on a 1600×720 phone (it restarts a playtest if none runs as mobile), measures the HUD as it looks during play (every modal closed, the touch buttons the scene declares shown), opens every modal placed with addHudItem and measures it, and applies the layout rules (L1–L5, L8, overlapping HUD items; L2 against the native buttons the scene left visible, which the HUD never sits on; L3 presses at least 80 and L4 text at least 20 in scene units), the HUD budget (H2-coverage: the HUD covers at most 25% of the phone screen; H3-centre: no HUD item sits in the middle third of the screen; H5-edge: every HUD slot keeps to a screen edge), W1-window-open (a window covers the screen only while it is open) and the touch-button rules (C1, C2: the native buttons a phone shows against the input actions the code reads; C3-key-letter: text that tells a phone player to press E, F or 1–4) in code, and U1-unmeasured: text or press targets with no elementId, which the rules could not check. Returns passed, issues (rule, state, node, detail), the buttons used and visible, and a picture per state; when nothing can be measured, a setup issue says why and what to do instead. Leaves the mobile playtest running. Run it after any change to screen UI, HUD, menus or player input, fix every issue, and run it again until it passes.',
  view: 'A picture of the scene. As is; or framed on entity (an id or unique name); or from a world position `from` looking at `lookAt`, in metres (16 per parcel), for a plan view from above, a facade or a close-up. Use it to check what you placed, moved or built. target mobile pictures the open mobile preview instead, with its touch controls, from the player camera (no entity, from or lookAt); with no target or camera arguments an embedded mobile preview is pictured.'
}

// ---- how long the editor works on a call before it answers with an error instead ----

// A cold build starts the 16 MB bundler and installs the project's packages before it compiles, then reloads the
// scene and waits up to ~20 s for it to come back: about a minute on a slow connection. Four is generous and still
// ends a stuck one long before the turn would.
const BUILD_DEADLINE_MS = 4 * 60_000
// The slowest scene requests are a sceneSettings that moves the parcels (a build, then up to 90 s for the preview to
// load them) and a 200-request batch of prefab imports.
const SCENE_REQUEST_DEADLINE_MS = 4 * 60_000
// playtest: what each action may take, as packages/ui/src/ai/playtest.ts bounds it. start and stop reload the scene,
// which first waits for a pending rebuild.
const RESTART_MS = 2 * 60_000
const PROBE_MS = 8_000
const STEPS_MS = 180_000
const VIEW_MS = 45_000
const PLAYTEST_MARGIN_MS = 30_000

function within(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback
}

function playtestActionMs(raw: unknown): number {
  if (!object(raw)) return 0
  switch (raw.action) {
    case 'start': case 'stop': return RESTART_MS
    case 'input': return within(raw.durationMs, 300, 5000) + (raw.waitFor === undefined ? 0 : 15_000) + 1000
    case 'wait': return within(raw.durationMs, 1000, 5000)
    case 'walk': return raw.entity === undefined ? 10_000 : within(raw.timeoutMs, 10_000, 20_000)
    case 'click': return 2000
    case 'waitFor': return within(raw.timeoutMs, 10_000, 60_000)
    default: return 0
  }
}

// A steps run starts no step after STEPS_MS, but the one that started last runs to its own end.
function playtestDeadlineMs(args: Record<string, unknown>): number {
  if (args.action !== 'steps' || !Array.isArray(args.steps)) return playtestActionMs(args) + 2 * PROBE_MS + PLAYTEST_MARGIN_MS
  const steps = args.steps.slice(0, 20).map(playtestActionMs)
  const chain = steps.reduce((sum, ms) => sum + ms + PROBE_MS, 0)
  return Math.min(chain, STEPS_MS + Math.max(0, ...steps) + PROBE_MS) + PROBE_MS + (args.view === true ? VIEW_MS : 0) + PLAYTEST_MARGIN_MS
}

/** How long the editor works on a call before it answers with an error; undefined for a tool without a deadline. */
export function editorToolDeadlineMs(tool: EditorToolName, args: Record<string, unknown>): number | undefined {
  if (tool === 'build') return BUILD_DEADLINE_MS
  if (tool === 'scene_request') return SCENE_REQUEST_DEADLINE_MS
  if (tool === 'playtest') return playtestDeadlineMs(args)
  return undefined
}

const DEADLINE_SUBJECT: Partial<Record<EditorToolName, string>> = { build: 'The build', scene_request: 'The scene request', playtest: 'The playtest' }

// what the model reads when a call ran out of time: why it may have, and what to do next
export function editorToolTimeoutMessage(tool: EditorToolName, ms: number, cause: string): string {
  return `${DEADLINE_SUBJECT[tool] ?? 'The tool'} did not answer within ${Math.round(ms / 1000)} s; ${cause}. ` +
    'Try again once, or carry on and tell the creator what is left.'
}

export type EditorToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: 'image/jpeg'; data: string }

function picture(value: unknown): string {
  if (!object(value) || typeof value.image !== 'string' || value.mimeType !== 'image/jpeg') throw new Error('The editor sent no picture.')
  return value.image
}

// What the model reads from a tool's JSON answer: pictures as images, not as base64 text.
export function editorToolContent(name: EditorToolName, text: string): EditorToolContent[] {
  if (name !== 'view' && name !== 'ui_layout' && name !== 'mobile_check' && name !== 'playtest') return [{ type: 'text', text }]
  const answer: unknown = JSON.parse(text)
  if (!object(answer)) throw new Error('The editor sent no answer.')
  if (name === 'playtest') {
    if (!object(answer.view)) return [{ type: 'text', text }]
    const { view, ...run } = answer
    return [{ type: 'image', mimeType: 'image/jpeg', data: picture(view) }, { type: 'text', text: JSON.stringify(run) }]
  }
  if (name === 'mobile_check') {
    const states = Array.isArray(answer.states) ? answer.states.filter(object) : []
    const pictures = states.map((s): EditorToolContent => ({ type: 'image', mimeType: 'image/jpeg', data: picture(s.view) }))
    const report = { ...answer, states: states.map(({ view: _view, ...rest }) => rest) }
    return [...pictures, { type: 'text', text: JSON.stringify(report) }]
  }
  if (name === 'ui_layout') {
    const { view, ...layout } = answer
    return [{ type: 'image', mimeType: 'image/jpeg', data: picture(view) }, { type: 'text', text: JSON.stringify(layout) }]
  }
  const framed = typeof answer.framed === 'string' ? ` framed on "${answer.framed}"` : ''
  return [
    { type: 'image', mimeType: 'image/jpeg', data: picture(answer) },
    { type: 'text', text: `The scene from the creator's camera${framed}, ${String(answer.width)}×${String(answer.height)}.` }
  ]
}

// ---- desktop: the main process forwards each MCP call to the page, which runs it ----
export type EditorToolCall =
  | { id: string; name: EditorToolName; args: Record<string, unknown> }
  // the assistant stopped: the page aborts that call
  | { id: string; cancel: true }

export type EditorToolResult = { ok: true; text: string } | { ok: false; message: string }

export const EDITOR_TOOL_CALL_CHANNEL = 'editor-tool-call'
export const EDITOR_TOOL_RESULT_CHANNEL = 'editor-tool-result'
