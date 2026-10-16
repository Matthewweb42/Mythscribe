import { NOTES_SORT_MAX_TOKENS, NOTES_SORT_PAGES_MAX } from '@shared/notesSort'
import type { AiMessage } from '../providers/types'

/**
 * Sort with Ms Scribe (notes structure part B, 2026-10-16), version 1: one part of a document the
 * author put in Notes, broken into smaller pages in folders. The text is copied, never written
 * anew: main drops a page with a line the part does not hold (`notesSort.ts` `parseSortAnswer`).
 * Prompt files are versioned (F-5.12): a change to the text, the caps, or the message order is a
 * new file.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules and the Notes listing in the system turn
 * (the listing is taken once when a sort starts, so every part of a sort shares the cached prefix);
 * the document's part in the user turn.
 */
export const NOTES_SORT_PROMPT_VERSION = 'notesSort.v1'

/** The opening sentence the e2e's fake provider keys on. */
export const NOTES_SORT_SENTINEL =
  'You are the notes sorter inside a novel-writing app, breaking a document the author put in her notes into smaller pages.'

export const NOTES_SORT_RULES = [
  NOTES_SORT_SENTINEL,
  'Make one page for each character, place, group, object, event, system or topic the document covers; title it with its name as the document writes it, short.',
  'Copy the text: every line you write must be in the document as it stands. You may leave out lines, headings that only repeat the title, and what fits no page (the document stays in her notes), but never reword, summarise, merge sentences or add a word.',
  'Put each page in a folder: one of hers below when it fits, written as listed; else a new short plural name (Characters, Places, Magic); "" for the top of her notes. A title she already has in that folder is fine: the text is added to her page.',
  `At most ${NOTES_SORT_PAGES_MAX} pages. Reply with JSON only: {"pages":[{"folder":"Characters","title":"Mara","text":"lines copied from the document, one per line"}]}; nothing to sort is {"pages":[]}.`
].join('\n')

export interface BuildNotesSortPromptInput {
  /** The Notes listing (`notesListing`): her folders and page titles, taken when the sort started. */
  listing: string
  /** The document's title (the file's name or the page's title). */
  title: string
  part: { index: number; count: number }
  text: string
}

export interface BuiltNotesSortPrompt {
  version: typeof NOTES_SORT_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildNotesSortPrompt(input: BuildNotesSortPromptInput): BuiltNotesSortPrompt {
  const notes = input.listing.trim() === '' ? 'Her notes are empty.' : input.listing.trim()
  const part = input.part.count > 1 ? ` (part ${input.part.index + 1} of ${input.part.count})` : ''
  return {
    version: NOTES_SORT_PROMPT_VERSION,
    messages: [
      { role: 'system', content: `${NOTES_SORT_RULES}\n\n# Her notes\n${notes}` },
      { role: 'user', content: `# Document: ${input.title}${part}\n${input.text}` }
    ],
    maxTokens: NOTES_SORT_MAX_TOKENS
  }
}
