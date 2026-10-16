import { describe, expect, it } from 'vitest'
import { EDIT_FLOW_MAX_TOKENS, EDIT_FLOW_NOTE_WRITES_MAX } from '@shared/editFlow'
import { EDIT_FLOW_SENTINEL } from './editFlow.v1'
import { buildEditNotesPrompt, EDIT_NOTES_PROMPT_VERSION, EDIT_NOTES_TASK } from './editNotes.v1'

describe('editNotes.v1 prompt (notes redesign phase 2, Update notes)', () => {
  it('asks for appends and new pages from one slice, under the flow’s shared prefix', () => {
    const built = buildEditNotesPrompt({
      notes: '## p1 Mara (note)\nEyes: grey.',
      map: 'n3 Chapter 1 › Mara',
      reference: null,
      slice: { index: 0, count: 1, label: 'Chapter 1' },
      items: [
        {
          ref: 'n3',
          title: 'Chapter 1 › Mara',
          text: 'Rook met Mara at the quay.',
          part: { index: 0, count: 1 }
        }
      ]
    })
    expect(built.version).toBe(EDIT_NOTES_PROMPT_VERSION)
    expect(built.maxTokens).toBe(EDIT_FLOW_MAX_TOKENS)
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content.startsWith(EDIT_FLOW_SENTINEL)).toBe(true)
    expect(built.messages[1]?.content.startsWith(`# Task\n${EDIT_NOTES_TASK}`)).toBe(true)
    expect(EDIT_NOTES_TASK).toContain(`At most ${EDIT_FLOW_NOTE_WRITES_MAX} writes.`)
    expect(built.messages[1]?.content).toContain('### n3 Chapter 1 › Mara\nRook met Mara at the quay.')
  })
})
