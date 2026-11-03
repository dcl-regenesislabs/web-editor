import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SOUNDS, SOUND_KINDS, findSounds, isSoundName, soundInfo } from './sounds'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('sound library', () => {
  it('ships a file for every sound in the index, and nothing else', () => {
    const files = fs.readdirSync(path.join(here, 'sounds')).filter((f) => f.endsWith('.mp3')).map((f) => f.replace(/\.mp3$/, ''))
    expect(files.sort()).toEqual([...SOUNDS].sort())
  })

  it('names every sound so the desktop app serves it, and gives it a known kind and a description', () => {
    for (const name of SOUNDS) {
      // app-paths.ts serves only sounds/[a-z-]+.mp3
      expect(name).toMatch(/^[a-z-]+$/)
      const info = soundInfo(name)
      expect(SOUND_KINDS).toContain(info.kind)
      expect(info.description.length).toBeGreaterThan(5)
      expect(info.loop).toBe(info.kind === 'ambience' || info.kind === 'music')
    }
  })

  it('credits every sound', () => {
    const credits = fs.readFileSync(path.join(here, 'sounds', 'CREDITS.md'), 'utf8')
    for (const name of SOUNDS) expect(credits).toContain(`| \`${name}\` |`)
  })

  it('cites in the assistant prompt only sounds the library has', () => {
    const prompt = fs.readFileSync(path.join(here, '../../contract/src/assistant-prompt.ts'), 'utf8')
    const listed = prompt.slice(prompt.indexOf('Known names:') + 'Known names:'.length)
    const names = listed.slice(0, listed.indexOf('.')).split(/[\s,]+/).filter((n) => n !== '')
    expect(names.length).toBeGreaterThan(10)
    for (const name of names) expect(isSoundName(name), name).toBe(true)
  })
})

describe('findSounds', () => {
  it('ranks a sound named for the query above one that only mentions it', () => {
    const names = findSounds('door').map((s) => s.name)
    expect(names.slice(0, 3).sort()).toEqual(['door-close', 'door-open', 'door-slide'])
    // "key turning in a lock: unlock, chest opened, door unlocked"
    expect(names.slice(3)).toContain('unlock')
  })

  it('matches the start of a word and narrows by kind', () => {
    expect(findSounds('step', 'effect').map((s) => s.name)).toEqual(expect.arrayContaining(['step-grass', 'step-wood', 'step-snow']))
    expect(findSounds('rain', 'music')).toEqual([])
    expect(findSounds('rain', 'ambience').map((s) => s.name)).toEqual(['rain-loop'])
  })

  it('lists a whole kind for an empty query', () => {
    const music = findSounds('', 'music')
    expect(music.length).toBe(SOUNDS.filter((n) => soundInfo(n).kind === 'music').length)
    expect(music.every((s) => s.loop)).toBe(true)
  })
})
