import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SOUNDS } from './sounds'
import properties from './sounds/properties.json'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('sound library', () => {
  it('ships a file and properties for every sound, and the assistant prompt names each one', () => {
    const files = fs.readdirSync(path.join(here, 'sounds')).filter((f) => f.endsWith('.mp3')).map((f) => f.replace(/\.mp3$/, ''))
    expect(files.sort()).toEqual([...SOUNDS].sort())
    expect(Object.keys(properties).sort()).toEqual([...SOUNDS].sort())
    const prompt = fs.readFileSync(path.join(here, '../../contract/src/assistant-prompt.ts'), 'utf8')
    const listed = prompt.slice(prompt.indexOf('{type:"addSound"'), prompt.indexOf('Play sounds'))
    for (const name of SOUNDS) expect(listed).toMatch(new RegExp(`[\\s,:]${name}[,;. (]`))
  })
})
