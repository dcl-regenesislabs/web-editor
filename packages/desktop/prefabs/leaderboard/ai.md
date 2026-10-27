---
prefab: leaderboard
---

# Leaderboard — AI guide

A panel or screen overlay that shows game scores or persisted course best times.
The server validates and stores scores; this prefab displays them.

The project copy is normally custom/leaderboard/ — check what is on disk, a
second copy is custom/leaderboard_2/.

## When to use

For a course, place Run Progress and choose Source "Run best times" on this prefab.
Use the same Course Id (default "course"). Confirmed finishes automatically fill
the board, fastest first, and survive player departures and server restarts. No
custom score code is needed. One course has one top-25 board.

The 3D panel is solid and reads from its -z side: at identity rotation players
stand at -z looking toward +z. Turn the board by rotating its root; never move or
flip the text child.

For other scoring systems choose Source "State key" and provide server-owned rows
as below. Place one panel per board; use 2D UI when the scores belong on screen.

## API

There is nothing to import. The contract is the state key:

    game.setState({ leaderboard: [{ player, score }, …] })

- Rows are objects. The player field may be `player`, `p`, `address`, `wallet` or
  `name`; the score field may be `score`, `points`, `pts`, `value`, `seconds`,
  `time` or `best`. Anything else in a row is ignored, and a row missing either
  half is skipped.
- WHICH SIDE: the `game.setState` that writes the rows goes on the SERVER, inside
  the `if (isServer())` branch. The panel itself reads and paints on every
  player's client — that half is this prefab's, and you write no client code.
- The panel sorts the rows itself, so the writer's order does not matter.
- Until the key holds a row, players see "No scores yet — be the first!" ("No
  times yet" on an `asc` or Run best times board). A board that stays empty in
  play means nothing writes its `boardKey` — check the server branch.
- Late joiners get the board from the snapshot. Write rows with `game.setState`,
  never with a broadcast — a message is a moment and a board is a fact.

Params of the prefab's script — set them in the placePrefab request:

- `source`: `State key` (default) or `Run best times`.
- `courseId`: matches Run Progress when source is `Run best times`.
- `display`: `3D panel` (default) or `2D UI`. The overlay uses UI Theme.
- `position`: `left` or `right` column of the shared HUD layout for the overlay.
- `title`: the heading on the panel (default "Leaderboard").
- `boardKey`: the `game.state` key to read (default `'leaderboard'`). Game Flow
  reads the same key for its winners line — point both at one key.
- `sort`: `'desc'` (highest wins — points) or `'asc'` (lowest wins — best times,
  which also renders the score as m:ss).
- `rows`: how many places to list (default 8; max 25 in 3D, 10 on screen, 5 on phones).

For Run best times, Board Key and Sort are hidden: the course supplies the key,
scores in seconds and ascending order. The shared key is `run:<courseId>:leaderboard`.

## The all-time board idiom

`game.playerData` cannot be listed, so an all-time or season board is kept by
folding results into `game.saved` at the end of a round and copying the top N
into `game.state` — all of it in the server branch:

    const board = fold(game.saved.get('bestTimes') ?? [], results)
    game.saved.set('bestTimes', board)
    game.setState({ bestTimes: board })

Then place a second Leaderboard with `boardKey: 'bestTimes'`.

## Do / Don't

- DON'T keep a score on a client and send it up. Count it in a server handler; a
  number a client reports is a claim.
- DON'T write more than the visible places into the key. Fold to the top ten in
  server code — every extra row rides the wire on every change.
- Rows show display names: a player in the scene is named live; Run best times
  stores the finisher's name when the server can see it. Give your own rows a
  `name` beside `player` to keep it for offline players; else a short wallet shows.

## Example

Without code: place Leaderboard, choose Source "Run best times", leave Course Id
"course" to match Run Progress, and choose Display "2D UI". Finish the course;
the server-validated time appears. Restarting or leaving does not erase the board.

"Show the fastest climbers": in a handler inside the server branch keep the list,
and place a board on that key.

    game.setState({ leaderboard: runs.sort((a, b) => a.time - b.time).slice(0, 10) })

with `boardKey: 'leaderboard'`, `sort: 'asc'`, `title: 'Best Times'`.
