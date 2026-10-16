import { EDIT_FLOW_MAX_TOKENS, EDIT_FLOW_NOTE_WRITES_MAX } from '@shared/editFlow'
import type { AiMessage } from '../providers/types'
import { editFlowSliceText, editFlowSystem, type EditFlowSliceItem } from './editFlow.v1'

/**
 * Update notes in the edit flow (notes redesign phase 2), version 1: new characters, places,
 * events and timeline the text states go into her note pages, applied at once (each with Undo).
 * The system turn is `editFlow.v1`'s, byte for byte, so a run that also edits shares its cached
 * prefix; the user turn is this task and one slice of the text. A change is a new file.
 */
export const EDIT_NOTES_PROMPT_VERSION = 'editNotes.v1'

export const EDIT_NOTES_TASK = [
  'Update her notes from the text below: characters, places, objects, events and dates the text states that her pages do not hold yet, or now state differently.',
  'Add to the page each belongs on (a character’s page, the timeline); make a new page only for a character, place or thing that has none. Write in her notes’ style: short lines of what the text states, naming the chapter where it matters for the timeline. Never repeat what a page already says, never guess, never copy prose.',
  `At most ${EDIT_FLOW_NOTE_WRITES_MAX} writes. Reply {"notes":[{"page":"p2","add":"lines to add at the end"},{"title":"New page","folder":"Characters","text":"the page"}]}; nothing new is fine: {"notes":[]}.`
].join('\n')

export interface BuildEditNotesPromptInput {
  notes: string
  map: string
  reference: string | null
  slice: { index: number; count: number; label: string }
  items: readonly EditFlowSliceItem[]
}

export interface BuiltEditNotesPrompt {
  version: typeof EDIT_NOTES_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildEditNotesPrompt(input: BuildEditNotesPromptInput): BuiltEditNotesPrompt {
  const part =
    input.slice.count > 1 ? ` (part ${input.slice.index + 1} of ${input.slice.count})` : ''
  const user = [
    `# Task\n${EDIT_NOTES_TASK}`,
    `# Text: ${input.slice.label}${part}\n${editFlowSliceText(input.items)}`
  ].join('\n\n')
  return {
    version: EDIT_NOTES_PROMPT_VERSION,
    messages: [
      { role: 'system', content: editFlowSystem(input.notes, input.map, input.reference) },
      { role: 'user', content: user }
    ],
    maxTokens: EDIT_FLOW_MAX_TOKENS
  }
}
