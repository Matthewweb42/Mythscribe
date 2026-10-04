import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { buildProofreadPrompt, PROOFREAD_PROMPT_VERSION, PROOFREAD_RULES } from './proofread.v1'

const TEXT =
  'The ferry landing was empty when Marra reached it. The the rope hung slack in the water.'

describe('proofread.v1 prompt (F-14.12)', () => {
  it('pins the rules: the sentinel opening, the kinds, the caps, and the JSON shape', () => {
    expect(PROOFREAD_PROMPT_VERSION).toBe('proofread.v1')
    expect(PROOFREAD_RULES).toBe(
      'You are the proofreading feature inside a novel-writing app. Correct only spelling, typos, ' +
        'grammar, punctuation, doubled words, missing words, and misspelled story names. Never ' +
        'change style, word choice, rhythm, tense, or voice: fragments, dialect, slang, and ' +
        "deliberate repetition follow the author's voice and rules and are left alone. Words in the " +
        'keep list are correct as written, and a word close to a listed name is that name ' +
        'misspelled (kind name). List at most 30 fixes, one per error, with no ' +
        'two quotes overlapping. Each quote is the shortest passage that contains the error and ' +
        'occurs only once in the text, a few words copied word for word and at most ' +
        '160 characters; the fix is that passage corrected and nothing else. ' +
        'Reply with JSON only: {"fixes":[{"kind":"...","quote":"...","fix":"..."}]}, kind one of ' +
        'spelling, typo, grammar, punctuation, doubledWord, missingWord, name; with no error, ' +
        '{"fixes":[]}.'
    )
  })

  it('puts the voice block and the keep list in the system turn, the brief before the text', () => {
    const built = buildProofreadPrompt({
      text: TEXT,
      voice: "Match the author's voice: short sentences.",
      brief: 'Goal: Mara reaches the ferry.',
      keepWords: ['Mara', 'Tomas', 'kethra']
    })
    expect(built.version).toBe('proofread.v1')
    expect(built.messages).toEqual([
      {
        role: 'system',
        content:
          `${PROOFREAD_RULES} Match the author's voice: short sentences.\n\n` +
          'Keep as written: Mara, Tomas, kethra.'
      },
      {
        role: 'user',
        content:
          'Scene brief (context only, not to proofread):\n"""\nGoal: Mara reaches the ferry.\n"""\n\n' +
          `Text to proofread:\n"""\n${TEXT}\n"""\n\n` +
          'Proofread the text.'
      }
    ])
    expect('temperature' in built).toBe(false)
  })

  it('leaves the voice block, the keep list, and the brief out when there are none', () => {
    const built = buildProofreadPrompt({ text: TEXT, voice: null, brief: null, keepWords: [] })
    expect(built.messages).toEqual([
      { role: 'system', content: PROOFREAD_RULES },
      { role: 'user', content: `Text to proofread:\n"""\n${TEXT}\n"""\n\nProofread the text.` }
    ])
  })

  it('asks for the feature output budget and costs what the golden estimates say', () => {
    const built = buildProofreadPrompt({ text: TEXT, voice: null, brief: null, keepWords: [] })
    expect(built.maxTokens).toBe(outputBudget('proofread'))
    // The golden estimates: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(PROOFREAD_RULES)).toBe(230)
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(264)
  })

  it("pins the e2e fake server's PROOFREAD_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const PROOFREAD_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares PROOFREAD_SENTINEL')
    expect(match[1]).toBe('You are the proofreading feature inside a novel-writing app.')
    expect(PROOFREAD_RULES.startsWith(match[1]!)).toBe(true)
  })
})
