import type { ModelAsset } from '../assets'

const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'for', 'and', 'or', 'to', 'in', 'on', 'some', 'model', 'models'])
const FLAT_WORDS = new Set(['flat', 'picture', 'photo', 'poster', 'print', 'painting', 'frame', 'sign', 'banner', 'billboard', 'logo', 'nft', 'flag', 'decal', 'sticker', 'skybox'])

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(x|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

// letters and digits apart: names run them together ("Rock01", "Track7Structure3")
const words = (text: string | undefined) => (text ?? '').toLowerCase().match(/[a-z]+|[0-9]+/g)?.map(stem) ?? []

type Indexed = { fields: [string[], number][], flat: boolean }
const index = new WeakMap<ModelAsset, Indexed>()

function indexed(a: ModelAsset): Indexed {
  let entry = index.get(a)
  if (entry === undefined) {
    const tags = a.tags.flatMap(words)
    const fields: [string[], number][] = [
      [words(a.name), 3], [words(a.subcategory), 4], [tags, 2], [words(a.category), 2], [words(a.description), 1]
    ]
    entry = { fields, flat: isFlat(a, fields[1][0]) }
    index.set(a, entry)
  }
  return entry
}

// subcategory, not tags: "flat"/"nft"/"frame" also tag flat-shaded walls, avatars and shelves; a "3d-logo" is solid
// and a thin ground piece is just a floor
function isFlat(a: ModelAsset, kind: string[]): boolean {
  if (kind.some((w) => FLAT_WORDS.has(w))) return !(kind.includes('3') && kind.includes('d'))
  const dims = [a.width, a.height, a.depth].filter((d): d is number => d !== undefined)
  return a.category !== 'ground' && dims.length === 3 && Math.min(...dims) < 0.03 && Math.max(...dims) > 0.3
}

// whole words, never substrings ("dog" is not in "doge"); pictures and signs sink unless asked for
export function searchModels(assets: ModelAsset[], query: string, limit: number): ModelAsset[] {
  const wanted = [...new Set(words(query).filter((w) => w.length > 1 && !STOP.has(w)))]
  if (wanted.length === 0) return []
  const askedFlat = wanted.some((w) => FLAT_WORDS.has(w))
  const scored = assets.map((a) => {
    const { fields, flat } = indexed(a)
    let matched = 0
    let score = 0
    for (const w of wanted) {
      const hit = fields.reduce((sum, [field, weight]) => sum + (field.includes(w) ? weight : 0), 0)
      if (hit > 0) matched++
      score += hit
    }
    return { a, matched, score, sinks: !askedFlat && flat }
  }).filter((s) => s.matched > 0)
  scored.sort((p, q) => q.matched - p.matched || Number(p.sinks) - Number(q.sinks) || q.score - p.score || (p.a.triangles ?? 0) - (q.a.triangles ?? 0))
  return scored.slice(0, limit).map((s) => s.a)
}

export const isFlatModel = (a: ModelAsset): boolean => indexed(a).flat
