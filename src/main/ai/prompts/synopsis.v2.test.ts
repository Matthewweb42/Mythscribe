import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { CARD_PROMPT_HEADING, type PromptCard } from '@shared/memory/cardText'
import { SCENE_SYNOPSIS_MAX } from '@shared/sceneMeta'
import {
  buildSynopsisPromptV2,
  SYNOPSIS_PROMPT_V2_VERSION,
  SYNOPSIS_RULES_V2,
  SYNOPSIS_V2_SENTINEL
} from './synopsis.v2'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago.'
const CARD: PromptCard = {
  line: 'Mara waits at the empty landing.',
  gist: 'Mara reaches the ferry landing and finds it empty, the bell without its clapper.',
  where: 'the ferry landing',
  when: null,
  pov: 'Mara Vell',
  mood: 'bleak',
  theme: 'abandonment'
}

describe('synopsis.v2 prompt (F-16.20)', () => {
  it('sends the card in the stored summary’s place, the rules alone in the system turn', () => {
    const built = buildSynopsisPromptV2({ sceneText: SCENE, card: CARD })
    expect(built.version).toBe(SYNOPSIS_PROMPT_V2_VERSION)
    expect(built.version).toBe('synopsis.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: SYNOPSIS_RULES_V2 },
      {
        role: 'user',
        content:
          `${CARD_PROMPT_HEADING}\nLine: Mara waits at the empty landing.\n` +
          'Gist: Mara reaches the ferry landing and finds it empty, the bell without its clapper.\n' +
          'Where: the ferry landing; POV: Mara Vell\n\n' +
          `Scene text:\n"""\n${SCENE}\n"""\n\nWrite the synopsis.`
      }
    ])
    expect(built.messages[1]?.content).not.toContain('Stored summary')
    // The card is a map: never the mood or theme here (a synopsis is a planning note).
    expect(built.messages[1]?.content).not.toContain('bleak')
    expect(SYNOPSIS_RULES_V2).toContain(`at most ${SCENE_SYNOPSIS_MAX} characters`)
    expect(SYNOPSIS_RULES_V2).toContain('follow the text')
    expect(SYNOPSIS_RULES_V2).toContain('{"synopsis":"..."}')
  })

  it('opens with its sentinel, which the e2e declares, and differs from version 1 there', () => {
    expect(SYNOPSIS_RULES_V2.startsWith(SYNOPSIS_V2_SENTINEL)).toBe(true)
    const spec = readFileSync(join(__dirname, '../../../../e2e/memory.spec.ts'), 'utf8')
    const match = /const SYNOPSIS_V2_SENTINEL =\s*'([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/memory.spec.ts no longer declares SYNOPSIS_V2_SENTINEL')
    expect(match[1]).toBe(SYNOPSIS_V2_SENTINEL)
  })

  it('leaves the card out before the first reading; the golden size; the caps', () => {
    const built = buildSynopsisPromptV2({ sceneText: SCENE, card: null })
    expect(built.messages[1]?.content).toBe(
      `Scene text:\n"""\n${SCENE}\n"""\n\nWrite the synopsis.`
    )
    expect(built.maxTokens).toBe(outputBudget('synopsis'))
    expect('temperature' in built).toBe(false)
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(175)
    const maxed = buildSynopsisPromptV2({
      sceneText: 'x'.repeat(12_000),
      card: { ...CARD, line: 'l'.repeat(250), gist: 'g'.repeat(700) }
    })
    expect(estimateTokens(maxed.messages.map((m) => m.content).join('\n'))).toBeLessThanOrEqual(
      inputBudget('synopsis')
    )
  })
})
