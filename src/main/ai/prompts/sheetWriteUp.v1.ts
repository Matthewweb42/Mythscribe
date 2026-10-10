import { WRITE_UP_MAX_TOKENS } from '@shared/sheetSync'
import { WRITE_UP_WORDS, type WriteUpLength } from '@shared/storyBibleSettings'
import type { AiMessage } from '../providers/types'

/**
 * The sheet write-up prompt (F-9.18), version 1: one story-bible sheet's fields in, the same facts
 * written up as reference prose out, as JSON — the opening paragraphs, and one text per field
 * the author's style puts under a heading. Main lays the page out (`layoutWriteUp`), so the
 * headings, their wording, and their order are the author's, never the model's. Derived from the
 * author's own sheet text and never the manuscript (CLAUDE.md, AI rule 1); not manuscript prose,
 * so no voice block (decided by Claude, unconfirmed). Prompt files are versioned (F-5.12): a
 * change to the text, the caps, or the message order is a new file with its own golden test.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable rules; the user turn
 * carries the sheet.
 */
export const SHEET_WRITE_UP_PROMPT_VERSION = 'sheetWriteUp.v1'

/**
 * The rules. The opening sentence names the feature, so a test fake (and the developer tools'
 * inspector) can tell a write-up request at a glance; it must not change within this version.
 */
export const SHEET_WRITE_UP_RULES =
  'You are the sheet write-up feature inside a novel-writing app. The author keeps a ' +
  'story-bible sheet as fields; write the same facts up as a reference page they can read and ' +
  'edit. Use only what the fields say: never add, guess, or embellish a fact, and keep every ' +
  'name, number, and spelling as written. Clear, well-organised prose in the third person: ' +
  'paragraphs only, no lists, no markdown, no headings (the app adds them). Leave empty fields ' +
  'out. "intro" weaves the paragraph fields into one or two opening paragraphs; "parts" has one ' +
  'entry per heading field with text, keyed by its id, without repeating its label. Stay under ' +
  'the word target. Reply with JSON only: {"intro":"...","parts":{"id":"..."}}.'

/** The user turn's closing instruction. */
export const SHEET_WRITE_UP_INSTRUCTION = 'Write the page.'

export interface SheetPromptField {
  id: string
  label: string
  /** The value as sent (trimmed; head-cut by the caller to fit the budget). */
  value: string
}

export interface BuildSheetWriteUpPromptInput {
  name: string
  /** The category's singular ("character"). */
  noun: string
  length: WriteUpLength
  /** Every field of the sheet in page order, empty ones included (they are left out of the prompt). */
  fields: readonly (SheetPromptField & { heading: boolean })[]
}

export interface BuiltSheetWriteUpPrompt {
  version: typeof SHEET_WRITE_UP_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** `[id] Label: value`, one field per line. */
export function sheetFieldLines(fields: readonly SheetPromptField[]): string {
  return fields.map((field) => `[${field.id}] ${field.label}: ${field.value}`).join('\n')
}

export function buildSheetWriteUpPrompt(
  input: BuildSheetWriteUpPromptInput
): BuiltSheetWriteUpPrompt {
  const filled = input.fields.filter((field) => field.value.trim() !== '')
  const ids = (heading: boolean): string =>
    filled
      .filter((field) => field.heading === heading)
      .map((field) => field.id)
      .join(', ') || 'none'
  const user = [
    `Sheet: ${input.name} (${input.noun})`,
    `Word target: at most ${WRITE_UP_WORDS[input.length]}`,
    `Paragraph fields: ${ids(false)}`,
    `Heading fields: ${ids(true)}`,
    `Fields:\n${sheetFieldLines(filled)}`,
    SHEET_WRITE_UP_INSTRUCTION
  ].join('\n')

  return {
    version: SHEET_WRITE_UP_PROMPT_VERSION,
    messages: [
      { role: 'system', content: SHEET_WRITE_UP_RULES },
      { role: 'user', content: user }
    ],
    maxTokens: WRITE_UP_MAX_TOKENS[input.length]
  }
}
