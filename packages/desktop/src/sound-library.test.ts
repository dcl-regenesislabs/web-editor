import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addSoundLibrary } from './skills'

const dirs: string[] = []
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-library-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function library(): string {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'coin.mp3'), 'mp3')
  fs.writeFileSync(path.join(dir, 'CREDITS.md'), 'Kenney CC0')
  fs.writeFileSync(path.join(dir, 'properties.json'), '{}')
  return dir
}

describe('addSoundLibrary', () => {
  it('puts the mp3s and their credits beside the game-sounds skill', () => {
    const skills = tmp()
    fs.mkdirSync(path.join(skills, 'game-sounds'))
    fs.writeFileSync(path.join(skills, 'game-sounds', 'SKILL.md'), '---')
    addSoundLibrary(skills, library(), () => {})
    expect(fs.readdirSync(path.join(skills, 'game-sounds', 'sounds')).sort()).toEqual(['CREDITS.md', 'coin.mp3'])
  })

  it('leaves a cache without the skill alone', () => {
    const skills = tmp()
    addSoundLibrary(skills, library(), () => {})
    expect(fs.existsSync(path.join(skills, 'game-sounds'))).toBe(false)
  })
})
