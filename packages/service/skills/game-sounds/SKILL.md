---
name: game-sounds
description: "Give every player action and game event its sound, unasked, from the editor's bundled sound library: effects (coin, power-up, win, lose, click, hit, jump, footsteps, splash, laser, doors), an announcer voice, ambience loops (rain, wind, birds, waves, city) and background music loops. Use whenever you build or change a game or an interaction: pickups, scoring, timers, rounds, buttons and menus, doors, levers, hits, power-ups, teleports, win and lose — even when the request never mentions sound — and when a scene needs ambience or music. For radio streams and video, see audio-video."
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
5. **Report** the events and their sounds in one line.

## The library

Over a hundred CC0 sounds, free to publish without credit, mp3, short and normalised, in four kinds:

- **effect**: pickups, score, rounds, UI (hover, select, toggle, back, notify, typing), footsteps on grass, wood,
  stone, snow and carpet, water (splash, bubble), fights (punch, sword, laser, zap, spell, fireball, cannon,
  monsters), doors, locks, glass, metal, wood, bell, mining, books, cards, dice, thunder, fireworks, applause.
- **voice**: an announcer saying ready, set, go, three, two, one, fight, final round, hurry up, time over,
  correct, wrong, level up, new highscore, congratulations, you win, you lose, game over.
- **ambience**: loops that set a place: rain, wind, birds, night crickets, river, waves, city traffic, crowd,
  campfire, fire, machine, rumble, alarm, bubbles, sci-fi city, dungeon, horror.
- **music**: background loops of 20–70 s: tavern, happy, cave, mystery, battle, action, adventure, island,
  retro, carnival, sad, winter, sci-fi.

These are always there; take them without searching:

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
| splash | big water splash, 0.84 s | falling into water, dive |
| teleport | rising phaser, 0.42 s | teleport, portal, respawn |
| door-open / door-close | wooden creak / shut | doors, chests, gates |
| lever | metal clack, 0.21 s | lever, switch, latch, lock |
| explosion | deep boom, 2.04 s | explosion, cannon, big impact |

For anything else, look it up:

- **Decentraland editor (web)**: `scene_request {type:"findSounds",query:"footstep wood"}` answers the
  matching names with their description and length; add `kind:"music"` (or effect, voice, ambience) to narrow
  it, or send only a kind to list all of it.
- **Decentraland Studio (desktop)**: `{baseDir}/sounds/properties.json` is the index: every name with its
  description, kind, length and loop flag.

Use only names the index has. When nothing fits, use the closest and say so in the report; the creator can
import their own file into `assets/audio/` later.

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
- **Ambience**: on the entity they belong to, `loop: true, playing: true`, volume 0.3–0.5, so they sit
  under the effects: a campfire on the fire, a river on the river, `global: false`. Stop them when the thing
  goes away or the round ends.
- **Music**: one track for the whole scene, on one entity made for it, `global: true, loop: true,
  playing: true`, volume 0.25–0.4, started once when the scene starts. One track plays at a time: to change it (calm
  lobby, then battle), stop the first before starting the next. Pick it from the game's mood, and say which in
  the report; the creator may want another.
- **Voice**: the announcer says what the screen shows (ready, go, you win) and goes with its effect, not
  instead: `voice-go` and `start` together, `voice-you-win` after `win`.
- **Volumes**: effects 0.7–1, clicks 0.5, loops 0.3–0.5. The win sound may be the loudest thing in
  the game; a click never is.
- **Timing**: the sound fires on the frame the event happens. A thing that vanishes waits ~0.1 s so
  its sound and pop cover the disappearance.
- **Only events**: never start a sound from every `update()` tick; a countdown plays its tick once
  per second when the shown number changes.
- **UI**: a button plays `click` on press, before it acts (D4). A dialog plays `open` and `close`. A
  denied press plays `error`.

## Report

One line for all events: `coin pickup → coin (pitch varied) · gold coin → gem · last 5 s → countdown-tick ·
time up → time-up · button → click`. Then what could only be judged by ear: the mix and whether a sound
fits. That is for the creator to try in Preview.
