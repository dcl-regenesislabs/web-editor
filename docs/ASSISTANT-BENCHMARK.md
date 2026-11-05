# Assistant benchmark

How we tell whether a change to the assistant (its prompt, skills, tools or prefabs) made the games it builds
better. One run proves little: the same prompt on the same release varies from run to run. A release is
judged on **3 to 5 runs of the same prompt**, against the previous release's runs.

## The prompts

| Name | Prompt | Why |
|---|---|---|
| co-op-kitchen | `build a co-op cooking game: players grab ingredients, chop and cook them at stations and deliver orders before time runs out, in English and Spanish` | Names a genre and leaves the rest open: camera, carrying, stations, a HUD on a phone, two languages. |

Add a prompt when a run shows a class of failure the existing ones do not reach. Keep the wording fixed
once it is in the table: a changed prompt starts a new series.

## Running it

1. Use a development deployment with `ASSISTANT_SESSION_LOG=1` (`packages/service/README.md`, "Recorded
   sessions"), so every turn is recorded with its steps, tokens and cost.
2. For each run: a new Blank 2x2 scene, the prompt as the first message, and when the assistant asks for a
   plan, answer `go ahead, build it that way` (the same reply every time). Do not help it further.
3. When the turn ends, download the session from `/admin/` (Recorded sessions, the conversation's link) and
   save the JSON as `<folder>/<release>/<run>.json`, e.g. `bench/v0.3.22/co-op-kitchen-1.json`.
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

## Compaction (#89)

Measured on 2026-11-05, local service (`npm run dev:web` with `ASSISTANT_SESSION_LOG=1`), Opus 5.5 at medium effort,
a new Blank 2×2 scene per run. The same five messages, each sent as soon as the previous turn ended, so no idle gap
mixes the prompt cache's expiry into the result:

1. the co-op-kitchen prompt above (none of the six runs stopped to ask for a plan);
2. `Add a fourth recipe that needs two cooked ingredients, and show it on the order cards.`
3. `Playtest one full shift and fix anything that doesn't work.`
4. `Rename the chopping station to "Cutting Board" everywhere players can see it, and make a shift last 90 seconds.`
5. `Answer from memory, without using any tools: list every station you placed with its entity name, every script file you wrote, and each recipe with its ingredients.`

Message 5 checks what a summary lost: its answer is compared with the stations, scripts and recipes the run built.

| `ASSISTANT_COMPACT_AT_TOKENS` | Runs | Cost | Minutes | Model calls | Peak context | Compactions | Cache write | Message 5 |
|---|---|---|---|---|---|---|---|---|
| 0 (off) | 2 | $7.86 ($6.78–8.94) | 31.5 | 122 | 272–329k | 0 | 0.29M | complete |
| 150000 | 2 | $10.59 ($10.43–10.75) | 33.7 | 152 | 149k | 5 | 0.76M | complete; unsure of ids |
| 200000 | 2 | $6.85 ($5.82–7.87) | 24.2 | 115 | 200k | 1–2 | 0.33M | complete |

- **150k costs a third more.** It compacts inside the build turn (twice in message 1, again in 2 and 3), and after
  each summary the model reads the files it was working on again: 25% more calls, 30% more output, and the new
  shorter context written to the cache each time. The summary itself is cheap: pi sends the summarized part as
  text with tool results cut short (13k tokens in, 3k out, about $0.11).
- **200k is no worse than off, and keeps long conversations bounded.** Two runs per setting are within each other's
  noise ($6.78–8.94 off), so the saving here is not proven. What 200k buys is the long tail: recorded creator
  conversations reached 300–560k (99 nights in the forest), and every cold cache rewrite of those is paid at the
  write price.
- **The service default is 200000.** 150k, which the replay-based analyses in `docs/transcripts/analysis-2026-11-0*`
  recommended, is ruled out by these runs.

## Prompt-cache retention (#90), from recorded sessions

`node packages/service/scripts/replay-cost.ts <folder>` reads every `session.jsonl` below the folder (as `/admin/`
serves them), replays its calls under each policy and prices them: 5 minutes (today), 1 hour, 5 minutes kept warm
by pings for 30 or 60 minutes, and compaction at 150k or 200k. Its "Model as run" column prices the policy the
session actually ran under, so it shows how far the other columns can be trusted: on the 19 sessions in
`docs/transcripts/admin-sessions` it is within 3% of what was billed.

| Policy | 19 recorded sessions |
|---|---|
| 5 min (today) | $74.44 |
| 1 h | $72.71 (−2%) |
| 5 min + warm 30 min | $70.27 (−6%) |
| 5 min + warm 60 min | $72.95 (−2%) |

- **1 h** costs 15–20% more on the usual 10–40-minute session, because every write is billed at 2× input instead
  of 1.25×. It pays off only in a long session with gaps: 99 nights goes from $23.6 to $17.7.
- **Keeping the cache warm for 30 minutes** is the cheapest, but it counts a page left open for 30 minutes after the
  last reply, pinging all along; most of what it saves is again one long session.
- **No change for now.** These sessions are mostly benchmark runs that never sit idle. The decision needs the idle
  gaps of real creator sessions: record them on the dev deployment and run the replay over them. Compaction at 200k
  already caps what one cold rewrite can cost.

The replay replays the same calls, so it cannot see a policy change what the model does. It is sound for cache
retention, which the model never sees, and not for compaction: on the two runs with compaction off it predicts
150k would save 22%, where real runs with 150k cost 35% more.
