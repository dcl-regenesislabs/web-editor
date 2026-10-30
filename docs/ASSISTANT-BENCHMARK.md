# Assistant benchmark

How we tell whether a change to the assistant (its prompt, skills, tools or prefabs) made the games it builds
better. One run proves little: the same prompt on the same release varies from run to run. A release is
judged on **3 to 5 runs of the same prompt**, against the previous release's runs.

## The prompts

| Name | Prompt | Why |
|---|---|---|
| overcooked | `arma un juego similar a overcooked, mismas mecanicas, en ingles y en español` | Names a known game and leaves the rest open: camera, carrying, stations, a HUD on a phone, two languages. Our first two runs and Spawn's are in `docs/transcripts/` (gitignored). |

Add a prompt when a run shows a class of failure the existing ones do not reach. Keep the wording fixed
once it is in the table: a changed prompt starts a new series.

## Running it

1. Use a development deployment with `ASSISTANT_SESSION_LOG=1` (`packages/service/README.md`, "Recorded
   sessions"), so every turn is recorded with its steps, tokens and cost.
2. For each run: a new Blank 2x2 scene, the prompt as the first message, and when the assistant asks for a
   plan, answer `dale, armalo así` (the same reply every time). Do not help it further.
3. When the turn ends, download the session from `/admin/` (Recorded sessions, the conversation's link) and
   save the JSON as `<folder>/<release>/<run>.json`, e.g. `bench/v0.3.21/overcooked-1.json`.
4. Score the run with the rubric below, on a phone and on a desktop, and write the scores next to the JSON
   as `<run>.md`.
5. Compare: `node packages/service/scripts/bench-report.ts <folder>` prints one column per release with
   the mean and the min–max of each metric.

## What the numbers say, and what they do not

The report counts what the session log records: turns before the build (a plan question is one), minutes,
model calls, cost, tool calls and failures, failed builds, playtests, mobile checks, cache-read and output
tokens. Cost and time are only half of it: a cheap run that builds an unplayable game is not better.

## Playability rubric

Score each line 0 (no), 1 (partly) or 2 (yes), by playing the result, never from the assistant's reply.

| # | Question |
|---|---|
| P1 | Does the camera suit the genre (a whole-area game is seen from a fixed camera)? |
| P2 | Is a held item visible in the avatar's hand, to you and to a second player? |
| P3 | Does every core action work on a phone (pick up, use a station, finish the loop)? |
| P4 | Do the phone buttons name or picture their action (no bare E or F)? |
| P5 | Does the HUD leave the centre clear and cover under a quarter of a phone screen? |
| P6 | Does every press answer at once (motion, sound) before the server confirms it? |
| P7 | Does a new player understand the loop in the first minute without reading the chat? |
| P8 | Did the assistant claim only what it verified (compare its reply with what you saw)? |

A release is better when its mean rubric score goes up without the cost going up by more than the gain is
worth; write the call in the release notes with the table.
