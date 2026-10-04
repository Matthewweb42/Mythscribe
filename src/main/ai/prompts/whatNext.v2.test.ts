import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { buildWhatNextPrompt, WHAT_NEXT_RULES } from './whatNext.v1'
import { buildWhatNextPromptV2, WHAT_NEXT_PROMPT_V2_VERSION } from './whatNext.v2'

const TEXT =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water, and ' +
  'somewhere upriver a bell rang twice.'
const STEER = `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`

describe('whatNext.v2 prompt (F-5.17, F-14.13)', () => {
  it('keeps version 1’s rules, sentinel included, and puts the steer between the brief and the text', () => {
    const built = buildWhatNextPromptV2({
      text: TEXT,
      brief: 'Goal: Mara reaches the ferry.',
      steer: STEER,
      bible: 'Story bible:\nCharacters: Mara, Tomas'
    })
    expect(WHAT_NEXT_PROMPT_V2_VERSION).toBe('whatNext.v2')
    expect(built.version).toBe('whatNext.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${WHAT_NEXT_RULES}\n\nStory bible:\nCharacters: Mara, Tomas` },
      {
        role: 'user',
        content:
          'Scene brief (the author\'s intent):\n"""\nGoal: Mara reaches the ferry.\n"""\n\n' +
          `${STEER}\n\n` +
          `Text so far:\n"""\n${TEXT}\n"""\n\n` +
          'Suggest three directions for what comes next.'
      }
    ])
    expect(
      WHAT_NEXT_RULES.startsWith('You are the what-comes-next feature inside a novel-writing app.')
    ).toBe(true)
    expect('temperature' in built).toBe(false)
  })

  it('is the version-1 prompt when there is no steer', () => {
    for (const input of [
      { text: TEXT, brief: null, bible: null },
      {
        text: TEXT,
        brief: 'Goal: Mara reaches the ferry.',
        bible: 'Story bible:\nCharacters: Mara'
      }
    ]) {
      const v2 = buildWhatNextPromptV2({ ...input, steer: null })
      const v1 = buildWhatNextPrompt(input)
      expect(v2.messages).toEqual(v1.messages)
      expect(v2.maxTokens).toBe(v1.maxTokens)
    }
  })

  it('asks for the feature output budget and costs what the golden estimates say', () => {
    const built = buildWhatNextPromptV2({ text: TEXT, brief: null, steer: STEER, bible: null })
    expect(built.maxTokens).toBe(outputBudget('whatNext'))
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(225)
  })
})
