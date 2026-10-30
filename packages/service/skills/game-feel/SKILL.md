---
name: game-feel
description: "Make a game feel like its genre from the first build: the camera, the controls and their verbs, what the player holds, the immediate feedback on every action, the effects, the look of the HUD and the first minute of play. Use whenever you build a game or a game mechanic, and above all when the creator names a genre or a known game (\"like Overcooked\", \"a kart race\", \"a tower defense\") — the genre decides these things before any code. For the HUD's layout rules see scene-ui; for sounds see game-sounds; for particle payloads see particle-system."
---

# Game feel — what makes it play like the game they meant

A game that compiles, passes its checks and still plays badly fails on what this skill covers. Creators
rarely ask for these things by name: "like Overcooked" already says top-down camera, items carried in the
hands, chop by holding a button, orders as small cards. Decide them yourself, before the first script, and
write them in the plan or, when you build without one, in the first line of the reply.

## 1. Read the genre

Name the genre the request implies and what defines it. Answer each row before building:

| Decision | Ask yourself | Examples |
|---|---|---|
| **Camera** (F1) | Must the player see the whole play area at once? | Overcooked, party games, puzzles, tower defense: fixed top-down or isometric. Racing, platformers, exploration: the default third person. |
| **Verbs** (F2) | What does the player do, in one word each? | Pick up, drop, chop, cook, serve, throw, jump, shoot. At most three on buttons. |
| **Held things** (F3) | Does the player carry something? | An ingredient, a ball, a key, a box: it is in the hands and every player sees it. |
| **Pace** (F4) | Rounds, a clock, waves, endless? | Overcooked: 2–3 minute shifts with stars. |
| **Failure** (F5) | What goes wrong, and how does the player see it coming? | Burning food smokes before it burns; an order's bar turns red before it expires. |
| **First minute** (F6) | How does a new player learn the loop? | The first order is the easiest, and the next step is pointed at in the world. |

Then search the library for the pieces before writing systems: asset_request search_prefabs for "carry",
"pickup", "station", "camera", "timer", "round", "leaderboard". A placed prefab with its guide beats code you
write in the turn; read its ai.md before wiring it.

## 2. Camera (F1)

- A game where the whole area matters gets a **fixed camera** that frames all of it, on a phone too (a phone
  is wider and shorter than a monitor, so frame for 1600x720). That is the built-in "camera-rig" prefab:
  placePrefab it at the play area's centre with its scale set to the area's size, then read
  custom/camera_rig/ai.md. Never write VirtualCamera or MainCamera code yourself.
- Keep the play area compact enough to fit one frame: an Overcooked kitchen is about 12 x 8 m, not a parcel
  of scattered stations.
- Look at it from the camera's point of view before you finish: view from the rig's position, and on mobile.

## 3. Controls and verbs (F2)

- One verb per button, and the button says the verb: on a phone the touch button shows its action icon; on a
  desktop the hint shows the key and the verb. Never a bare "E" or "F" on a phone (mobile_check fails it).
- The prompt over a thing names what pressing does **now**: "Pick up tomato", "Put on board", "Chop", "Serve".
  A thing you cannot use right now shows no prompt.
- Holding is a verb too: chopping, washing and repairing are hold-to-progress with a progress bar on the
  thing, not a single press.
- Tap targets on the world (IA_POINTER on an object) work on both platforms; prefer them for anything rare.

## 4. Held things (F3)

- What the player holds is **in the hand**: AvatarAttach to the right hand (AAPT_RIGHT_HAND) with an offset
  that reads as held, not floating at the avatar's position. Every other player sees it too, so who holds
  what is shared state. The Pickup Item prefab does this; read its guide.
- One held thing at a time unless the genre says otherwise. Putting it down on a station shows it there, on
  the station, at the station's size.
- An item that changes (raw to chopped, clean to dirty) changes its model or its look at once, so the player
  sees the change without reading the HUD.

## 5. Feedback on every action (F4)

Every action answers on the frame it happens, on the player's own client, before the server confirms:

1. **Show it now**: the item moves to the hand, the progress bar starts, the number ticks. The server's
   answer then confirms it, or rolls it back with a reason the player sees ("Too far", "Nobody ordered that").
   Never leave a press with nothing to see while the request is in flight.
2. **Sound** on the same frame (game-sounds).
3. **Motion**: a scale pop on what changed (Tween scale 1 to 1.2 to 1 in 150 ms), a small hop when something
   lands, a shake when something fails.
4. **An effect where it matters**: steam while cooking, smoke before burning, sparks on a hit, confetti on a
   win. Payloads are in particle-system's references/particle-presets.md; keep maxParticles small (the scene's
   total is about 1000) and stop emitters you no longer need.
5. **Floating text** for gains and losses: "+20" rising from the serving window over half a second.

A failed action is feedback too: the error sound, a short shake, and the reason in a toast. A press that the
server refuses and that the player cannot see is the worst bug a game can have.

## 6. The HUD of a game (F5)

The world is the game; the HUD frames it. The HUD's layout rules (L, C) are in scene-ui and mobile_check
measures them; this is the look:

- **The centre stays clear.** The HUD lives in the corners and along the top edge; together it covers well
  under a quarter of a phone screen.
- **Small cards, not panels.** An order is a card about 120 x 90 with the dish's icon, its ingredients as
  icons and a time bar; a score is one number with a label; a clock is one number. No paragraphs.
- **Icons over words** wherever an icon is clear (ingredients, actions, stars); words for names and results.
- **One look**: the UI Theme prefab's palette and the components in './runtime/uiComponents', with the same
  border, padding and font size everywhere.
- **Status that matters most is biggest**: the clock in the last 10 seconds, an order about to expire.
- Instructions do not live in the HUD: a 2–3 line card at the start (section 7) and prompts in the world.

## 7. The first minute (F6)

- The scene makes sense the moment a player arrives: they see the area, the stations are labelled in the
  world (a short sign over each), and the round waits for them or is already running at an easy pace.
- One short card explains the loop in at most three lines with the action icons ("Take, chop, plate, serve"),
  closes with one press and never shows again for that player.
- The first order or goal is the simplest one. Point at the next step in the world (a bobbing arrow over the
  station) until the player has done it once.
- The end of a round says how it went (stars, served, missed), names the best score, and offers to play again
  with one press.

## 8. Before you say it plays

- Play the core loop once with playtest (on mobile when the game is for phones too) and compare game.state
  before and after each action: an action whose state did not change did not work, whatever the HUD says.
- Name what you checked and how, and what you did not ("I picked up and chopped a tomato; I did not try two
  players at once"). Never say a mechanic works because the code that should make it work compiled.

## Report

List the decisions F1–F6 in one line each (the camera you chose, the verbs and their buttons, what is held
and how it shows, the feedback each action got, the HUD and its share of the screen, the first minute), what
you verified and how, and what the creator should try first.
