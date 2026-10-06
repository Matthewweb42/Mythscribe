import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { buildSynopsisPrompt, SYNOPSIS_PROMPT_VERSION, SYNOPSIS_RULES } from './synopsis.v1'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago.'

describe('synopsis.v1 prompt (F-5.20)', () => {
  it('sends the stored summary and key points before the scene, the rules alone in the system turn', () => {
    const built = buildSynopsisPrompt({
      sceneText: SCENE,
      summary: { summary: 'Mara waits for Tomas.', keyPoints: ['The river is up.'] }
    })
    expect(built.version).toBe(SYNOPSIS_PROMPT_VERSION)
    expect(built.version).toBe('synopsis.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: SYNOPSIS_RULES },
      {
        role: 'user',
        content:
          'Stored summary:\nMara waits for Tomas.\n- The river is up.\n\n' +
          `Scene text:\n"""\n${SCENE}\n"""\n\nWrite the synopsis.`
      }
    ])
    expect(SYNOPSIS_RULES).toContain('{"synopsis":"..."}')
    expect(SYNOPSIS_RULES).toContain('at most 1000 characters')
  })

  it('leaves the summary out when there is none, and costs what the golden estimate says', () => {
    const built = buildSynopsisPrompt({ sceneText: SCENE, summary: null })
    expect(built.messages[1]?.content).toBe(
      `Scene text:\n"""\n${SCENE}\n"""\n\nWrite the synopsis.`
    )
    expect(built.maxTokens).toBe(outputBudget('synopsis'))
    expect('temperature' in built).toBe(false)
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(134)
  })
})
