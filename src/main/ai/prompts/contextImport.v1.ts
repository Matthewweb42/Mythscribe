import { outputBudget } from '@shared/ai'
import {
  CONTEXT_IMAGE_NAMES_MAX,
  CONTEXT_SHEET_NAMES_CHARS,
  contextFieldsFor
} from '@shared/contextLibrary'
import { ENTITY_KIND_LABEL, ENTITY_KINDS, type EntityKind } from '@shared/entities'
import type { AiMessage } from '../providers/types'

/**
 * The context library prompt (F-9.8), version 1: one chunk of a document the author uploaded
 * (worldbuilding notes, character sheets, a plot outline) read back as the people, places, and
 * things it describes — each with the sheet fields it states and the rest as short labelled
 * paragraphs — plus what fits no sheet, and which uploaded image shows whom, as JSON on the
 * strong tier. Prompt files are versioned (F-5.12): a change is a new file, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules, with every kind's field ids, are the
 * same for every chunk of every upload, so they lead; inside the user turn the existing sheet
 * names and the image names come first (stable for the whole run), the document last. No voice
 * block: nothing here is prose for the manuscript.
 */
export const CONTEXT_IMPORT_PROMPT_VERSION = 'contextImport.v1'

const fieldLine = (kind: EntityKind): string => `${kind}: ${contextFieldsFor(kind).join(', ')}`

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a context-library request by it, so it must not change within this version.
 */
export const CONTEXT_IMPORT_RULES =
  'You are the context-library feature inside a novel-writing app, sorting the author’s own ' +
  'notes into their story bible. Read the document and list every character (people and ' +
  'beings), setting (places), and world item (cultures, magic, history, organisations, ' +
  'objects, rules of the world) it describes. Use only what the document states, in the ' +
  'author’s words; never invent or embellish. When someone or something is one of the existing ' +
  'sheets listed (or a nickname of one), use that sheet’s name exactly and put the other names ' +
  'in "aliases". Put a fact in a field when one fits, using these field ids per kind: ' +
  `${ENTITY_KINDS.map(fieldLine).join('; ')}. Keep one-line fields (age, born, gender, type, ` +
  'category) short. Everything else about it goes in "details" as short paragraphs, each ' +
  'starting with a topic and a colon ("History: …"). What fits no sheet (themes, the plot ' +
  'outline, rules for the book) goes in "notes" the same way. When an image file name or the ' +
  'text says whom or what a listed image shows, add it to "images". Reply with JSON only: ' +
  '{"entities":[{"kind":"character","name":"Mara Vell","aliases":["Mara"],' +
  '"fields":{"age":"34"},"details":["History: …"]}],"notes":["Theme: …"],' +
  '"images":[{"file":"mara.png","name":"Mara Vell"}]}. Empty lists are fine.'

/** The existing sheets by kind, as the prompt lists them. */
export type ContextSheetNames = Record<EntityKind, readonly string[]>

export interface BuildContextImportPromptInput {
  sheets: ContextSheetNames
  /** The file names of the images in this upload. */
  images: readonly string[]
  fileName: string
  /** 1-based chunk number and count within the file. */
  part: number
  parts: number
  /** True for an updated file: only its new or changed passages are sent. */
  changedOnly: boolean
  text: string
}

export interface BuiltContextImportPrompt {
  version: typeof CONTEXT_IMPORT_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The sheet names, kind by kind, cut to `CONTEXT_SHEET_NAMES_CHARS` in all (later names dropped). */
export function sheetNamesBlock(sheets: ContextSheetNames): string {
  let budget = CONTEXT_SHEET_NAMES_CHARS
  const lines: string[] = []
  for (const kind of ENTITY_KINDS) {
    const kept: string[] = []
    for (const name of sheets[kind]) {
      if (name.length + 2 > budget) break
      budget -= name.length + 2
      kept.push(name)
    }
    lines.push(`${ENTITY_KIND_LABEL[kind]}: ${kept.length > 0 ? kept.join(', ') : '(none)'}`)
  }
  return lines.join('\n')
}

export function buildContextImportPrompt(
  input: BuildContextImportPromptInput
): BuiltContextImportPrompt {
  const images = input.images.slice(0, CONTEXT_IMAGE_NAMES_MAX)
  const heading =
    `Document "${input.fileName}"` +
    (input.parts > 1 ? ` (part ${input.part} of ${input.parts})` : '') +
    (input.changedOnly ? ', only the passages new since it was last sorted' : '') +
    ':'
  return {
    version: CONTEXT_IMPORT_PROMPT_VERSION,
    messages: [
      { role: 'system', content: CONTEXT_IMPORT_RULES },
      {
        role: 'user',
        content:
          `Existing sheets:\n${sheetNamesBlock(input.sheets)}\n\n` +
          `Images: ${images.length > 0 ? images.join(', ') : '(none)'}\n\n` +
          `${heading}\n${input.text}`
      }
    ],
    maxTokens: outputBudget('contextImport')
  }
}
