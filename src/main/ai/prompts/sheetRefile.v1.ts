import { REFILE_MAX_TOKENS } from '@shared/sheetSync'
import type { AiMessage } from '../providers/types'
import { sheetFieldLines, type SheetPromptField } from './sheetWriteUp.v1'

/**
 * The sheet filing prompt (F-9.18), version 1: one story-bible sheet's fields and the author's
 * edits to its page in (the paragraphs removed and added since the views last agreed), the edits
 * filed into the fields out, as compact JSON — never whole field values: each edit names a field,
 * the text it replaces, and the new text, and main applies them locally (`applyRefile`). Something
 * the page says that no field holds comes back as a field of the sheet's own. The author's own
 * words re-filed (CLAUDE.md, AI rule 1). Prompt files are versioned (F-5.12).
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable rules; the user turn
 * carries the sheet and the edits.
 */
export const SHEET_REFILE_PROMPT_VERSION = 'sheetRefile.v1'

/**
 * The rules. The opening sentence names the feature, so a test fake (and the developer tools'
 * inspector) can tell a filing request at a glance; it must not change within this version.
 */
export const SHEET_REFILE_RULES =
  'You are the sheet filing feature inside a novel-writing app. The author keeps a ' +
  'story-bible sheet both as fields and as a page of prose, and has edited the page. File the ' +
  'edits into the fields: what a removed passage said comes out of the field that holds it; ' +
  'what an added passage says goes into the field it belongs to, in the author’s own words as ' +
  'far as the field allows. Change nothing the edits do not touch and add no fact they do not ' +
  'state. Each edit names a field id: "old" is text copied exactly from that field’s value to ' +
  'replace (empty to add to the end), "new" replaces it (empty to remove it). Anything no field ' +
  'fits goes in "add" with a short label of its own. Reply with JSON only: ' +
  '{"edits":[{"f":"id","old":"...","new":"..."}],"add":[{"label":"...","value":"..."}]}.'

/** The user turn's closing instruction. */
export const SHEET_REFILE_INSTRUCTION = 'File the edits.'

export interface BuildSheetRefilePromptInput {
  name: string
  noun: string
  /** Every field of the sheet in order; an empty one is sent as "(empty)" so it can be filled. */
  fields: readonly SheetPromptField[]
  removed: readonly string[]
  added: readonly string[]
}

export interface BuiltSheetRefilePrompt {
  version: typeof SHEET_REFILE_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

const quoted = (paragraphs: readonly string[]): string => `"""\n${paragraphs.join('\n\n')}\n"""`

export function buildSheetRefilePrompt(input: BuildSheetRefilePromptInput): BuiltSheetRefilePrompt {
  const fields = input.fields.map((field) => ({
    ...field,
    value: field.value.trim() === '' ? '(empty)' : field.value
  }))
  const user = [`Sheet: ${input.name} (${input.noun})`, `Fields:\n${sheetFieldLines(fields)}`]
  if (input.removed.length > 0) user.push(`Removed from the page:\n${quoted(input.removed)}`)
  if (input.added.length > 0) user.push(`Added to the page:\n${quoted(input.added)}`)
  user.push(SHEET_REFILE_INSTRUCTION)

  return {
    version: SHEET_REFILE_PROMPT_VERSION,
    messages: [
      { role: 'system', content: SHEET_REFILE_RULES },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: REFILE_MAX_TOKENS
  }
}
