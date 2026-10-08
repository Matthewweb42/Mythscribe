import { describe, expect, it } from 'vitest'
import { outputBudget } from '@shared/ai'
import { WHAT_NEXT_INSTRUCTION, WHAT_NEXT_RULES } from './whatNext.v1'
import { buildWhatNextPromptV2 } from './whatNext.v2'
import {
  WHAT_NEXT_PROMPT_V3_VERSION,
  WHAT_NEXT_TIME_RULE,
  buildWhatNextPromptV3
} from './whatNext.v3'

describe('whatNext.v3 prompt (F-5.23 story time)', () => {
  it('puts the rules, the time rule, the bible, and the map in the system turn; the user turn is v2’s', () => {
    const input = { text: 'She waited.', brief: 'BRIEF', steer: 'STEER', bible: 'BIBLE' }
    const built = buildWhatNextPromptV3({ ...input, map: 'MAP' })
    expect(built.version).toBe(WHAT_NEXT_PROMPT_V3_VERSION)
    expect(built.maxTokens).toBe(outputBudget('whatNext'))
    expect(built.messages[0]).toEqual({
      role: 'system',
      content: [WHAT_NEXT_RULES, WHAT_NEXT_TIME_RULE, 'BIBLE', 'MAP'].join('\n\n')
    })
    expect(built.messages[1]).toEqual(buildWhatNextPromptV2(input).messages[1])
    expect(built.messages[1]?.content.endsWith(WHAT_NEXT_INSTRUCTION)).toBe(true)
  })

  it('leaves out an empty bible and map', () => {
    const built = buildWhatNextPromptV3({
      text: 'x',
      brief: null,
      steer: null,
      bible: null,
      map: null
    })
    expect(built.messages[0]?.content).toBe(`${WHAT_NEXT_RULES}\n\n${WHAT_NEXT_TIME_RULE}`)
    expect(WHAT_NEXT_TIME_RULE).toMatchSnapshot()
  })
})
