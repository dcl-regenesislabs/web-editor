---
name: model-building
description: Build and refine custom 3D models with the editor's buildModel tool, reusable geometry helpers, scanned materials and automatic preview images.
---

# Build models in the editor

Use `scene_request` with `type: "buildModel"`. The code receives `THREE`, `addons`,
`root` and `clips`; it runs in the browser without imports, network or Blender.
Create meshes and add them to `root`. A returned geometry is not a visible mesh.

Aim for believable game art by default: human-scale proportions, shaped silhouettes,
construction details and restrained surface variation. Match an attached reference
and the scene's style; an explicit cartoon or low-poly request takes precedence.
Catalog assets are also judged on silhouette and style, not just their triangle count.
Do not replace a recognizable shape with a textured box or a tree with stacked cones.

## Build with reusable geometry

The helpers are ordinary Three.js geometry and groups; combine and transform them.
All dimensions are metres. Their defaults fit the 8,000-triangle model budget,
but combining many helpers still costs their total triangles.

| Helper | Returns | Use |
|---|---|---|
| `addons.tree({height:5,width:3.4,seed:1})` | Group | Broadleaf tree with roots, tapered curved branches and leaves attached along twigs. Defaults to 9 branches and 1,200 leaves. Height and maximum crown width are fitted to the requested dimensions; base is y=0. Optional `branches` (3–16), `leaves`, `trunkMaterial` and `leafMaterial`. Leave `leaves` unset to fit foliage automatically within the triangle budget for the chosen branch count. |
| `addons.rock({size:[1.4,0.9,1.1],seed:1,detail:3,roughness:0.18})` | BufferGeometry | Irregular coherent rock, grounded at y=0. `size` is its exact bounding size. Geometry roughness 0–0.45; detail 1–5. |
| `addons.tube({points:[[0,0,0],[0.1,1,0],[0.4,2,0]],radii:[0.15,0.1,0.02],segments:16,sides:10,capped:true,metresPerTile:1})` | BufferGeometry | Curved, tapering branch, handle, pipe, horn or support. One positive radius per point, distinct neighboring points. Grain follows its length. |
| `addons.lathe([[0,0],[0.3,0],[0.34,0.04],[0.28,0.1],[0.2,0.5],[0.18,0.55]],32)` | BufferGeometry | Revolve a radius/height profile: pottery, lamps, pedestals, bottles and turned furniture. Include interior profile points for an open vessel. |
| `addons.foliage({size:[1.2,0.8,1.2],leaves:90,leafLength:0.22,seed:1})` | BufferGeometry | Curved leaf cluster centered on its origin. Use with `addons.leafMaterial()`. Size describes the distribution; leaf tips extend beyond it. Optional `path:[[x,y,z],...]` attaches leaves along a twig; use the same points for a tube. |
| `addons.leafMaterial('#607b38')` | MeshStandardMaterial | Leaf color gradient and veins, roughness, two-sided leaves; one cached texture per color. |
| `addons.random(7)` | Function | Seeded random values in [0,1). Use a fixed seed so an edit changes only what you intended. |

For a tree or rock, start with its defaults and change only size and seed unless the
request needs a different shape. Explicit leaf counts must be at least 6 × branches;
the maximum depends on branch count (1,281 at 9 branches, 840 at 16).
For a different species, assemble tubes and foliage with its characteristic branching pattern;
the broadleaf helper is not a pine, palm or cactus. For props, use lathed profiles,
curved supports, RoundedBoxGeometry and boolean openings instead of inventing those
algorithms. Name only animated or externally referenced parts so static parts merge.

For repeated rails, planks and trim, start with
`new addons.RoundedBoxGeometry(width,height,depth,1,radius)` (108 triangles).
Two corner segments cost 300 triangles per box and three cost 588; reserve those
for a visible rounded silhouette such as a cushion. Leave room for later details
instead of aiming at exactly 8,000 triangles on the first build.

### Tree and rock

```js
root.add(addons.tree({ height: 5, width: 3.4, seed: 7 }));
```

```js
root.add(new THREE.Mesh(
  addons.rock({ size: [1.8, 1.1, 1.4], seed: 12 }),
  addons.material('rock')
));
```

### A turned ceramic planter with a rim and interior

```js
const profile = [
  [0,0], [0.23,0], [0.25,0.025], [0.27,0.08],
  [0.36,0.49], [0.38,0.51], [0.38,0.55], [0.36,0.57],
  [0.32,0.57], [0.30,0.53], [0.22,0.09], [0,0.09]
];
const clay = new THREE.MeshStandardMaterial({ color:'#ad694b', roughness:0.72, metalness:0 });
root.add(new THREE.Mesh(addons.lathe(profile), clay));
```

## Materials and detail

Use `addons.material(name)` for the shared scanned surfaces. White tint preserves
the photograph; a dark tint multiplies it and can hide detail. Their normal map
adds relief; it does not change the silhouette. Put geometry into the visible
outline, openings, rims and joints, and surface detail into textures.

Tint cannot lighten a dark photograph or turn reddish wood into pale oak. If the
library lacks the requested finish, make a small dedicated canvas texture with
subtle grain in that finish, or choose an appropriate existing asset. Do not spend
a rebuild trying a paler tint on the same unsuitable scan.

Surface names: `stone-blocks`, `red-brick`, `old-brick`, `cobblestone`, `rock`,
`mossy-rock`, `planks`, `wood`, `bark`, `roof-tiles`, `concrete`, `marble`,
`floor-tiles`, `metal`, `rusty-metal`, `metal-plate`, `grass`, `sand`, `gravel`,
`snow`, `ice`. Optional settings are `{color,roughness,metalness,relief}`.

Library materials use box-projected UVs unless the geometry opts out. `tube` and
`lathe` already preserve their directional UVs. For your own unwrapped geometry,
call `addons.keepUVs(geometry)` before adding it; preserve only meaningful UVs.
This keeps wood grain following the part instead of switching direction across faces.

Use a small palette of compatible materials and believable relative thicknesses.
Variation should follow the object: thicker roots, thinner branch tips, wear at
exposed edges. Random bumps and uniform scratches are not a substitute for its shape.
The leaf helper supplies actual shaped leaves; do not cover them with the grass material.
Use the same GLB for repeated identical objects; changing seeds is for deliberate variants.

The scene's texture guideline is `10 * log2(parcels + 1)` (23 whole textures for four
parcels), enforced by buildModel. Each shared surface uses two textures once across
all models, or one with `relief:false`. Materials have a `20 * log2(parcels + 1)`
guideline; different tint, roughness, metalness or relief settings count separately.
Reuse existing surfaces and settings; keep a model to 2–4 materials. Custom canvas
textures must be powers of two up to 512 px, at most four per model. The full model
is limited to 8,000 triangles and six materials, including both faces of leaves.

## Inspect and finish

The build returns a three-angle studio contact sheet of the exported GLB, plus
triangles, materials, textures, file KB and `modelBuildMs` (geometry/export time,
excluding saving, preview and AI thinking). Read those images before another edit. Check silhouette, relative
thickness, texture direction, visible seams, disconnected parts and excessive gaps.
Fix a visible defect by rebuilding `into` the existing entity. Keep the seed fixed.
Skip another build if no correction is needed; do not regenerate just to inspect it.
For a saved model, read and edit its `models/src/<name>.js` with the file tools,
then call `buildModel` with `script:"models/src/<name>.js"` and `into` instead of
resending the whole script as `code`. Use exactly one of `script` and `code`.
The saved script runs through the same sandbox, budget checks and previews.

Use `view` on the placed model for actual scene scale and lighting. The studio
preview is not evidence of how Bevy lights it. If the preview fails, the model was
still saved: use `view` instead of creating another copy. State any unverified view.

For a whole scene, inspect each distinct asset, then reuse it. Do not spend a full
modeling pass on every repeated chair, tree or rock. A feature too small to see
from the intended camera is a poor use of both triangles and generation time.
