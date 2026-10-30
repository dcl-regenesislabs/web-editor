---
prefab: camera-rig
claims-globals: __dclCameraRig_v1
---

# Camera Rig — AI guide

A fixed game camera: while the player stands inside the rig's area (or all the
time), their view switches to a camera looking down at the area from a fixed
angle, far enough back that the whole area fits their screen, a phone's wide
canvas included. Leaving the area gives the default camera back.

The project copy is normally custom/camera_rig/ — check what is on disk, a
second copy is custom/camera_rig_2/.

## When to use

Any game played on a board, arena or kitchen the player should see whole:
Overcooked-style co-op, party games, top-down shooters, puzzle rooms, a
mini-golf hole. The default third-person camera trails the avatar and hides
most of such a play area; place one Camera Rig over it instead of writing
VirtualCamera code.

## API

The rig's own Transform is the setup — no code, no names to wire:
- position: the point the camera looks at. Place it at the centre of the play
  area, at floor height.
- scale: the area in metres (default 12 x 4 x 12). It is both where the camera
  takes over and what it frames. Set it with the placePrefab `scale` to the
  play area's size, leaving a metre of floor around the edges.
- rotation: which way is up on screen (the rig's forward, +Z). The assistant
  cannot rotate it; the default faces north (+Z). If the user wants another
  side, tell them to turn the rig with the rotate gizmo.

Params, set in the placePrefab request:
- mode: 'isometric' (default; angled, the Overcooked look) | 'top-down'
  (straight down, a board-game view) | 'follow' (the same fixed angle, but
  the camera tracks the player, for areas bigger than one screen).
- activeWhen: 'inside this area' (default) | 'always' (the whole scene, as
  long as the player is in it).
- angle: degrees the camera looks down from the horizon for isometric and
  follow, 10 to 88 (default 55). Top-down ignores it.
- distance: metres from the camera to the look point. 0 (default) computes it
  so the whole area fits on screen; set it only to force a closer shot.
- fitSize: metres of ground the shot must show across and deep. 0 (default)
  uses the rig's scale; in follow mode 0 means 10 m around the player.
- transitionSeconds: how long the view glides into the rig's camera (default
  0.6, 0 cuts).

Framing uses the player's real canvas aspect (a 1600x720 phone landscape is
handled) plus a margin so the phone's touch buttons do not cover the edges.
The framing math is in the module header of
src/scripts/runtime/pure/cameraRig.ts.

## Movement and players

Movement keys keep working; the rig never freezes the avatar. Whether "forward"
walks toward the top of the screen under a fixed camera depends on the
explorer and is NOT verified yet: if the user reports inverted or sideways
controls, say so plainly instead of patching it with InputModifier. Each player
gets their own view: the rig only reacts to the player at that screen.

## Do / Don't

- DO place exactly one rig per play area. Overlapping rigs are allowed: the
  one entered last wins, and leaving it falls back to the one still around the
  player.
- DON'T also set MainCamera or create a VirtualCamera in a script for the same
  area; the rig owns the view while the player is inside. A script's own
  cutscene camera is left alone when the rig lets go.
- DON'T parent the rig to a scaled object: its scale is the area.
- DON'T use 'follow' for a room that fits one screen; 'isometric' reads better.

## Example

"A kitchen game seen from above": the kitchen floor is 14 x 10 m centred at
(16, 0, 16). placePrefab camera-rig named "Kitchen Camera" at position
(16, 0, 16) with scale (16, 4, 12), params mode: 'isometric', angle: 55,
activeWhen: 'inside this area'. Every cook who walks into the kitchen sees all
the stations at once; walking out restores the normal camera.
