import {
  EDIT_FLOW_MAX_TOKENS,
  EDIT_FLOW_NOTE_WRITES_MAX,
  EDIT_FLOW_TIMELINE_EVENTS_MAX
} from '@shared/editFlow'
import { STORY_TIMELINE_TITLE } from '@shared/notebook'
import type { AiMessage } from '../providers/types'
import { editFlowSliceText, editFlowSystem } from './editFlow.v1'
import type { BuildEditNotesPromptInput } from './editNotes.v1'

/**
 * Update notes in the edit flow, version 2 (the notes binder, 2026-10-16): as `editNotes.v1`, and
 * it also keeps the Story timeline page in the Timeline section, one line per event that matters
 * for continuity, in story order (a flashback's event where it happened), each after the line it
 * follows (`editFlow/storyTimeline.ts` inserts them; nothing is removed). The system turn is
 * `editFlow.v1`'s, byte for byte, so the cached prefix is shared. A change is a new file.
 */
export const EDIT_NOTES_V2_PROMPT_VERSION = 'editNotes.v2'

export const EDIT_NOTES_V2_TASK = [
  'Update her notes from the text below: characters, places, objects, events and dates the text states that her pages do not hold yet, or now state differently.',
  'Add to the page each belongs on (a character’s page); make a new page only for a character, place or thing that has none. Write in her notes’ style: short lines of what the text states. Never repeat what a page already says, never guess, never copy prose.',
  `Events that matter for continuity go in "timeline", for her page ${STORY_TIMELINE_TITLE}: one line each with its chapter, like "Ch 3 · Mara learns the bell’s secret", in story order (when it happens in the story, not where it is told: a flashback’s event goes where it happened). "after" is the line it follows, copied from that page or from an event you add before it; "" puts it first. Skip events the page already has.`,
  `At most ${EDIT_FLOW_NOTE_WRITES_MAX} writes and ${EDIT_FLOW_TIMELINE_EVENTS_MAX} events. Reply {"notes":[{"page":"p2","add":"lines to add at the end"},{"title":"New page","folder":"Characters","text":"the page"}],"timeline":[{"line":"Ch 2 · what happens","after":"Ch 1 · the line it follows"}]}; nothing new is fine: {"notes":[],"timeline":[]}.`
].join('\n')

export interface BuiltEditNotesV2Prompt {
  version: typeof EDIT_NOTES_V2_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildEditNotesV2Prompt(input: BuildEditNotesPromptInput): BuiltEditNotesV2Prompt {
  const part =
    input.slice.count > 1 ? ` (part ${input.slice.index + 1} of ${input.slice.count})` : ''
  const user = [
    `# Task\n${EDIT_NOTES_V2_TASK}`,
    `# Text: ${input.slice.label}${part}\n${editFlowSliceText(input.items)}`
  ].join('\n\n')
  return {
    version: EDIT_NOTES_V2_PROMPT_VERSION,
    messages: [
      { role: 'system', content: editFlowSystem(input.notes, input.map, input.reference) },
      { role: 'user', content: user }
    ],
    maxTokens: EDIT_FLOW_MAX_TOKENS
  }
}
