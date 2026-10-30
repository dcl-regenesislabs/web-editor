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
      action: { type: 'string', enum: ['start', 'stop', 'status', 'input', 'wait', 'walk', 'click'] },
      platform: { type: 'string', enum: ['desktop', 'mobile'] },
      keys: { type: 'array', items: { type: 'string' }, maxItems: 2 },
      durationMs: { type: 'number', minimum: 0, maximum: 5000 },
      waitFor: { type: 'string' },
      to: point,
      x: { type: 'number', minimum: 0, maximum: 1 },
      y: { type: 'number', minimum: 0, maximum: 1 }
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
  playtest: 'Check the running game with the real player controller and UI: a quick run after a build, or reproducing what the creator reports. start reloads the client scene at spawn and plays, as on desktop or, with platform mobile, as on a 1600×720 phone (the scene is told it runs on mobile, gets the mobile interactable area, and the viewport becomes phone-shaped) until stop; stop restores edit mode on desktop and discards client runtime changes. The multiplayer server can retain progress across reloads: click the game restart button and verify its initial HUD before a fresh attempt. status reports player world position, HUD text and runtime errors, and in a scene that uses the game module, game: game.state as this client holds it (round, now and the server life apart; long values cut and marked), changed (every state path that moved, with before and after: since the action for input, wait, walk and click, since the previous result for status) and requests (the last few game.request calls from this client, each with its reply or refused reason; new marks those made during the action). To claim a mechanic works, show it in changed or in a reply, not in HUD text or position alone: an action whose changed is empty and whose request was refused or never sent did nothing. input holds the interaction keys E/F for durationMs (0–5000), and with waitFor first waits (up to 15 s) for HUD text containing it, for presses inside a short window; wait advances time; walk uses the controller towards to in world metres, on the ground only. click presses at x/y fractions of the viewport: a scene UI button, or a 3D object under that point (an NPC, a lever) found in a view picture first. Does not grant progress. Use view during play to see the HUD and route.',
  ui_layout: 'Measure the screen UI as the engine laid it out right now, for the layout checks of the scene-ui skill (L1–L8). Needs a running playtest: start it with platform mobile to measure the phone layout. Changes nothing, so open each dialog or panel (playtest click or input) and measure it open too. Returns the platform, the canvas the scene was told (width, height, interactableArea, in canvas units), every visible UI node that has an elementId (entity, parent, elementId, draw order, rect [x, y, w, h] in canvas units from the top-left, pointer when it takes presses, text, fontSize, visibleRect when clipped; nodes without one are only counted, so name every node you need to check) and a picture. Native touch controls are not drawn.',
  mobile_check: 'Check the screen UI on a phone, the same way every time: plays the scene as on a 1600×720 phone (it restarts a playtest if none runs as mobile), measures the HUD, opens every modal placed with addHudItem and measures it, and applies the layout rules (L1–L5, L8, overlapping HUD items; L2 against the native buttons the scene left visible), the HUD budget (H2-coverage: the HUD covers at most 25% of the phone screen; H3-centre: no HUD item sits in the middle third of the screen) and the touch-button rules (C1, C2: the native buttons a phone shows against the input actions the code reads; C3-key-letter: text that tells a phone player to press E, F or 1–4) in code. Returns passed, issues (rule, state, node, detail), the buttons used and visible, and a picture per state. Leaves the mobile playtest running. Run it after any change to screen UI, HUD, menus or player input, fix every issue, and run it again until it passes.',
  view: 'A picture of the scene. As is; or framed on entity (an id or unique name); or from a world position `from` looking at `lookAt`, in metres (16 per parcel), for a plan view from above, a facade or a close-up. Use it to check what you placed, moved or built. target mobile pictures the open mobile preview instead, with its touch controls, from the player camera (no entity, from or lookAt); with no target or camera arguments an embedded mobile preview is pictured.'
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
  if (name !== 'view' && name !== 'ui_layout' && name !== 'mobile_check') return [{ type: 'text', text }]
  const answer: unknown = JSON.parse(text)
  if (!object(answer)) throw new Error('The editor sent no answer.')
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
