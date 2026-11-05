import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAssistantMemory, DEFAULT_MEMORY_LIMITS, TRIMMED_IMAGE_NOTE } from './memory.ts'

const key = Buffer.alloc(32, 1).toString('base64url')
const id = (n: number) => n.toString(16).padStart(32, '0')

it('keeps a bounded number of conversations per wallet and stops keeping them when the volume budget is spent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-memory-caps-'))
  try {
    const a = '0x' + 'a'.repeat(40)
    const memory = createAssistantMemory(dir, { ...DEFAULT_MEMORY_LIMITS, perWallet: 2, totalBytes: 600 })
    const mine = memory.forWallet(a)
    for (const n of [1, 2, 3]) await mine.save({ id: id(n), key }, [`turn ${n}`])
    expect((await readdir(join(dir, a))).sort()).toEqual([`${id(2)}.bin`, `${id(3)}.bin`])

    await mine.save({ id: id(3), key }, ['x'.repeat(1000)])
    expect(await mine.load({ id: id(3), key })).toEqual(['turn 3'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('preserves existing conversations when a new one exceeds the total cap even after eviction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-memory-admission-'))
  try {
    const wallet = '0x' + 'a'.repeat(40)
    const memory = createAssistantMemory(dir, { ...DEFAULT_MEMORY_LIMITS, perWallet: 2, totalBytes: 160 })
    const mine = memory.forWallet(wallet)
    await mine.save({ id: id(1), key }, ['one'])
    await mine.save({ id: id(2), key }, ['two'])
    await memory.forWallet('0x' + 'b'.repeat(40)).save({ id: id(1), key }, ['x'.repeat(30)])

    await mine.save({ id: id(3), key }, ['x'.repeat(50)])
    expect(await mine.load({ id: id(1), key })).toEqual(['one'])
    expect(await mine.load({ id: id(2), key })).toEqual(['two'])
    expect(await mine.load({ id: id(3), key })).toBeNull()

    await mine.save({ id: id(3), key }, ['three'])
    expect(await mine.load({ id: id(3), key })).toEqual(['three'])
    expect(await readdir(join(dir, wallet))).toHaveLength(2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('drops the oldest images first to keep a long conversation, and says when it still does not fit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-memory-fit-'))
  try {
    const wallet = '0x' + 'a'.repeat(40)
    const image = (fill: string) => ({ type: 'image', mimeType: 'image/png', data: fill.repeat(400) })
    const conversation = [
      { type: 'message', message: { role: 'toolResult', content: [image('a')] } },
      { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'scene view' }, image('b')] } },
      { type: 'message', message: { role: 'user', content: [image('c')] } }
    ]
    const size = Buffer.byteLength(JSON.stringify(conversation))
    const mine = createAssistantMemory(dir, { ...DEFAULT_MEMORY_LIMITS, maxBytes: size - 300 }).forWallet(wallet)

    expect(await mine.save({ id: id(1), key }, conversation)).toBe('trimmed')
    const kept = JSON.stringify(await mine.load({ id: id(1), key }))
    expect(kept).toContain(TRIMMED_IMAGE_NOTE)
    expect(kept).not.toContain('a'.repeat(400))
    expect(kept).toContain('b'.repeat(400))
    expect(kept).toContain('c'.repeat(400))
    expect(conversation[0].message.content[0]).toMatchObject({ type: 'image' })

    expect(await mine.save({ id: id(1), key }, ['x'.repeat(size)])).toBe('too_large')
    expect(await mine.load({ id: id(1), key })).toBeNull()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
