import { describe, expect, it } from 'vitest'
import type { AiProviderInfo } from '@dcl-editor/contract'
import { createAssistantOffer } from './assistant-offer'

const provider = (available: boolean): AiProviderInfo =>
  ({ id: 'claude', label: 'Claude', available, defaultModel: 'default', models: [], transport: 'service' })

describe('the assistant offer', () => {
  it('is not answered until the service is, and answers what it said', async () => {
    let answer: (list: AiProviderInfo[]) => void = () => {}
    let changes = 0
    const offer = createAssistantOffer({
      wallet: () => '0xabc',
      providers: () => new Promise((resolve) => { answer = resolve }),
      changed: () => void changes++
    })
    const probing = offer.probe()
    expect(offer.answered()).toBe(false)
    expect(offer.offered()).toBe(false)
    answer([provider(true)])
    await probing
    expect(offer.answered()).toBe(true)
    expect(offer.offered()).toBe(true)
    expect(changes).toBe(1)
  })

  it('asks afresh on a new probe, and only the latest answer counts', async () => {
    const answers: Array<(list: AiProviderInfo[]) => void> = []
    const offer = createAssistantOffer({ wallet: () => '0xabc', providers: () => new Promise((resolve) => { answers.push(resolve) }), changed: () => {} })
    const first = offer.probe()
    const second = offer.probe()
    answers[1]([provider(false)])
    await second
    answers[0]([provider(true)])
    await first
    expect(offer.answered()).toBe(true)
    expect(offer.offered()).toBe(false)
  })

  it('offers nothing to a guest', async () => {
    const offer = createAssistantOffer({ wallet: () => null, providers: async () => [provider(true)], changed: () => {} })
    await offer.probe()
    expect(offer.answered()).toBe(true)
    expect(offer.offered()).toBe(false)
  })
})
