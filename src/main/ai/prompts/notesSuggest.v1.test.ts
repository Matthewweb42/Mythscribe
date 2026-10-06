import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import {
  buildNotesSuggestPrompt,
  NOTES_SUGGEST_PROMPT_VERSION,
  NOTES_SUGGEST_RULES
} from './notesSuggest.v1'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago.'
const BIBLE = 'Story bible:\nCharacters: Mara, Tomas'
const BRIEF = 'Scene brief:\n- Goal: Mara reaches the ferry.'

describe('notesSuggest.v1 prompt (F-5.20)', () => {
  it('puts the bible in the system turn and the brief, summary, notes, scene, and focus in the user turn', () => {
    const built = buildNotesSuggestPrompt({
      sceneText: SCENE,
      summary: { summary: 'Mara waits.', keyPoints: ['The river is up.'] },
      brief: BRIEF,
      notes: 'Tomas lies about the ledger.',
      bible: BIBLE,
      instruction: 'the ledger'
    })
    expect(built.version).toBe(NOTES_SUGGEST_PROMPT_VERSION)
    expect(built.version).toBe('notesSuggest.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: `${NOTES_SUGGEST_RULES}\n\n${BIBLE}` },
      {
        role: 'user',
        content:
          `Scene brief (the author's intent):\n"""\n${BRIEF}\n"""\n\n` +
          'Stored summary:\nMara waits.\n- The river is up.\n\n' +
          'Current notes:\n"""\nTomas lies about the ledger.\n"""\n\n' +
          `Scene text:\n"""\n${SCENE}\n"""\n\n` +
          'List the key points, focusing on: the ledger'
      }
    ])
    expect(NOTES_SUGGEST_RULES).toContain('{"points":["..."]}')
    expect(NOTES_SUGGEST_RULES).toContain('At most 8 points')
  })

  it('sends the rules and the scene alone on a fresh project, and costs what the golden estimate says', () => {
    const built = buildNotesSuggestPrompt({
      sceneText: SCENE,
      summary: null,
      brief: null,
      notes: null,
      bible: null,
      instruction: null
    })
    expect(built.messages).toEqual([
      { role: 'system', content: NOTES_SUGGEST_RULES },
      { role: 'user', content: `Scene text:\n"""\n${SCENE}\n"""\n\nList the key points.` }
    ])
    expect(built.maxTokens).toBe(outputBudget('notesSuggest'))
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(181)
  })
})
