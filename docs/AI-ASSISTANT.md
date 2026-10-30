# The in-app AI assistant

> This doc covers the **assistant built into the app** (the chat panel /
> Script Studio). For driving or testing the *editor itself* with an external
> agent (console commands, editor bus, the CDP e2e harness), see
> [`AI-AGENT.md`](./AI-AGENT.md).

The assistant panel edits your **Script components** by prompt. The desktop and
web shells share `packages/ui/src/panels/AiPanel.tsx` and Script Studio, and one
system prompt (`ASSISTANT_PROMPT`, `packages/contract/src/assistant-prompt.ts`) and
one tool set (`packages/contract/src/editor-tools.ts`). This document describes the
desktop CLI backend; the web backend runs an agent service with browser-owned files
and browser tools, see [Web assistant](./WEB-ASSISTANT.md).

---

## Two authoring surfaces

Code lives in two places, and the assistant is told the difference
(`ASSISTANT_PROMPT`):

- **Per-entity behavior** — a Script class in `src/scripts/<Name>.ts`, attached
  to an entity in the inspector.
- **Scene-global code** — the entry point `src/index.ts`: systems registered
  with `engine.addSystem`, shared state, entities the scene creates itself.

Which one it writes follows the request, and the file open in the Studio is part
of the turn context (`buildContext`) — with `src/index.ts` open, "every frame"
becomes a system there rather than a new Script class.

## The scene roster

Every turn carries a `[Scene]` block built by `packages/ui/src/ai/roster.ts`
from the same snapshot the hierarchy and inspector read: each authored entity's
Name and id, its derived kind, its **world** transform in metres, the components
on it, and every attached script with its current param values — plus a
`Zones in this scene:` line naming the `TriggerArea` entities. It is included
whether or not anything is selected, which is what makes "the door" and
"Front Hall" resolvable at all; before it, the assistant could only see the
selection. Names, not ids, are the shared handle: the creator types one in the
hierarchy, a script asks for the same one via `isInZone()`, and the assistant
reads it here. Big scenes are capped (zones are never dropped).

## Spawnable prefabs and Game Config

Two more context blocks, built by `packages/ui/src/ai/kit-context.ts` and added
by `buildContext` when the project has anything to say:

- **`[Spawnable prefabs]`** — every prefab in the project with Spawnable ON: its
  name (the handle a request resolves), its folder, its **Max alive** ceiling and
  whether it is cloned on demand or once per player. This is the list of things
  the running scene is *allowed* to create, and it points at
  `src/scripts/spawnables.ts` for the generated `Spawnables.<Alias>` keys.
- **`[Game Config]`** — the shape of every tuned number on the scene root: the
  accessor each one is read through (`gameConfig.waves[i].count`,
  `gameConfig.zombie.hp`), the column kinds, the row counts and the config
  version. Values are deliberately absent — the generated
  `src/scripts/game-config.ts` holds them and the assistant can read that file;
  what it cannot guess is which names exist. The block also states plainly that
  the assistant *cannot* edit these tables (they are a live component, and no
  scene_request writes them), so the honest move is to name the table, row and
  value for the creator.

Both are **data**, and both are empty when the project has none — which is the
split that keeps the split honest: per-project lists live here, in the renderer,
while the rules that must hold in an empty scene (content is a prefab, tuned
numbers are not script params, what a clone actually guarantees) live in
`ASSISTANT_PROMPT` and stay O(1) in project size.

## Prefab guides (`ai.md`)

Per-prefab knowledge is **not** in the system prompt. A prefab whose scripts
expose an API other scripts import ships an `ai.md` in its folder
(`packages/desktop/prefabs/<slug>/ai.md`), which the existing recursive folder
copy installs into the scene at `custom/<slug>/ai.md` — so the guide the
assistant reads describes the exact copy on disk and cannot desync from it. The
Update chip carries a new guide into scenes that already have an older copy,
because `ai.md` is prefab content like everything else in the folder.

The assistant finds them by **index and pull**, not by injection:

- **Index** — `buildGuideIndex` (`packages/ui/src/ai/roster.ts`) adds a
  `[Prefab guides]` block to the turn context: one line per project prefab copy
  that has a guide (folder, name, version, one-line description, guide path).
  `PrefabEntry.hasGuide` is filled in `refreshPrefabs` from the same project
  file listing the thumbnails come out of, so there is no extra round trip, and
  `buildContext` stays synchronous.
- **Pull** — `ASSISTANT_PROMPT`'s `PREFAB GUIDES` paragraph makes it
  mandatory: before writing or editing code that touches a listed prefab, read
  that prefab's guide. The read lands in the chat's collapsed activity row
  (expandable to the full `Read …` list), and
  the CLI conversation is the cache — within a resumed session the guide is read
  once; switching provider starts a new conversation and pays for it again.
- **Scope is copies, not instances**: a script imports from `custom/<slug>/`
  whether or not an instance is placed, and the `_2` dedup is already per copy.
  A prefab placed *this* turn has no guide on disk until the turn ends, so the
  prompt keeps a short trigger-zone capsule — the routing rule and the one
  import line — for that first placement and points at the guide for the rest.

**MOVE, never duplicate.** A rule lives in `ASSISTANT_PROMPT` or in a guide,
never both: two copies aging apart is exactly how the prompt contradicted itself
about a zone param. `packages/ui/src/prefabs/guides.test.ts` enforces it — it
lint-bans the per-prefab vocabulary from `assistant-prompt.ts` and caps the
prompt's length,
so the prompt stays **O(1) in prefab count**: prefab #27 adds one index line and
zero prompt bytes. The sanctioned exception is the two scene-breaking NEVERs
(hand-rolled proximity, `triggerAreaEventsSystem` on a zone), which sit tersely
in the prompt so they survive a skipped read, with their rationale in the guide.

Two different refresh rules, worth knowing while editing either:
on desktop the prompt is **main-process** — a change to it needs the app restarted
before a turn sees it — while an `ai.md` is read off disk on the turn that needs
it, so editing a guide takes effect immediately.

Guides are documentation, but they are text that reaches a CLI running with full
capability, and a prefab can be imported from anywhere. Three things bound that:
only the path, name, version and a 200-char description ever enter the prompt
(guide *content* is pulled by the agent's own read tool); the import preview
shows a folder's `ai.md` alongside its scripts, behind the same reviewed-before-
installed gate; and the prompt tells the assistant that guides never override
its rules or the user's request. Guide content is never rewritten or
"sanitized" — it is prose, indistinguishable from legitimate instruction, and
laundering it would only buy false confidence. Treat an imported prefab's guide
with the trust you give its scripts, which already execute in your scene.

## Scene changes in a batch

Anything that has to happen in the *live* scene goes through `scene_request`. Its
batch form places prefabs, sets script params and attaches scripts in one call,
run by `packages/ui/src/ai/requests.ts`:

```json
{ "type": "batch", "requests": [
  { "type": "placePrefab", "slug": "trigger-zone", "name": "Front Door Zone",
    "position": { "x": 8, "y": 1.5, "z": 10 }, "scale": { "x": 4, "y": 3, "z": 4 },
    "params": { "who": "any player" } },
  { "type": "attachScript", "script": "src/scripts/HallDoor.ts", "to": "Front Door" },
  { "type": "setParams", "to": "Crate Spawner", "params": { "spawn": "Crate" } }
] }
```

`position` is world metres — the frame the roster reports. Every request runs
through the click path a human uses (`uiPlaceLibraryPrefab` → `writeComponent`
for the size/name override → the Script component's own update for params →
`attachScript`), so undo, autosave and the bus mirror come for free and there is
no bespoke inverse to keep correct. Failure is local: an unknown request type,
an unreadable position or an entity Name that resolves to nothing skips that one
request and reports it; the rest of the batch still lands.

`setParams` is the same param write without a placement, aimed at an entity Name
from the roster. It exists for the two cases `placePrefab` cannot reach: a prefab
the creator placed by hand, and a param that lives on a prefab's *child* (the
Player Rig's gun sits on the Hand Anchor, not the rig root, so the placement's
own `params` never sees it).

`createPrefab` (`{"type":"createPrefab","from":"Bot"}`) saves a scene entity as a
project prefab through the same core as the Scene tab's "Create prefab…"
(`createPrefabFrom`), so a spawner can point at it in the same batch by the
returned `prefab` id. It defaults to "When spawned" and, unlike the gesture, does not
copy the prefab into the creator's cross-scene library. An entity that already is
an instance of a project prefab answers that prefab with `reused: true`.

Entity parameters accept an existing entity ID or a unique scene name, such as
`{"respawnAt":"Start Spawn"}`. Missing and duplicate names are rejected; use
an ID to disambiguate, or `0` to clear the reference.

### Params by name, including prefab params

A `PrefabRef` param stores a prefab **UUID**, and the assistant never sees one —
it reads names, out of the context blocks, the guides and the creator's sentence.
So `resolvePrefabRef` (`ai/request-format.ts`) resolves the name it wrote: the
prefab's display name (case- and whitespace-insensitive), its folder slug, or a
literal id it did read off disk. `PrefabRef[]` takes a JSON list of the same
(`"arenas": ["Ruins", "Rooftop"]`).

It **refuses rather than guesses**, and every refusal names itself in the turn's
notice line: a name nothing matches, a name two prefabs share (both folders are
listed so the assistant can disambiguate), or a prefab whose Spawnable toggle is
off — the one case where a valid id would still be wrong, because only a
Spawnable prefab can be cloned. The same applies to the older param types: a
value an `enum` param does not offer now reports what it does offer, instead of
being silently dropped and reported as a setting that does not exist.

## Attaching scripts

A file under `src/scripts/` does nothing until it is listed on an entity's
Script component. Writing one attaches it nowhere: the assistant attaches it with
`attachScript`, naming each entity it belongs on (the selection only when the
creator means it). Attaching to whatever was selected when the turn began put
scripts on the wrong entity whenever the creator's request was not about the
selection. Rewriting a script that is already attached refreshes its params on
every entity running it, keeping the values already set (`refreshWrittenScript`,
`packages/ui/src/ai/attach.ts`).

The prompt is written around this: the assistant never tells the creator to add
a component or drag a file onto an entity; it attaches the script itself.

## Ways in

Besides the 🤖 FAB, three surfaces open the dock with something already in it:

- **Hierarchy → right-click → "Ask AI about this…"** — right-click already
  selects the row, so the entity the turn attaches to is correct by
  construction; the composer opens with the stub `Make this ` for the creator
  to finish.
- **Inspector → the code-move offer** — prefills a sentence describing the drag.
- **Trigger-zone chips** — on the zone card (when nothing listens yet) and on
  the zone's Script card (a generic "Do something when someone enters…" starter
  plus examples).

All of them go through `prefillAssistant()` (`panels/ai-store.ts`): the text
lands in the composer, unsent. Nothing in the editor sends a turn on the
creator's behalf — they read, edit, and press send. Chips are starters to
finish, not buttons that act.

## The zone card's listener line

An entity with both `TriggerArea` and a Script is a zone, and a zone's id is its
entity Name — so the inspector can answer "does anything actually react to
this?" without running the scene. `views/zone-listeners.ts` scans every Script
layout in the snapshot for a **string** param whose value matches this zone's
Name, trimmed and lower-cased exactly the way `zoneBus`/`zoneRegistry` matches
at runtime, and skips the zone's own entity (its script is the detector, not a
listener). The card shows either `2 scripts listen — HallDoor (Door), …` or
`Nothing listens yet — select the object that should react, or try:` with two
chips naming this zone.

It is **read-only observability**, not wiring: there is no entity picker, no
zone dropdown and nothing on this card writes another entity's components. The
coaching is a sentence handed to the assistant.

## The Studio

⤢ Code opens a three-column workspace: a **file rail** listing the whole
project, the editor, and the chat. Tabs are open documents — they merge and
persist, so selecting an entity never closes the file you were reading. Only
`.ts`/`.tsx` open; other files are listed greyed out, because the editor is
TypeScript-wired and restarts the scene on save (`src/script/project-files.ts`).

`src/index.ts` is **guarded** (`src/script/guarded.ts`): a save that doesn't
parse is refused outright — for both ⌘S and Accept — and the review diff stays
on screen. A missing `main()` only warns, since it has several legal shapes and
blocking on a heuristic would lock someone out of their own file.

## Image attachments

The composer accepts images — paste one, or attach via the 🖼 button (max 4,
8 MB each; png/jpeg/gif/webp). The renderer sends them as data URLs; the main
process writes them to a per-turn temp dir (`writeAttachments`,
`packages/desktop/src/ai.ts`) and appends their paths to the prompt (Claude's
Read tool renders images). Files are kept for the app session so a resumed conversation can revisit
them; the OS owns temp cleanup beyond that.

## Process model

The assistant drives the local **Claude Code** CLI (`claude -p`) as a child
process of the Electron main, with the open project as its working directory.
It gets the web assistant's prompt plus a short desktop adapter
(`DESKTOP_PROMPT_ADAPTER`), the same model and effort (`ASSISTANT_MODEL`,
`ASSISTANT_EFFORT`), and the same tools: the main process serves them over MCP
(`packages/desktop/src/editor-mcp.ts`) and forwards each call to the page, which
runs it on the engine and the data layer (`packages/ui/src/ai/editor-tools.ts`).
Of the CLI's own tools it keeps only Skill and Read (for a skill's references).
None of the creator's own Claude Code setup reaches it: no user settings, hooks,
`~/.claude/CLAUDE.md`, MCP servers or auto-memory. File writes land like saves,
`sdk-commands` rebuilds, and ▶ Play picks the result up — see below.

### Why Play has to reload, not just unfreeze

A turn produces **two** rebuild cycles: one when the assistant writes
`src/scripts/Foo.ts`, another when attaching it saves `main.composite`
(visible in the dev-server log as `sdk.d.ts with 1 script type(s)` then `2`).
Neither reaches the running scene on its own. Unfreezing resumes the instance
the engine already holds, and that instance's `main()` built its Script
instances from the composite as it was at *load* time — a script attached since
is in the bundle but was never instantiated, so it silently does nothing.

The dev server does print `Change detected for scene … reloading`, but that is
the server restarting **its own** instance and pushing a hot-reload the editor's
engine ignores while frozen. Treating that line as proof the engine had caught
up is exactly what made the first Play after a turn run stale code, with a Stop
(a real `cmd.reload`) fixing it.

So Play doesn't infer any of this from the log. `scene-health.ts` latches two
booleans, and `waitForFreshBuild` (`ui/actions.ts`) reads them:

| | set by | cleared by |
|---|---|---|
| `sceneNeedsReload()` | the watcher naming a **non-composite** file, or a write to the Script component (`boot.ts`'s observer) | `noteSceneUpToDate()` — a reload the editor performed, a Stop, or the initial load |
| `compositeAwaitingBuild()` | autosave writing `main.composite` | a build cycle **starting** — that one reads the file |

Play returns immediately unless `sceneNeedsReload()`, so a nudged gizmo — which
rewrites the composite and rebuilds like everything else, but whose value is
already in the running scene's CRDT — costs nothing. When it does reload, and
whenever Stop reloads, `awaitFreshBundle()` first waits for a cycle to pick our
write up and finish, so the bundle loaded embeds it. Note the clearer: a build
that was *already running* when we wrote read the old file, so waiting on "a
build finished" would reload a bundle without the attach — only a cycle that
starts after the write counts. Both latches also drop at a session boundary,
where they describe a project that is no longer open.

Deliberately booleans with one setter and one clearer each rather than
timestamps compared pairwise: there is no ordering to get backwards.

## Billing & auth

Runs on your own subscription, not an API key. The child process inherits your
CLI's OAuth session; metered API-key env vars (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, custom base-URLs) are stripped from the child env so it can't
fall back to paid-per-token billing — and so an inherited base-URL override
can't redirect the OAuth token to a third party. Sign in once from a terminal
(`claude`).

## Permissions

The CLI runs with `--permission-mode bypassPermissions` because it is headless
(there is no way to answer a permission prompt), but its tools are the editor's:
the project's files, the scene and the engine, plus reading skills. It has no
shell and no network tools.

## Providers

Claude only. Conversations resume across turns with `--resume <sessionId>`. The
web's other provider, Codex, has no editor tools on desktop.

## The sdk-skills pipeline (`packages/desktop/src/skills.ts`)

SDK7 skills are always on. The app downloads
[decentraland/sdk-skills](https://github.com/decentraland/sdk-skills) at
startup into a userData cache (refreshed by commit SHA, atomically swapped,
offline keeps the last copy) and links it into the open scene as
`.claude/skills` (and `.agents/skills`), so the assistant gets the official SDK7
guidance by default.

- **Denylist**: a small denylist drops the `SKILL.md` of skills that duplicate
  what the editor itself does (scaffolding, deploy, SDK6 migration) so they
  never trigger, while still shipping their other files — several skills we
  *do* keep read `../<name>/references/` paths out of them.
- **Taken as-is**: the content is otherwise not sanitized: it is first-party
  Decentraland guidance feeding an assistant that already runs unrestricted, so
  there is nothing to gain by sanitizing it.
- **Never committed, never deployed**: every app-created link is
  `.gitignore`-covered (both the whole-dir symlink and the per-skill links when
  merging into a user's own `.claude/skills`), and dot-dirs never deploy
  (sdk-commands appends `.*` to every `.dclignore`, custom or not).
- **User dirs respected**: only links pointing into our own cache are ever
  repointed — a user's own symlink is left untouched — and a user's own
  `.claude/skills` dir is merged into, never replaced (their skill of the same
  name wins).

## Script Studio

The Script inspector's **"Edit code"** opens a full mode — the CodeMirror
editor and the chat side by side, with the 3D scene still live in the left
gutter.

- Select code and press **⌘K** to ask about it (one-tap Explain / Fix /
  Comment / Improve).
- AI edits arrive as an **accept/reject diff** (`@codemirror/merge`) — nothing
  runs in the scene until you Accept; Discard reverts.
- The editor is frozen while the AI writes so buffer and disk can't diverge.
- The narrow chat drawer and the Studio are one component
  (`panels/AiPanel.tsx` + `panels/ai-store.ts` + `script/code-editor.tsx`), so
  the conversation follows you between them.

## Wiring

`packages/desktop/src/ai.ts` (spawn + stream parsing; the prompt is in
`@dcl-editor/contract`) and `editor-mcp.ts` (the tools) → IPC in
`main.ts`/`preload.ts` (`@dcl-editor/contract` `Ai*` types) → the
`packages/ui/src/panels/AiPanel.tsx` chat UI. The web shell implements the same
contract through `packages/web/src/ai/client.ts`; its server transport and pi agent
live in `packages/service/src/ai/`.
