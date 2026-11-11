// The shared sound library: CC0 sounds (sounds/<name>.mp3, see CREDITS.md) indexed by sounds/properties.json and
// written into a project once, when the assistant first uses one. Regenerate with scripts/pack-sounds.mjs.
import properties from './sounds/properties.json'

export type SoundName = keyof typeof properties
export const SOUND_KINDS = ['effect', 'voice', 'ambience', 'music'] as const
export type SoundKind = (typeof SOUND_KINDS)[number]
export interface SoundInfo {
  description: string
  kind: SoundKind
  durationSeconds: number
  loop: boolean
}

const library: Record<SoundName, SoundInfo> = properties as Record<SoundName, SoundInfo>
export const SOUNDS = Object.keys(library) as SoundName[]

/** Where a sound is served beside editor.js. */
export const soundFile = (name: SoundName): string => `sounds/${name}.mp3`
/** Where a sound sits in the project: its own folder, so a creator's assets/audio/<name>.mp3 is never mistaken for it. */
export const soundProjectPath = (name: SoundName): string => `assets/audio/library/${name}.mp3`

export const soundInfo = (name: SoundName): SoundInfo => library[name]

export function isSoundName(name: unknown): name is SoundName {
  return typeof name === 'string' && (SOUNDS as readonly string[]).includes(name)
}

export function isSoundKind(kind: unknown): kind is SoundKind {
  return typeof kind === 'string' && (SOUND_KINDS as readonly string[]).includes(kind)
}

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1)

/**
 * The library's sounds that fit a query, best first: each query word found in a sound's name or description
 * counts, a word in the name counts double, and a word matches the start of a longer one ("splash" finds
 * "splashes", "step" finds "steps"). An empty query lists the whole kind.
 */
export function findSounds(query: string, kind?: SoundKind): Array<{ name: SoundName } & SoundInfo> {
  const wanted = words(query)
  const ranked: Array<{ name: SoundName; score: number }> = []
  for (const name of SOUNDS) {
    const info = library[name]
    if (kind !== undefined && info.kind !== kind) continue
    const nameWords = words(name)
    const textWords = words(info.description)
    let score = 0
    for (const w of wanted) {
      if (nameWords.some((n) => n.startsWith(w))) score += 2
      else if (textWords.some((t) => t.startsWith(w))) score += 1
    }
    if (wanted.length === 0 || score > 0) ranked.push({ name, score })
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked.map(({ name }) => ({ name, ...library[name] }))
}
