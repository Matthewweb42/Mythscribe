import { describe, expect, it } from 'vitest'
import {
  EDIT_FLOW_MAX_TOKENS,
  EDIT_FLOW_NOTE_WRITES_MAX,
  EDIT_FLOW_TIMELINE_EVENTS_MAX
} from '@shared/editFlow'
import { EDIT_FLOW_SENTINEL } from './editFlow.v1'
import { buildEditNotesPrompt } from './editNotes.v1'
import {
  buildEditNotesV2Prompt,
  EDIT_NOTES_V2_PROMPT_VERSION,
  EDIT_NOTES_V2_TASK
} from './editNotes.v2'

const input = {
  notes:
    '## p1 Mara (note, Documents › Characters)\nEyes: grey.\n\n## p2 Story timeline (note, Timeline)\nCh 1 · Mara reaches the quay.',
  map: 'n3 Chapter 1 › Mara',
  reference: null,
  slice: { index: 0, count: 1, label: 'Chapter 2' },
  items: [
    {
      ref: 'n3',
      title: 'Chapter 2 › Mara',
      text: 'Years before, the winter the river froze, Rook burned the first ledger.',
      part: { index: 0, count: 1 }
    }
  ]
}

describe('editNotes.v2 prompt (the notes binder: Update notes keeps the Story timeline)', () => {
  it('asks for note writes and timeline events in story order, under the flow’s shared prefix', () => {
    const built = buildEditNotesV2Prompt(input)
    expect(built.version).toBe(EDIT_NOTES_V2_PROMPT_VERSION)
    expect(built.maxTokens).toBe(EDIT_FLOW_MAX_TOKENS)
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content.startsWith(EDIT_FLOW_SENTINEL)).toBe(true)
    expect(built.messages[1]?.content.startsWith(`# Task\n${EDIT_NOTES_V2_TASK}`)).toBe(true)
    expect(EDIT_NOTES_V2_TASK).toContain(
      `At most ${EDIT_FLOW_NOTE_WRITES_MAX} writes and ${EDIT_FLOW_TIMELINE_EVENTS_MAX} events.`
    )
    expect(EDIT_NOTES_V2_TASK).toContain('Story timeline')
    expect(EDIT_NOTES_V2_TASK).toContain('a flashback’s event goes where it happened')
  })

  it('shares v1’s system turn byte for byte, so the cached prefix is the same', () => {
    expect(buildEditNotesV2Prompt(input).messages[0]).toEqual(
      buildEditNotesPrompt(input).messages[0]
    )
  })
})
