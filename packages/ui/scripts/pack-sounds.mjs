// Regenerates src/sounds/ from CC0 sources (Kenney's audio packs and OpenGameArt uploads): each pick becomes
// <name>.mp3 (trimmed, loudness-normalised; an ambience loop is crossfaded at the wrap), its description, kind,
// length and loop flag in properties.json, plus CREDITS.md.
// Run from the repo root: node packages/ui/scripts/pack-sounds.mjs (needs unzip and ffmpeg with libmp3lame;
// FFMPEG=/path/to/ffmpeg overrides, else Homebrew's ffmpeg@6, else the one on PATH). SOUND_DOWNLOADS=<dir> keeps
// the downloads there and reuses them on the next run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const KENNEY = {
  'interface-sounds': 'Interface Sounds', 'impact-sounds': 'Impact Sounds', 'digital-audio': 'Digital Audio',
  'rpg-audio': 'RPG Audio', 'sci-fi-sounds': 'Sci-fi Sounds', 'music-jingles': 'Music Jingles', 'ui-audio': 'UI Audio',
  'casino-audio': 'Casino Audio', 'voiceover-pack': 'Voiceover Pack', 'voiceover-pack-fighter': 'Voiceover Pack: Fighter'
}
// every page below lists CC0 among its licenses (checked 2026-11-03)
const OGA = {
  '100-cc0-sfx-2': ['100 CC0 SFX #2', 'rubberduck'],
  '25-cc0-bang-firework-sfx': ['25 CC0 bang / firework SFX', 'rubberduck'],
  '30-cc0-sfx-loops': ['30 CC0 SFX loops', 'rubberduck'],
  '40-cc0-water-splash-slime-sfx': ['40 CC0 water / splash / slime SFX', 'rubberduck'],
  '80-cc0-rpg-sfx': ['80 CC0 RPG SFX', 'rubberduck'],
  'swishes-sound-pack': ['Swishes Sound Pack', 'artisticdude'],
  'applause-in-a-large-hall-or-church': ['Applause in a large hall or church', 'eXpl0it3r'],
  'rain-loopable': ['Rain (loopable)', 'Ylmir'],
  'windy-ambient-noise': ['windy ambient noise', 'Some Weirdo'],
  'amb-morning-sounds-perfect-loop': ['AMB Morning Sounds (Perfect Loop)', 'Kresiek The Furry'],
  'crickets-ambient-noise-loopable': ['Crickets Ambient Noise - loopable', 'Wolfgang_'],
  'park-ambiences': ['Park ambiences', 'Thimras'],
  'sea-and-river-wave-sounds': ['Sea and river wave sounds', 'RandomMind'],
  'crowd-shoutingspeaking-ambience': ['Crowd Shouting/Speaking Ambience', 'StarNinjas'],
  'fireplace-sound-loop': ['Fireplace Sound loop', 'PagDev'],
  'high-traffic-road-sounds': ['High traffic road sounds', 'IgnasD'],
  'loopable-dungeon-ambience': ['Loopable Dungeon Ambience', 'JaggedStone'],
  'scifi-city-ambient-loop': ['Scifi City - Ambient Loop', 'TinyWorlds'],
  'horror-atmosphere': ['Horror Atmosphere', 'Juhani Junkala (SubspaceAudio)'],
  'bubble-sound-effects': ['Bubble Sound Effects', 'BMacZero'],
  'medieval-the-old-tower-inn': ['Medieval: The Old Tower Inn', 'RandomMind'],
  'happy-lullaby-song17': ['Happy Lullaby (song17)', 'cynicmusic'],
  'crystal-cave-song18': ['Crystal Cave (song18)', 'cynicmusic'],
  'mysterious-ambience-song21': ['Mysterious Ambience (song21)', 'cynicmusic'],
  'fast-fight-battle-music-looped': ['Fast fight / battle music (looped)', 'Ville Nousiainen (XCVG)'],
  '8bit-title-screen': ['8Bit Title Screen', 'Joth'],
  'emotional-piano-loop': ['Emotional piano loop', 'extenz'],
  snowfall: ['Snowfall', 'Kistol'],
  'carnival-rides': ['Carnival Rides', 'Écrivain'],
  'loading-screen-loop': ['Loading screen loop', 'HaelDB'],
  'adventure-theme': ['Adventure Theme', 'CleytonKauffman'],
  'jrpg-pack-1-exploration': ['JRPG Pack 1 Exploration', 'Juhani Junkala (SubspaceAudio)']
}
// how each kind is cut and encoded: effects and voices are trimmed one-shots; ambience is a mono bed crossfaded
// at the wrap, quieter so it sits under the effects; music is already a loop, so it keeps its exact length
// (a crossfade would shift its beat) and its stereo
const KINDS = {
  effect: { channels: 1, bitrate: '96k', targetDb: -18, maxGainDb: 12, maxBytes: 100 * 1024 },
  voice: { channels: 1, bitrate: '96k', targetDb: -18, maxGainDb: 12, maxBytes: 100 * 1024 },
  ambience: { channels: 1, bitrate: '80k', targetDb: -24, maxGainDb: 24, maxBytes: 320 * 1024, loop: true },
  music: { channels: 2, bitrate: '96k', targetDb: -22, maxGainDb: 12, maxBytes: 900 * 1024, loop: true }
}
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const LOOP_CROSSFADE = 0.25
const AMBIENCE_SECONDS = 20

// name: [source, file, what it is, kind, { start, seconds }]. A source is a Kenney pack or oga:<page>; the file
// is the path inside the pack's zip, or for OpenGameArt the uploaded file, then the path inside it when a zip.
const PICKS = {
  // pickups and score
  coin: ['digital-audio', 'Audio/highUp.ogg', 'bright rising blip: coin or collectible picked up'],
  gem: ['interface-sounds', 'Audio/glass_001.ogg', 'glassy chime: gem, crystal or rare item picked up'],
  coins: ['rpg-audio', 'Audio/handleCoins.ogg', 'jingling coin pouch: buy, pay, loot, reward handed over'],
  'power-up': ['digital-audio', 'Audio/powerUp3.ogg', 'rising synth sweep: power-up or boost'],
  'power-down': ['digital-audio', 'Audio/phaserDown1.ogg', 'falling phaser sweep: power-up wearing off, shrink, drain'],
  point: ['interface-sounds', 'Audio/confirmation_001.ogg', 'short confirm blip: point scored, checkpoint, correct'],
  pop: ['digital-audio', 'Audio/pepSound1.ogg', 'quick pop: bubble burst, balloon, item spawned'],
  // rounds and game flow
  'countdown-tick': ['digital-audio', 'Audio/tone1.ogg', 'single beep: each second of a countdown'],
  start: ['digital-audio', 'Audio/threeTone2.ogg', 'three rising tones: go, round start'],
  win: ['music-jingles', 'Audio/8-Bit jingles/jingles_NES12.ogg', 'rising 8-bit fanfare: win, level complete'],
  lose: ['music-jingles', 'Audio/8-Bit jingles/jingles_NES11.ogg', 'falling 8-bit jingle: lose, game over'],
  'time-up': ['digital-audio', 'Audio/zapThreeToneDown.ogg', 'falling buzz: time up, round over'],
  applause: ['oga:applause-in-a-large-hall-or-church', 'applause-clapping-church-crowd-immersive.wav', 'crowd clapping in a hall: applause, show ends, audience cheers', 'effect', { start: 1, seconds: 6 }],
  firework: ['oga:25-cc0-bang-firework-sfx', '25-CC0-bang-sfx.zip/fw_01.ogg', 'firework launch and burst: celebration, new record, party'],
  // interface
  click: ['interface-sounds', 'Audio/click_001.ogg', 'soft click: button press'],
  hover: ['ui-audio', 'Audio/rollover2.ogg', 'faint tick: pointer over a button or item'],
  select: ['interface-sounds', 'Audio/select_001.ogg', 'bright select blip: item, option or character chosen'],
  toggle: ['interface-sounds', 'Audio/toggle_001.ogg', 'switch flick: toggle, checkbox, setting on or off'],
  back: ['interface-sounds', 'Audio/back_001.ogg', 'soft step back: back, cancel, previous page'],
  open: ['interface-sounds', 'Audio/open_001.ogg', 'short rise: panel or menu opens'],
  close: ['interface-sounds', 'Audio/close_001.ogg', 'short fall: panel or menu closes'],
  error: ['interface-sounds', 'Audio/error_006.ogg', 'low buzz: wrong, denied, locked'],
  notify: ['interface-sounds', 'Audio/bong_001.ogg', 'gentle bong: notification, message, quest updated'],
  question: ['interface-sounds', 'Audio/question_001.ogg', 'curious two-note: hint, question, something to inspect'],
  typing: ['interface-sounds', 'Audio/tick_001.ogg', 'tiny tick: dialogue text typing out, letter by letter'],
  glitch: ['interface-sounds', 'Audio/glitch_001.ogg', 'digital glitch: hack, malfunction, corrupted screen'],
  // moving
  jump: ['digital-audio', 'Audio/phaseJump1.ogg', 'springy rising zip: jump, bounce pad'],
  land: ['impact-sounds', 'Audio/impactSoft_heavy_000.ogg', 'soft heavy thud: landing, something dropped'],
  'step-grass': ['impact-sounds', 'Audio/footstep_grass_000.ogg', 'footstep on grass or dirt'],
  'step-wood': ['impact-sounds', 'Audio/footstep_wood_000.ogg', 'footstep on wooden floor, deck or bridge'],
  'step-stone': ['impact-sounds', 'Audio/footstep_concrete_000.ogg', 'footstep on stone or concrete'],
  'step-snow': ['impact-sounds', 'Audio/footstep_snow_000.ogg', 'crunchy footstep on snow or gravel'],
  'step-carpet': ['impact-sounds', 'Audio/footstep_carpet_000.ogg', 'muffled footstep on carpet or indoors'],
  swish: ['oga:swishes-sound-pack', 'swishes.zip/swishes/swish-7.wav', 'fast air swish: swing, throw, dodge, dash'],
  splash: ['oga:40-cc0-water-splash-slime-sfx', 'water-splash-slime-sfx.zip/splash_01.ogg', 'big water splash: falling into water, cannonball, dive'],
  'splash-small': ['oga:40-cc0-water-splash-slime-sfx', 'water-splash-slime-sfx.zip/splash_09.ogg', 'small splash: stepping in water, fish, pebble dropped in'],
  bubble: ['oga:40-cc0-water-splash-slime-sfx', 'water-splash-slime-sfx.zip/bubble_01.ogg', 'bubbling blub: underwater, potion, cauldron'],
  splat: ['sci-fi-sounds', 'Audio/slime_000.ogg', 'wet squelch: slime, goo, paint ball'],
  teleport: ['digital-audio', 'Audio/phaserUp1.ogg', 'rising phaser sweep: teleport, portal, respawn'],
  // fighting and danger
  hit: ['impact-sounds', 'Audio/impactPunch_medium_000.ogg', 'punch impact: hit, damage taken'],
  'hit-heavy': ['impact-sounds', 'Audio/impactPunch_heavy_000.ogg', 'heavy punch: big hit, knockback, boss strike'],
  'sword-draw': ['rpg-audio', 'Audio/drawKnife1.ogg', 'blade drawn from its sheath: sword out, weapon ready'],
  slice: ['rpg-audio', 'Audio/knifeSlice.ogg', 'blade slicing: sword hit, cut, slash'],
  laser: ['sci-fi-sounds', 'Audio/laserSmall_000.ogg', 'small laser zap: shot, blaster, turret fire'],
  'laser-big': ['sci-fi-sounds', 'Audio/laserLarge_000.ogg', 'big laser blast: charged shot, cannon beam'],
  'laser-retro': ['sci-fi-sounds', 'Audio/laserRetro_000.ogg', 'retro arcade pew: arcade shooter, toy blaster'],
  zap: ['digital-audio', 'Audio/zap1.ogg', 'electric zap: shock, trap, electric fence'],
  'force-field': ['sci-fi-sounds', 'Audio/forceField_000.ogg', 'humming force field: shield up, barrier, energy wall'],
  spell: ['oga:80-cc0-rpg-sfx', '80-CC0-RPG-SFX_0.zip/spell_01.ogg', 'magic shimmer: spell cast, enchant, heal'],
  fireball: ['oga:80-cc0-rpg-sfx', '80-CC0-RPG-SFX_0.zip/spell_fire_01.ogg', 'whooshing flame: fireball, fire spell, torch lit'],
  cannon: ['oga:25-cc0-bang-firework-sfx', '25-CC0-bang-sfx.zip/cannon_01.ogg', 'cannon shot: cannon, mortar, ship broadside'],
  explosion: ['sci-fi-sounds', 'Audio/lowFrequency_explosion_000.ogg', 'deep boom: explosion, big impact'],
  'explosion-small': ['sci-fi-sounds', 'Audio/explosionCrunch_000.ogg', 'crunchy small blast: grenade, barrel, crate blown up'],
  'monster-growl': ['oga:80-cc0-rpg-sfx', '80-CC0-RPG-SFX_0.zip/creature_roar_02.ogg', 'creature roar: monster appears, enemy alerted, boss'],
  'monster-hurt': ['oga:80-cc0-rpg-sfx', '80-CC0-RPG-SFX_0.zip/creature_hurt_01.ogg', 'creature grunt of pain: enemy hit'],
  'monster-die': ['oga:80-cc0-rpg-sfx', '80-CC0-RPG-SFX_0.zip/creature_die_01.ogg', 'creature dying groan: enemy defeated'],
  // things in the world
  'door-open': ['rpg-audio', 'Audio/doorOpen_1.ogg', 'wooden door creaking open'],
  'door-close': ['rpg-audio', 'Audio/doorClose_1.ogg', 'wooden door shutting'],
  'door-slide': ['sci-fi-sounds', 'Audio/doorOpen_000.ogg', 'sci-fi sliding door: automatic door, hatch, elevator'],
  creak: ['rpg-audio', 'Audio/creak1.ogg', 'wooden creak: chest lid, floorboard, old gate'],
  lever: ['rpg-audio', 'Audio/metalLatch.ogg', 'metal latch clack: lever, switch, lock'],
  unlock: ['oga:100-cc0-sfx-2', 'sfx_100_v2.zip/sfx100v2_lock_open_01.ogg', 'key turning in a lock: unlock, chest opened, door unlocked'],
  'glass-break': ['impact-sounds', 'Audio/impactGlass_heavy_000.ogg', 'heavy glass impact: window, bottle or vase breaking'],
  'metal-hit': ['impact-sounds', 'Audio/impactMetal_heavy_000.ogg', 'heavy metal clang: anvil, pipe, armour, metal crate'],
  'wood-hit': ['impact-sounds', 'Audio/impactWood_heavy_000.ogg', 'heavy wooden knock: crate, barrel, plank hit'],
  bell: ['impact-sounds', 'Audio/impactBell_heavy_000.ogg', 'struck bell: bell, gong, round bell, alarm bell'],
  mining: ['impact-sounds', 'Audio/impactMining_000.ogg', 'pickaxe on rock: mining, digging, breaking stone'],
  chop: ['rpg-audio', 'Audio/chop.ogg', 'axe chop: chopping wood, tree, log'],
  book: ['rpg-audio', 'Audio/bookOpen.ogg', 'book opening: book, journal, spellbook, recipe'],
  page: ['rpg-audio', 'Audio/bookFlip1.ogg', 'page turn: page, map, note, scroll'],
  'card-place': ['casino-audio', 'Audio/card-place-1.ogg', 'card laid on a table: card dealt, card played'],
  'card-shuffle': ['casino-audio', 'Audio/card-shuffle.ogg', 'deck shuffled: shuffle, new hand'],
  dice: ['casino-audio', 'Audio/dice-throw-1.ogg', 'dice rolled on a table: dice, random pick, board game turn'],
  thunder: ['oga:100-cc0-sfx-2', 'sfx_100_v2.zip/sfx100v2_thunder_01.ogg', 'rolling thunder clap: storm, lightning strike, dramatic moment'],
  // announcer voice (Kenney's female voice, the fight line excepted)
  'voice-ready': ['voiceover-pack', 'Female/ready.ogg', 'voice says "Ready": before a round starts', 'voice'],
  'voice-set': ['voiceover-pack', 'Female/set.ogg', 'voice says "Set": between ready and go', 'voice'],
  'voice-go': ['voiceover-pack', 'Female/go.ogg', 'voice says "Go!": round or race starts', 'voice'],
  'voice-three': ['voiceover-pack', 'Female/3.ogg', 'voice says "Three": spoken countdown', 'voice'],
  'voice-two': ['voiceover-pack', 'Female/2.ogg', 'voice says "Two": spoken countdown', 'voice'],
  'voice-one': ['voiceover-pack', 'Female/1.ogg', 'voice says "One": spoken countdown', 'voice'],
  'voice-fight': ['voiceover-pack-fighter', 'Audio/fight.ogg', 'deep announcer says "Fight!": duel, arena, boss fight starts', 'voice'],
  'voice-final-round': ['voiceover-pack', 'Female/final_round.ogg', 'voice says "Final round"', 'voice'],
  'voice-hurry-up': ['voiceover-pack', 'Female/hurry_up.ogg', 'voice says "Hurry up!": time running out', 'voice'],
  'voice-time-over': ['voiceover-pack', 'Female/time_over.ogg', 'voice says "Time over"', 'voice'],
  'voice-correct': ['voiceover-pack', 'Female/correct.ogg', 'voice says "Correct!": right answer, quiz', 'voice'],
  'voice-wrong': ['voiceover-pack', 'Female/wrong.ogg', 'voice says "Wrong": wrong answer, quiz', 'voice'],
  'voice-level-up': ['voiceover-pack', 'Female/level_up.ogg', 'voice says "Level up!"', 'voice'],
  'voice-new-highscore': ['voiceover-pack', 'Female/new_highscore.ogg', 'voice says "New highscore!"', 'voice'],
  'voice-congratulations': ['voiceover-pack', 'Female/congratulations.ogg', 'voice says "Congratulations!": goal reached, quest done', 'voice'],
  'voice-you-win': ['voiceover-pack', 'Female/you_win.ogg', 'voice says "You win!"', 'voice'],
  'voice-you-lose': ['voiceover-pack', 'Female/you_lose.ogg', 'voice says "You lose"', 'voice'],
  'voice-game-over': ['voiceover-pack', 'Female/game_over.ogg', 'voice says "Game over"', 'voice'],
  // ambience beds
  'fire-loop': ['sci-fi-sounds', 'Audio/thrusterFire_000.ogg', 'roaring flame: big fire, lava, furnace, jet', 'ambience'],
  'campfire-loop': ['oga:fireplace-sound-loop', 'fire.wav', 'crackling wood fire: campfire, fireplace, torch, cosy room', 'ambience'],
  'rumble-loop': ['sci-fi-sounds', 'Audio/spaceEngineLow_000.ogg', 'low engine rumble: machinery, ship engine, earthquake', 'ambience'],
  'machine-loop': ['sci-fi-sounds', 'Audio/computerNoise_000.ogg', 'busy electronic chatter: computer room, lab, generator, machine', 'ambience'],
  'alarm-loop': ['oga:30-cc0-sfx-loops', 'sfx_loops.zip/alarm_01.ogg', 'repeating alarm: alert, lockdown, intruder, countdown to danger', 'ambience'],
  'rain-loop': ['oga:rain-loopable', 'Rain OGG.zip/3.ogg', 'steady rain: rainy street, storm, window', 'ambience', { start: 14 }],
  'wind-loop': ['oga:windy-ambient-noise', 'windy_ambiance_0.ogg', 'steady wind: mountain top, desert, cliff, open plain, snow', 'ambience', { start: 1 }],
  'birds-loop': ['oga:amb-morning-sounds-perfect-loop', 'amb_morning_0.ogg', 'birds singing outdoors: forest, park, garden, morning', 'ambience', { start: 17 }],
  'night-loop': ['oga:crickets-ambient-noise-loopable', 'crickets_1.mp3', 'crickets chirping: night outdoors, camp, field', 'ambience'],
  'river-loop': ['oga:park-ambiences', 'park_ambience_river.wav', 'small river over stones, birds and frogs: stream, waterfall, pond', 'ambience', { start: 4 }],
  'waves-loop': ['oga:sea-and-river-wave-sounds', 'VistulaShort_0.mp3', 'waves lapping on a shore: beach, lake, pier, boat', 'ambience', { start: 34 }],
  'bubbles-loop': ['oga:bubble-sound-effects', 'bubbles-loop1-amp.wav', 'steady bubbling: underwater, aquarium, cauldron, lab tank', 'ambience'],
  'city-loop': ['oga:high-traffic-road-sounds', 'gatve Varniu_2.ogg', 'busy road traffic: city street, highway, town square', 'ambience', { start: 4 }],
  'crowd-loop': ['oga:crowd-shoutingspeaking-ambience', 'crowd_shouting_0.ogg', 'shouting crowd: market, protest, army charging, arena stands', 'ambience'],
  'cyber-city-loop': ['oga:scifi-city-ambient-loop', 'busy_cyberworld.ogg', 'sci-fi city hum: cyberpunk street, space station, future city', 'ambience'],
  'dungeon-loop': ['oga:loopable-dungeon-ambience', 'dungeon_ambient_1_0.ogg', 'low wind and water drips: dungeon, cave, crypt, sewer', 'ambience', { start: 27 }],
  'horror-loop': ['oga:horror-atmosphere', 'Juhani Junkala - Post Apocalyptic Wastelands [Loop Ready].ogg', 'creepy dark drone, no melody: horror, haunted house, wasteland', 'ambience', { start: 228 }],
  // background music, every one a loop
  'music-tavern': ['oga:medieval-the-old-tower-inn', 'Loop_The_Old_Tower_Inn.wav', 'calm upbeat medieval folk: tavern, castle, village, fantasy RPG', 'music'],
  'music-happy': ['oga:happy-lullaby-song17', 'song17.mp3', 'happy bells and arpeggios: puzzle, cute, exploring, lobby', 'music'],
  'music-cave': ['oga:crystal-cave-song18', 'song18_0.mp3', 'deep bass, stone and bell textures: cave, crystals, puzzle, underground', 'music'],
  'music-mystery': ['oga:mysterious-ambience-song21', 'song21_0.mp3', 'mysterious piano textures: mystery, investigation, dark puzzle, ruins', 'music'],
  'music-battle': ['oga:fast-fight-battle-music-looped', 'fight_looped.wav', 'fast electronic fight: battle, boss, arena, space shooter, dance club', 'music'],
  'music-action': ['oga:adventure-theme', 'Superhero_pack_0.zip/Superhero_pack/SuperHero_original_no_Intro.ogg', 'fast catchy retro rock: runner, racing, beat-em-up, superhero', 'music'],
  'music-adventure': ['oga:jrpg-pack-1-exploration', 'JRPG Music Pack #1 [Exploration] by Juhani Junkala.zip/Exploration1 - Grasslands.ogg', 'bright adventurous exploration: open world, quest, grasslands', 'music'],
  'music-island': ['oga:jrpg-pack-1-exploration', 'JRPG Music Pack #1 [Exploration] by Juhani Junkala.zip/Exploration6 - Tropical Island.ogg', 'sunny tropical exploration: beach, island, summer, resort', 'music'],
  'music-retro': ['oga:8bit-title-screen', '8Bit Title Screen.mp3', 'short 8-bit chiptune: arcade, retro game, title screen, menu', 'music'],
  'music-carnival': ['oga:carnival-rides', 'carnivalrides.ogg', 'playful carnival tune: fair, circus, kids, amusement park', 'music'],
  'music-sad': ['oga:emotional-piano-loop', 'Piano Loop.wav', 'emotional piano: sad, memorial, story moment, tense', 'music'],
  'music-winter': ['oga:snowfall', 'Snowfall (Looped ver.)_0.ogg', 'gentle piano waltz: winter, snow, calm, gallery, ballroom', 'music'],
  'music-scifi': ['oga:loading-screen-loop', 'TremLoadingloopl.wav', 'dark futuristic electronic: sci-fi, shooter, loading screen, base', 'music']
}

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/sounds')
const ffmpeg = process.env.FFMPEG ?? ['/opt/homebrew/opt/ffmpeg@6/bin/ffmpeg'].find((p) => fs.existsSync(p)) ?? 'ffmpeg'
const ffprobe = ffmpeg === 'ffmpeg' ? 'ffprobe' : path.join(path.dirname(ffmpeg), 'ffprobe')
// ffmpeg reports on stderr, volumedetect included
function run(bin, args) {
  const r = spawnSync(bin, ['-hide_banner', '-v', 'info', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')}\n${r.stderr}`)
  return `${r.stdout}${r.stderr}`
}
const seconds = (file) => Number(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim())
const meanDb = (file) => Number(run(ffmpeg, ['-i', file, '-af', 'volumedetect', '-f', 'null', '-']).match(/mean_volume: (-?[\d.]+) dB/)[1])

const kept = process.env.SOUND_DOWNLOADS
const downloads = kept === undefined ? fs.mkdtempSync(path.join(os.tmpdir(), 'sounds-')) : path.resolve(kept)
fs.mkdirSync(downloads, { recursive: true })
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sounds-work-'))

async function fetchOk(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response
}
// a zip is unpacked once, beside it, into <zip>.d
function unzipOnce(zip) {
  const dir = `${zip}.d`
  if (!fs.existsSync(dir)) {
    execFileSync('unzip', ['-q', '-o', zip, '-d', dir])
    // some packs unzip without write permission
    execFileSync('chmod', ['-R', 'u+w', dir])
  }
  return dir
}
// Kenney's download needs the pack page's session cookie: the page names the pack, /download-link signs a URL
async function kenneyPack(pack) {
  const zip = path.join(downloads, `kenney-${pack}.zip`)
  if (!fs.existsSync(zip)) {
    const pageUrl = `https://kenney.nl/assets/${pack}`
    const page = await fetchOk(pageUrl)
    const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const id = (await page.text()).match(/data-download-id='([0-9a-f]+)'/)?.[1]
    if (id === undefined) throw new Error(`${pack}: no download id on its page`)
    const headers = { cookie, referer: pageUrl }
    const { url } = await (await fetchOk(`https://kenney.nl/download-link/${id}`, { headers })).json()
    if (typeof url !== 'string') throw new Error(`${pack}: no signed download link`)
    fs.writeFileSync(zip, Buffer.from(await (await fetchOk(url, { headers })).arrayBuffer()))
  }
  return unzipOnce(zip)
}
async function ogaUpload(page, upload) {
  const file = path.join(downloads, `oga-${page}-${upload}`)
  if (!fs.existsSync(file)) {
    const url = `https://opengameart.org/sites/default/files/${encodeURIComponent(upload)}`
    fs.writeFileSync(file, Buffer.from(await (await fetchOk(url)).arrayBuffer()))
  }
  return file
}
async function sourceFile(source, file) {
  if (!source.startsWith('oga:')) return path.join(await kenneyPack(source), file)
  const page = source.slice('oga:'.length)
  if (OGA[page] === undefined) throw new Error(`${page}: not in OGA`)
  const zipAt = file.indexOf('.zip/')
  if (zipAt === -1) return ogaUpload(page, file)
  return path.join(unzipOnce(await ogaUpload(page, file.slice(0, zipAt + 4))), file.slice(zipAt + 5))
}

for (const entry of fs.readdirSync(out)) if (entry.endsWith('.mp3')) fs.rmSync(path.join(out, entry))

const properties = {}
let total = 0
for (const [name, [source, file, description, kind = 'effect', cut = {}]] of Object.entries(PICKS)) {
  if (!/^[a-z-]+$/.test(name)) throw new Error(`${name}: a name is lowercase letters and dashes (app-paths.ts serves only those)`)
  const spec = KINDS[kind]
  const input = await sourceFile(source, file)
  if (!fs.existsSync(input)) throw new Error(`${name}: ${input} is missing`)
  const wav = path.join(work, `${name}.wav`)
  const format = ['-ac', String(spec.channels), '-ar', '44100']
  const start = cut.start ?? 0
  if (kind === 'ambience') {
    // the end fades into the start, so the wrap is the same sound continuing
    const length = Math.min(cut.seconds ?? AMBIENCE_SECONDS, seconds(input) - start)
    const x = Math.min(LOOP_CROSSFADE, length / 4)
    // the loop is [x, length): its last x seconds are mixed with the first x, fading across. Not acrossfade:
    // ffmpeg 7.1's cuts its output to a fraction of a second for some inputs (s32 wav, mp3)
    const tail = length - 2 * x
    run(ffmpeg, ['-y', '-i', input, '-filter_complex',
      `[0:a]aresample=44100,atrim=${start}:${start + length},asetpts=PTS-STARTPTS,asplit[a][b];` +
      `[a]atrim=start=${x},asetpts=PTS-STARTPTS,afade=t=out:st=${tail}:d=${x}:curve=qsin[body];` +
      `[b]atrim=0:${x},asetpts=PTS-STARTPTS,afade=t=in:d=${x}:curve=qsin,adelay=delays=${Math.round(tail * 44100)}S:all=1[head];` +
      '[body][head]amix=inputs=2:duration=first:normalize=0', ...format, wav])
  } else if (kind === 'music') {
    run(ffmpeg, ['-y', '-i', input, ...format, wav])
  } else {
    const trim = 'silenceremove=start_periods=1:start_threshold=-50dB'
    const window = cut.seconds === undefined ? '' : `atrim=${start}:${start + cut.seconds},asetpts=PTS-STARTPTS,afade=t=out:st=${cut.seconds - 1}:d=1,`
    run(ffmpeg, ['-y', '-i', input, '-af', `${window}${trim},areverse,${trim},areverse`, ...format, wav])
  }
  // gain toward the target level, a limiter keeping the peaks under -1 dB
  const gain = Math.min(spec.maxGainDb, spec.targetDb - meanDb(wav))
  const mp3 = path.join(out, `${name}.mp3`)
  const ending = spec.loop ? '' : ',areverse,afade=t=in:d=0.01,areverse'
  run(ffmpeg, ['-y', '-i', wav, '-af', `volume=${gain.toFixed(1)}dB,alimiter=limit=0.89:attack=1:release=20:level=false${ending}`,
    '-c:a', 'libmp3lame', '-b:a', spec.bitrate, ...format, '-map_metadata', '-1', '-id3v2_version', '0', mp3])
  const bytes = fs.statSync(mp3).size
  if (bytes > spec.maxBytes) throw new Error(`${name}: ${bytes} bytes is over its cap`)
  total += bytes
  properties[name] = { description, kind, durationSeconds: Math.round(seconds(mp3) * 100) / 100, loop: spec.loop === true }
  console.log(name.padEnd(22), kind.padEnd(9), `${(bytes / 1024).toFixed(1)} KB`.padStart(9), `${properties[name].durationSeconds}s`.padStart(7), `${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`)
}
if (total > MAX_TOTAL_BYTES) throw new Error(`the library is ${total} bytes, over ${MAX_TOTAL_BYTES}`)
console.log('total', `${(total / 1024).toFixed(1)} KB`)
fs.writeFileSync(path.join(out, 'properties.json'), `${JSON.stringify(properties, null, 2)}\n`)
fs.rmSync(work, { recursive: true, force: true })
if (kept === undefined) fs.rmSync(downloads, { recursive: true, force: true })

const credit = ([source, file]) => {
  if (!source.startsWith('oga:')) return `[Kenney](https://kenney.nl), [${KENNEY[source]}](https://kenney.nl/assets/${source}) | \`${file}\``
  const page = source.slice('oga:'.length)
  const [title, author] = OGA[page]
  return `${author}, [${title}](https://opengameart.org/content/${page}) | \`${file}\``
}
const rows = Object.entries(PICKS).map(([name, pick]) => `| \`${name}\` | ${pick[3] ?? 'effect'} | ${credit(pick)} |`)
fs.writeFileSync(path.join(out, 'CREDITS.md'), `# Sound credits

Every sound here is released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/): from
[Kenney](https://kenney.nl)'s audio packs, or uploaded to [OpenGameArt](https://opengameart.org) under CC0 by
the author named below. A scene may use and publish them without credit; the credit is given here anyway.
Effects and voices are mono 96 kbps mp3s with their silence trimmed; an ambience is a ${AMBIENCE_SECONDS} s mono
80 kbps cut whose last quarter second fades into its start; music keeps its own loop length, stereo at 96 kbps.
Each kind is brought to a common loudness under a -1 dB limiter. Lengths and descriptions are in
\`properties.json\`. Regenerate with \`node packages/ui/scripts/pack-sounds.mjs\`.

| Sound | Kind | Author, source | File |
|---|---|---|---|
${rows.join('\n')}
`)
