import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import {
  AUTHOR_RULES_HEADER,
  AUTHOR_RULES_TEXT_MAX,
  AUTHOR_RULES_TOKEN_BUDGET,
  DEFAULT_BANNED_PHRASES,
  defaultAuthorRules,
  renderAuthorRulesBlock,
  type AuthorRules
} from '@shared/authorRules'
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

/** No author rules unless a test asks for them, so the F-14.1 assertions read as they did. */
const NO_AUTHOR_RULES: AuthorRules = { rules: '', bannedPhrases: [] }

function profile(
  rules: string[],
  exemplars: VoiceExemplar[],
  authorRules: AuthorRules = NO_AUTHOR_RULES
): VoiceProfile {
  return {
    rules,
    stats: computeStylometrics(''),
    exemplars,
    authorRules,
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
    ).toBe(
      "Match the author's voice:\n- Narration is in past tense.\n- Short sentences, median 9 words."
    )
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

describe('voiceBlock author rules (F-14.2)', () => {
  const seeded = defaultAuthorRules()

  it('renders the author block on its own, without the voice heading, for a fresh project', () => {
    const block = voiceBlock(profile([], [], seeded), { text: DIALOGUE, pov: null })
    expect(block).not.toBeNull()
    expect(block).not.toContain("Match the author's voice:")
    expect(block?.startsWith(AUTHOR_RULES_HEADER)).toBe(true)
    expect(block).toContain('Never use these phrases: ')
    expect(block).toContain(DEFAULT_BANNED_PHRASES[0])
  })

  it('is null only when there are no rules, no exemplars, and no author rules', () => {
    expect(voiceBlock(profile([], [], NO_AUTHOR_RULES), { text: '', pov: null })).toBeNull()
    expect(
      voiceBlock(profile([], [], { rules: 'British spelling.', bannedPhrases: [] }), {
        text: '',
        pov: null
      })
    ).toBe(`${AUTHOR_RULES_HEADER}\nBritish spelling.`)
  })

  it('places the author block after the stylometric rules and before the exemplars', () => {
    const one = exemplar({})
    const block =
      voiceBlock(profile(['Narration is in past tense.'], [one], seeded), {
        text: '',
        pov: null
      }) ?? ''
    expect(block.indexOf(AUTHOR_RULES_HEADER)).toBeGreaterThan(
      block.indexOf('- Narration is in past tense.')
    )
    expect(block.indexOf(AUTHOR_RULES_HEADER)).toBeLessThan(block.indexOf('Example in this voice'))
    expect(block).toBe(
      `Match the author's voice:\n- Narration is in past tense.\n\n` +
        `${renderAuthorRulesBlock(seeded)}\n\nExample in this voice:\n"""\n${one.text}\n"""`
    )
  })

  it('keeps its own budget: the author block never costs an exemplar its place', () => {
    const rules = ['Narration is in past tense.']
    const long = exemplar({ text: words(300) })
    const another = exemplar({ text: words(300, 'other') })
    const maxed: AuthorRules = {
      rules: 'r '.repeat(AUTHOR_RULES_TEXT_MAX / 2).slice(0, AUTHOR_RULES_TEXT_MAX),
      bannedPhrases: [...DEFAULT_BANNED_PHRASES]
    }
    const withAuthor = voiceBlock(profile(rules, [long, another], maxed), { text: '', pov: null })
    const without = voiceBlock(profile(rules, [long, another]), { text: '', pov: null })
    expect(withAuthor).toContain(long.text)
    expect(withAuthor).not.toContain(another.text)
    const author = renderAuthorRulesBlock(maxed) ?? ''
    expect(estimateTokens(author)).toBeLessThanOrEqual(AUTHOR_RULES_TOKEN_BUDGET)
    expect(estimateTokens(withAuthor ?? '')).toBeLessThanOrEqual(
      VOICE_BLOCK_TOKEN_BUDGET + AUTHOR_RULES_TOKEN_BUDGET
    )
    // The exemplar section is unchanged: the author block is budgeted apart from it.
    expect((withAuthor ?? '').replace(`\n\n${author}`, '')).toBe(without)
  })
})
