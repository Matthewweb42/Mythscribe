import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import {
  buildVoiceNotesPrompt,
  VOICE_NOTES_PROMPT_VERSION,
  VOICE_NOTES_RULES
} from './voiceNotes.v1'

const PASSAGES = [
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water.',
  '"You came alone," Tomas said.\n"You said to," she said.'
]

describe('voiceNotes.v1 prompt (F-14.14)', () => {
  it('puts the rules in the system turn and the passages in the user turn', () => {
    const built = buildVoiceNotesPrompt({ passages: PASSAGES, previous: [] })
    expect(VOICE_NOTES_PROMPT_VERSION).toBe('voiceNotes.v1')
    expect(built.version).toBe('voiceNotes.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: VOICE_NOTES_RULES },
      {
        role: 'user',
        content: `Passages:\n"""\n${PASSAGES[0]}\n\n${PASSAGES[1]}\n"""\n\nWrite the style notes.`
      }
    ])
    expect(
      VOICE_NOTES_RULES.startsWith('You are the style-notes feature inside a novel-writing app.')
    ).toBe(true)
    expect(VOICE_NOTES_RULES).toContain('{"notes":["..."]}')
    expect('temperature' in built).toBe(false)
  })

  it('lists the earlier notes ahead of the passages', () => {
    const built = buildVoiceNotesPrompt({ passages: PASSAGES, previous: ['Uses said.', 'Short.'] })
    expect(
      built.messages[1]?.content.startsWith('Earlier notes:\n- Uses said.\n- Short.\n\nPassages:')
    ).toBe(true)
  })

  it('asks for the feature output budget and costs what the golden estimates say', () => {
    const built = buildVoiceNotesPrompt({ passages: PASSAGES, previous: [] })
    expect(built.maxTokens).toBe(outputBudget('voiceNotes'))
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(217)
  })
})
