import { describe, expect, it } from 'vitest'
import { outputBudget } from '@shared/ai'
import type { ContinuityRef } from '@shared/continuity'
import { CONTINUITY_RULES } from './continuity.v1'
import {
  CONTINUITY_PROMPT_V2_VERSION,
  CONTINUITY_RULES_V2,
  buildContinuityPromptV2,
  continuityRefLineV2
} from './continuity.v2'

const ref = (over: Partial<ContinuityRef>): ContinuityRef => ({
  kind: 'sheet',
  entityId: 'e1',
  entityName: 'Pell',
  entityKind: 'character',
  attribute: 'background',
  label: 'Background',
  value: 'Dies in the war.',
  nodeId: null,
  quote: null,
  ...over
})

describe('continuity.v2 prompt (F-5.23 story time)', () => {
  it('keeps the e2e sentinel and adds the story-time rule', () => {
    expect(CONTINUITY_PROMPT_V2_VERSION).toBe('continuity.v2')
    const sentinel = 'You are the continuity feature inside a novel-writing app.'
    expect(CONTINUITY_RULES.startsWith(sentinel)).toBe(true)
    expect(CONTINUITY_RULES_V2.startsWith(sentinel)).toBe(true)
    expect(CONTINUITY_RULES_V2).toContain('Story time:')
    expect(CONTINUITY_RULES_V2).toMatchSnapshot()
  })

  it('says where each reference comes from in story time', () => {
    const later = new Set(['s9'])
    expect(continuityRefLineV2(ref({}), 1, later)).toBe(
      '[1] Pell (character), sheet (notes and plans), Background: Dies in the war.'
    )
    expect(
      continuityRefLineV2(ref({ kind: 'fact', nodeId: 's9', quote: 'He fell.' }), 2, later)
    ).toBe('[2] Pell (character), a later scene, Background: Dies in the war.; passage: "He fell."')
    expect(continuityRefLineV2(ref({ kind: 'fact', nodeId: 's1' }), 3, later)).toBe(
      '[3] Pell (character), an earlier scene, Background: Dies in the war.'
    )
    expect(
      continuityRefLineV2(ref({ kind: 'timeline', label: 'Timeline', value: 'Spring' }), 4, later)
    ).toBe('[4] Previous scene, Timeline: Spring')
  })

  it('orders the rules and voice, then the brief, references, timeline, and scene', () => {
    const built = buildContinuityPromptV2({
      sceneText: 'Pell laughed.',
      references: [ref({})],
      later: new Set(),
      timeline: 'Night',
      voice: 'VOICE',
      brief: 'BRIEF'
    })
    expect(built.version).toBe('continuity.v2')
    expect(built.maxTokens).toBe(outputBudget('continuity'))
    expect(built.messages).toEqual([
      { role: 'system', content: `${CONTINUITY_RULES_V2} VOICE` },
      {
        role: 'user',
        content:
          'Scene brief (the author\'s intent):\n"""\nBRIEF\n"""\n\n' +
          'References:\n[1] Pell (character), sheet (notes and plans), Background: Dies in the war.\n\n' +
          "This scene's timeline: Night\n\n" +
          'Scene text:\n"""\nPell laughed.\n"""\n\nList the contradictions.'
      }
    ])
  })
})
