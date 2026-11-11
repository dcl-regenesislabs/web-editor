# Icons for screen UI

The editor has a catalog of about 14,000 free icons. Use it for every icon a screen shows: an inventory item, a
HUD stat (hearts, coins, a timer), a menu button, a gamepad or keyboard prompt. The phone's touch buttons and their
`ActionHint`s keep using `actionIcon` from `./runtime/actionIcons` (C3); the catalog is for everything else.

## Find one

`scene_request {type:"findIcons",query:"health potion",limit:12,set:"game-icons"}` searches by whole words in the
icon's name (`sword` does not find `broadsword`: search the word the icon is likely named by, or try a second word).
It answers `{icons:[{id,set,license,credit?}],total}`. `set` is optional:

| set | what it holds |
|---|---|
| `game-icons` | game things: items, weapons, armour, potions, creatures, spells, resources, cards (CC BY 3.0, credited) |
| `tabler` | UI: menus, arrows, settings, timer, lock, map, plus dice, trophy, sword, ghost (MIT) |
| `lucide` | UI, a lighter stroke (ISC) |
| `pixelarticons` | UI as pixel art, for a retro look (MIT) |
| `kenney` | input prompts: `keyboard-<key>`, mouse, `xbox-button-<a/b/x/y…>`, triggers, sticks, touch gestures (CC0) |

Keep one UI set per scene so the HUD has one look; game-icons can sit beside it for the game's own things.
Searches run alongside other work, so send the ones you need together.

## Add it

`scene_request {type:"addIcon",id:"game-icons:health-potion",size:128}` draws the icon as a white PNG on a
transparent square (size 64, 128 by default, or 256 for a large panel) into
`assets/images/icons/<set>-<name>.png`, once, and rewrites `assets/images/icons/CREDITS.md` with every catalog icon
in that folder, its license and, for game-icons, its author. It answers `{path,size,credits,credit?}`. Never edit
or delete that CREDITS.md: game-icons' license requires the credit to ship with the scene.

## Show it

The PNG is white so the theme colours it:

```tsx
<UiEntity
  uiTransform={{ width: 40, height: 40, flexShrink: 0 }}
  uiBackground={{ texture: { src: 'assets/images/icons/game-icons-health-potion.png' }, textureMode: 'stretch', color: theme.text }}
/>
```

Size it in multiples of the HUD's text size, and give it the same colour as the text beside it; an accent colour
only for what needs the eye (low health, a ready ability). Never draw an icon with emoji (they are missing on
desktop) or as text.
