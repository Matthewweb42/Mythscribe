import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import type { VoiceExemplar, VoiceProfile } from '@shared/ipc/contract'
import { computeStylometrics } from '@shared/stylometry'
import { VOICE_BLOCK_TOKEN_BUDGET } from '@shared/voice'
import { voiceBlock } from './voiceBlock'

const words = (n: number, word = 'word'): string => Array(n).fill(word).join(' ')

let counter = 0
function exemplar(over: Partial<VoiceExemplar>): VoiceExemplar {
  counter += 1
  return {
    id: `e${counter}`,
    nodeId: null,
    text: `Exemplar ${counter}: ${words(20)}`,
    pov: null,
    kind: 'mixed',
    created: `2026-09-14T00:00:${String(counter).padStart(2, '0')}.000Z`,
    ...over
  }
}

function profile(rules: string[], exemplars: VoiceExemplar[]): VoiceProfile {
  return {
    rules,
    stats: computeStylometrics(''),
    exemplars,
    confidence: 0,
    wordCount: 0
  }
}

const DIALOGUE = words(6, '"We should leave before the river takes the bridge," she said.')
const ACTION = `${words(30)} She ran and grabbed the rope, turned, ducked, and jumped; he pulled and pushed.`

describe('voiceBlock', () => {
  it('is null for a profile with neither rules nor exemplars', () => {
    expect(voiceBlock(profile([], []), { text: DIALOGUE, pov: null })).toBeNull()
  })

  it('lists the rules and, with no exemplars, nothing else', () => {
    expect(
      voiceBlock(profile(['Narration is in past tense.', 'Short sentences, median 9 words.'], []), {
        text: '',
        pov: null
      })
    ).toBe("Match the author's voice:\n- Narration is in past tense.\n- Short sentences, median 9 words.")
  })

  it('appends up to three exemplars, same kind as the passage first, then same POV, then profile order', () => {
    const plain = exemplar({ kind: 'mixed' })
    const dialogueTomas = exemplar({ kind: 'dialogue', pov: 'Tomas' })
    const actionMara = exemplar({ kind: 'action', pov: 'Mara' })
    const dialogueMara = exemplar({ kind: 'dialogue', pov: 'mara' })
    const block = voiceBlock(profile([], [plain, dialogueTomas, actionMara, dialogueMara]), {
      text: DIALOGUE,
      pov: 'Mara'
    })
    const order = [dialogueMara, dialogueTomas, actionMara].map(
      (e) => `\n\nExample in this voice:\n"""\n${e.text}\n"""`
    )
    expect(block).toBe(`Match the author's voice:${order.join('')}`)
    expect(block).not.toContain(plain.text)
    const forAction = voiceBlock(profile([], [plain, dialogueTomas, actionMara]), {
      text: ACTION,
      pov: null
    })
    expect(forAction?.indexOf(actionMara.text)).toBeLessThan(forAction?.indexOf(plain.text) ?? -1)
  })

  it('stays within the token budget: drops a later exemplar that does not fit, never cuts it', () => {
    const long = exemplar({ text: words(300) }) // ~1,500 chars ≈ 375 tokens
    const another = exemplar({ text: words(300, 'other') })
    const block = voiceBlock(profile(['Narration is in past tense.'], [long, another]), {
      text: '',
      pov: null
    })
    expect(block).toContain(long.text)
    expect(block).not.toContain(another.text)
    expect(estimateTokens(block ?? '')).toBeLessThanOrEqual(VOICE_BLOCK_TOKEN_BUDGET)
  })

  it('cuts the first exemplar at a word boundary when it alone would blow the budget, so one example still goes out', () => {
    const huge = exemplar({ text: words(700, 'river') })
    const block = voiceBlock(profile([], [huge, exemplar({})]), { text: '', pov: null })
    expect(block).toMatch(/river…\n"""$/)
    expect(block).not.toContain('rive…')
    expect(estimateTokens(block ?? '')).toBeLessThanOrEqual(VOICE_BLOCK_TOKEN_BUDGET)
    expect((block?.match(/Example in this voice/g) ?? []).length).toBe(1)
  })

  it('sends the rules alone when no exemplar leaves room for even a short cut', () => {
    const rules = Array.from({ length: 8 }, () => `Rule: ${words(70)}.`) // ~2,400 chars ≈ 600 tokens
    const block = voiceBlock(profile(rules, [exemplar({})]), { text: '', pov: null })
    expect(block).not.toContain('Example in this voice')
  })
})
