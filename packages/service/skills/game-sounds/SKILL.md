---
name: game-sounds
description: "Give every player action and game event its sound, unasked, from the editor's bundled sound library (coin, power-up, win, lose, time-up, click, open, close, hit, jump, door, explosion, ambient loops). Use whenever you build or change a game or an interaction: pickups, scoring, timers, rounds, buttons and menus, doors, levers, hits, power-ups, teleports, win and lose — even when the request never mentions sound. For music, radio streams and video, see audio-video."
---

# Game sounds — every action answers with a sound

A game without sound feels broken, and creators rarely ask for it. Sound is part of each mechanic,
like its collider: when you build a pickup, the pickup sounds; when you build a round, it starts,
ticks and ends with a sound. Do not ask whether to add sounds and do not leave placeholders: pick
from the library below, wire them, and say which sound each event got.

## The loop

1. **List the events.** Every player action and every game event: pick up, score, buy, open,
   close, press, hit, jump, power up, round start, last seconds, time up, win, lose. The scene-ui
   inventory (C1) is a good start; add the events no button triggers.
2. **Give each event a sound** from the library (table below). One event, one sound; two events
   that feel different never share one.
3. **Wire it** (code below), next to the code that makes the event happen.
4. **Pair it with something to see**: a scale pop (`Tween`), a flash, a number. Sound and sight
   land on the same frame.
5. **Report** the events and their sounds in one line each.

## The library

Kenney's CC0 sounds, mp3, short and normalised. `loop` ones are ambient beds.

| Sound | What it is | Use it for |
|---|---|---|
| coin | bright rising blip, 0.39 s | coin or collectible picked up |
| gem | glassy chime, 0.26 s | rare item, gold coin, crystal |
| power-up | rising synth sweep, 0.89 s | power-up taken or activated, boost |
| point | short confirm blip, 0.31 s | point scored, checkpoint, correct answer |
| countdown-tick | single beep, 0.13 s | each of the last seconds, 3-2-1 |
| start | three rising tones, 0.6 s | round start, "go" |
| win | rising 8-bit fanfare, 0.81 s | win, level complete, new record |
| lose | falling 8-bit jingle, 0.81 s | lose, game over |
| time-up | falling buzz, 1.28 s | time up, round over |
| click | soft click, 0.05 s | every button press (D4) |
| open | short rise, 0.18 s | panel, menu, dialog, shop opens |
| close | short fall, 0.18 s | panel, menu, dialog closes |
| error | low buzz, 0.24 s | denied, locked, not enough coins, too early |
| jump | springy zip, 0.39 s | jump, bounce pad, launch |
| land | soft heavy thud, 0.55 s | landing, something dropped or placed |
| hit | punch impact, 0.26 s | hit, damage taken |
| splat | wet squelch, 0.52 s | slime, goo, the closest to a splash |
| teleport | rising phaser, 0.42 s | teleport, portal, respawn |
| door-open / door-close | wooden creak / shut | doors, chests, gates |
| lever | metal clack, 0.21 s | lever, switch, latch, lock |
| explosion | deep boom, 2.04 s | explosion, cannon, big impact |
| fire-loop | roaring flame (loop) | fire, lava, furnace, jet |
| rumble-loop | low rumble (loop) | machinery, cave, earthquake |
| machine-loop | electronic chatter (loop) | computer room, lab, generator |

When nothing fits, use the closest one and say so in the report; the creator can import their own
file into `assets/audio/` later.

## Getting a sound into the project

The sound lives in the project at `assets/audio/library/<name>.mp3`.

- **Decentraland editor (web)**: `scene_request {type:"addSound",name:"coin"}` copies it and answers
  the path.
- **Decentraland Studio (desktop)**: copy `{baseDir}/sounds/<name>.mp3` to
  `assets/audio/library/<name>.mp3`, creating the folder. Copy only the sounds you use.

## Wiring it

`AudioSource` plays one clip at a time per entity, and `playSound` restarts it, so a sound that
repeats fast never stacks up. Two sounds that can play at once need two entities.

```ts
import { engine, AudioSource, type Entity } from '@dcl/sdk/ecs'

// one entity per sound, made once: global = heard the same anywhere (HUD, game flow)
const sounds = new Map<string, Entity>()
function sound(name: string, volume = 0.8): Entity {
  const path = `assets/audio/library/${name}.mp3`
  let e = sounds.get(path)
  if (e === undefined) {
    e = engine.addEntity()
    AudioSource.create(e, { audioClipUrl: path, playing: false, volume, global: true })
    sounds.set(path, e)
  }
  return e
}
export function play(name: string, pitch = 1): void {
  const e = sound(name)
  AudioSource.getMutable(e).pitch = pitch
  AudioSource.playSound(e, `assets/audio/library/${name}.mp3`)
}

// at the event, never from every update():
play('coin', 0.95 + Math.random() * 0.1) // repeated sounds vary their pitch a little
```

- **Where it comes from**: a sound that belongs to a thing in the world (a door, a fire, a machine)
  goes on that thing's entity with `global: false`, so it gets louder as the player walks up. HUD,
  menus and game flow (score, timer, win) are `global: true`.
- **Loops**: on the entity they belong to, `loop: true, playing: true`, volume 0.3–0.5, so they sit
  under the effects. Stop them when the thing goes away or the round ends.
- **Volumes**: effects 0.7–1, clicks 0.5, loops 0.3–0.5. The win sound may be the loudest thing in
  the game; a click never is.
- **Timing**: the sound fires on the frame the event happens. A thing that vanishes waits ~0.1 s so
  its sound and pop cover the disappearance.
- **Only events**: never start a sound from every `update()` tick; a countdown plays its tick once
  per second when the shown number changes.
- **UI**: a button plays `click` on press, before it acts (D4). A dialog plays `open` and `close`. A
  denied press plays `error`.

## Report

One line per event: `coin pickup → coin (pitch varied) · gold coin → gem · last 5 s → countdown-tick ·
time up → time-up · button → click`. Then what could only be judged by ear: the mix and whether a sound
fits. That is for the creator to try in Preview.
