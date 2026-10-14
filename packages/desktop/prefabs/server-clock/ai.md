---
prefab: server-clock
claims-messages: runtime.timeSync, runtime.timeSyncResponse
---

# Server Clock — AI guide

One clock every player agrees on: the Multiplayer Server's time, NTP-sampled by
each client, so "the round ends at 12:04:30" means the same instant everywhere.

The project copy is normally custom/server_clock/ — check what is on disk, a
second copy is custom/server_clock_2/.

## When to use

Show the current server time, or reuse its synchronization module for a custom
shared deadline. For a ready-made round countdown use Game Flow with display
"2D UI". For a player's elapsed course time use Run Progress. This prefab shows
clock time; it does not start or end rounds. Needs a Multiplayer Server scene.

## API

    import { getServerTime, initTimeSync, isTimeSyncReady } from './runtime/timeSync'

- getServerTime(): server-clock now, in epoch milliseconds. On the server it is
  Date.now(); on a client it is Date.now() plus the measured offset.
- isTimeSyncReady(): false until the first samples land (a client takes a moment
  after joining, and re-syncs every minute). Until then getServerTime() is just
  local time — show a placeholder rather than a wrong time.
- initTimeSync(): starts the right half for the side it runs on. Idempotent, and
  the placed prefab already calls it, so you only need it in a script that uses
  the clock in a scene where the prefab might not be placed.

Params of the prefab's script — set them in the placePrefab request:
- label: text above the time (default 'SERVER TIME'; empty shows the time alone).
- utc: true (default) shows UTC, false shows each viewer's own timezone. A shared
  deadline every player reads should stay UTC — local time differs per player.
- display: '3D text' (default) is floating text at the entity, '2D UI' is an
  overlay on the player's client instead.
- position: where the 2D overlay sits — 'top' (default), 'top left', 'top right'
  or 'bottom'. Ignored for '3D text'.

The overlay uses UI Theme and the shared HUD layout: HUDs in the same position
stack instead of overlapping. Multiple placed clocks keep their own label and time.

## Shared deadlines

Express a deadline as an absolute server timestamp, share THAT, and derive the
countdown locally every frame:

    const endsAt = getServerTime() + 60_000
    const secondsLeft = Math.max(0, Math.ceil((endsAt - getServerTime()) / 1000))

## Do / Don't

- DON'T build a countdown out of Date.now() or by accumulating dt: two players'
  clocks differ by seconds and a reloading client loses its accumulator.
- DON'T re-implement time sync or add another timestamp message. Import this
  module; the message names it registers are the scene's, and a second registrar
  collides with it.
- DON'T format a time before isTimeSyncReady() — render '--:--:--' or hide it.
- The server decides WHEN, the client only renders it. Anything that must be the
  same for everyone (round end, spawn moment) is decided on the server side of
  the bundle, with isServer() from '@dcl/sdk/network'.

## Example

"Show a 60-second round timer everyone sees the same": place Game Flow with
roundSeconds 60, countdownSeconds 3 and display "2D UI". Place UI Theme to choose
its palette. Use Server Clock separately if the scene also needs the time of day.
