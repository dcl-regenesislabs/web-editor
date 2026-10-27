---
prefab: run-progress
---

# Run Progress — AI guide

Timed courses with per-player checkpoints, collectibles, best times and a HUD.

## When to use

A race, obstacle course or collection route with start, finish and restart.
Place Health & Respawn too; read its guide and set its fallback respawnAt and
dieBelowHeight. Run Progress supplies each player's latest destination.
The project copy is normally custom/run_progress/; inspect the actual folder.

## API

Configure the placed script, with one distinct courseId per course:

- `courseId`: state namespace, default "course". One course has ONE owner: this
  placed Run Progress. Never place a second one or call `createRun` with the same
  id ("needs a unique courseId"); custom scripts read `runOf`/`restartRun` only.
- `title`: completion screen title.
- `objective`: short instruction below the status row.
- `startArea`, `finishArea`: names of existing Trigger Areas.
- `startMarker`: named entity at a safe feet position before the start area.
  A missing marker falls back to its area's floor (logged), and with no area
  either to Health & Respawn's respawnAt.
- `checkpointAreas`: ordered Trigger Area picker; stored as comma-separated names, or pass an array through setScriptParams.
- `checkpointMarkers`: one spawn marker per checkpoint, same order; a count mismatch is a problem card.
- `collectibleAreas`: comma-separated Trigger Area names, each counts once per player.
- `accentColor`: fallback six-digit hex color. Place UI Theme to style the entire scene together.
- `collectibleVisuals`: comma-separated names of plain visual entities, matching collectibleAreas in order.
- `hud`: "Full" (run panel and health on the left, clock and Restart on the right),
  "Big timer" (one large clock at the top centre plus Restart and the results screen)
  or "Hidden" (draws nothing). Both use the shared HUD layout and fit phones.
  The creator's HUD request is THIS setting: "one big timer" = "Big timer". For a
  custom HUD set "Hidden" and read `runOf()`; never draw a second clock beside it.

An empty checkpointAreas or collectibleAreas disables that goal.
All area names must be distinct. Place every area with fireWhen "every time" so
it can trigger on later attempts. Each spawn marker must be above solid ground,
clear of hazards, and outside its own checkpoint trigger. Names must be unique.

Keep each visible orb/model on a plain entity and list it in collectibleVisuals.
Attach custom bobbing or glow scripts there. Do not parent custom-script entities
under a Trigger Area prefab: Update from prefab would remove those children.
Collecting hides the named visual and its children for that player; restart shows it.
When collectibleVisuals is empty, older scenes still hide the trigger and its children.
Put static geometry, markers and areas in the authored scene so they remain editable.

The server validates area entries through the shared game module. It starts the
timer at startArea, requires ordered checkpoints and all collectibles at finishArea,
and keeps independent progress per player. Falling retains progress. Restart moves
only that player to startMarker, resets the run and retains their best time.
Local entries immediately update the timer, pickups, checkpoints and completion HUD.
Confirmed state reconciles that presentation; rejected or unconfirmed predictions
roll back. Only server-confirmed finishes update personal bests. Use this behavior
instead of adding another pickup request or waiting for server state to show feedback.

Read `src/scripts/runtime/runs.ts` for state and restart functions and
`src/scripts/runtime/gameHud.tsx` for reusable presentation components. Game state
at `run:<courseId>` contains each player's phase, checkpoint, collected IDs,
attempt, startedAt, elapsedMs and bestMs. Do not write it yourself.

Confirmed finishes also publish a persisted top-25 board at
`run:<courseId>:leaderboard`, with `{ player, score }` rows in seconds, fastest
first. Place Leaderboard, choose Source "Run best times" and the same Course Id.
It works without another script; restart and player departure retain the board.

For a moving deck, attach `scripts/moving-platform.ts` from this prefab's actual
project folder to an authored platform with a MeshCollider. Its `axis` is x/y/z,
`distance` is the travel amplitude in metres, and `periodSeconds` is one cycle.
Keep its whole path inside the parcels. Every player uses the same shared clock;
test riding and jumping from it in the engine before treating it as reachable.

## Do / Don't

- DO use the existing Health & Respawn and Trigger Area guides.
- DO size trigger areas generously enough for the moving avatar.
- DO walk toward a safe takeoff edge before longer jumps; target landing centres.
- DO keep jumps within the existing controller's reach and test the actual route.
- DON'T add a second timer, checkpoint map, collectible counter or restart handler,
  and never rewrite the run in your own script to change its look: set `hud`.
- DON'T use Game Flow merely for individual restarts; reserve it for shared rounds.
- DON'T claim completion from a build alone. Test falling, an incomplete finish,
  all pickups/checkpoints, the finish screen and Run again.

## Example

Place areas Start, Finish, Checkpoint 1–3 and Orb 1–5; create safe markers
Start Spawn and Spawn 1–3. Place Health & Respawn with respawnAt Start Spawn and
dieBelowHeight below the platforms. Place Run Progress with its default names.
The HUD and full run loop then work without another scene script.

## Creator workflow

Add and name Trigger Areas, then place Run Progress. In its inspector choose Start Area, Finish Area and
Start Marker, and use **+ Add** in the checkpoint, spawn-marker and collectible lists; row order is the
matching order. These are scene entity pickers, so no CSV or generated script is needed; names have no commas.
Place **UI Theme**, choose one accent color and Dark or Light, and Play. The HUD, result dialog, progress,
buttons and Announcer use that theme. Keep one UI Theme per scene; its settings override the fallback accent.
