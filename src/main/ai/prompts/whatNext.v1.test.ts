import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import {
  buildWhatNextPrompt,
  WHAT_NEXT_INSTRUCTION,
  WHAT_NEXT_PROMPT_VERSION,
  WHAT_NEXT_RULES
} from './whatNext.v1'

const TEXT =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water, and ' +
  'somewhere upriver a bell rang twice.'

describe('whatNext.v1 prompt (F-5.17)', () => {
  it('pins the rules: the sentinel opening, the count, the caps, and the JSON shape', () => {
    expect(WHAT_NEXT_PROMPT_VERSION).toBe('whatNext.v1')
    expect(WHAT_NEXT_RULES).toBe(
      'You are the what-comes-next feature inside a novel-writing app. Read the text so far, the ' +
        "scene brief (the author's intent), and the story bible, and suggest " +
        '3 different directions the story could take right after the last ' +
        'line: each a plausible next beat that follows from what is on the page, serves the brief, ' +
        'and keeps to the characters, places, and rules the bible states. Do not write the prose ' +
        'itself and do not summarise what already happened. Each direction has a title of at most ' +
        '80 characters and a text of one or two sentences, at most ' +
        '300 characters. Reply with JSON only: ' +
        '{"directions":[{"title":"...","text":"..."}]}.'
    )
    expect(
      WHAT_NEXT_RULES.startsWith('You are the what-comes-next feature inside a novel-writing app.')
    ).toBe(true)
    expect(WHAT_NEXT_INSTRUCTION).toBe('Suggest three directions for what comes next.')
  })

  it('puts the story bible in the system turn and the brief before the text in the user turn', () => {
    const built = buildWhatNextPrompt({
      text: TEXT,
      brief: 'Goal: Mara reaches the ferry.',
      bible: 'Story bible:\nCharacters: Mara, Tomas'
    })
    expect(built.version).toBe('whatNext.v1')
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: `${WHAT_NEXT_RULES}\n\nStory bible:\nCharacters: Mara, Tomas`
      },
      {
        role: 'user',
        content:
          'Scene brief (the author\'s intent):\n"""\nGoal: Mara reaches the ferry.\n"""\n\n' +
          `Text so far:\n"""\n${TEXT}\n"""\n\n` +
          'Suggest three directions for what comes next.'
      }
    ])
    expect('temperature' in built).toBe(false)
  })

  it('leaves the story bible and the brief out when there are none', () => {
    const built = buildWhatNextPrompt({ text: TEXT, brief: null, bible: null })
    expect(built.messages).toEqual([
      { role: 'system', content: WHAT_NEXT_RULES },
      {
        role: 'user',
        content: `Text so far:\n"""\n${TEXT}\n"""\n\nSuggest three directions for what comes next.`
      }
    ])
  })

  it('asks for the feature output budget and costs what the golden estimates say', () => {
    const built = buildWhatNextPrompt({ text: TEXT, brief: null, bible: null })
    expect(built.maxTokens).toBe(outputBudget('whatNext'))
    // The golden estimates: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(WHAT_NEXT_RULES)).toBe(158)
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(207)
  })

  it("pins the e2e fake server's WHAT_NEXT_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const WHAT_NEXT_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares WHAT_NEXT_SENTINEL')
    expect(match[1]).toBe('You are the what-comes-next feature inside a novel-writing app.')
    expect(WHAT_NEXT_RULES.startsWith(match[1]!)).toBe(true)
  })
})
