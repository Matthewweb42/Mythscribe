import { outputBudget } from '@shared/ai'
import { BUILTIN_CATEGORIES, type StoryCategory } from '@shared/categories'
import { CONTEXT_IMAGE_NAMES_MAX, CONTEXT_SHEET_NAMES_CHARS } from '@shared/contextLibrary'
import { FILING_QUOTE_MAX_WORDS, FILING_QUOTE_MIN_WORDS } from '@shared/filing'
import type { AiMessage } from '../providers/types'

/**
 * The filing prompt (F-16.9, decision 6; story memory v2 only): one chunk of a Research document
 * read into lines for the Pinned notes of the records it describes, each line with the exact words
 * it came from (`q`), which code checks against the document (`planFiling`). Text that fits no
 * record stays in the document: there is no "notes" output. Strong tier, JSON, reasoning off
 * (`NO_REASONING_PROMPTS`). v1's context library keeps sending `contextImport.v2`. Prompt files are
 * versioned (F-5.12): a change is a new file.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules with the library of categories lead (the
 * same for every chunk of every project); the user turn opens with what is stable for the whole
 * run (the project's own categories, the records by category, the image names), the document last.
 */
export const CONTEXT_IMPORT_PROMPT_V3_VERSION = 'contextImport.v3'

/** The opening sentence; the e2e's fake OpenAI recognises a filing request by it. */
export const FILING_SENTINEL =
  "You are the filing feature inside a novel-writing app, filing the author's research document " +
  "into the pinned notes of their story's records."

export const CONTEXT_IMPORT_RULES_V3 =
  `${FILING_SENTINEL} Read the document and list every character, place, and thing it ` +
  'describes, each under the category it belongs to. When one is a record listed below (by its ' +
  'name or a nickname), use that record’s name exactly and put any other names and titles the ' +
  'document gives it in "aliases". Write its facts as short lines in the author’s words, one ' +
  'fact per line, as "Label: value" when a short label fits ("Eyes: grey"); never invent, ' +
  'embellish, or infer. Every line has "q": the words of the document it comes from, copied ' +
  `exactly, ${FILING_QUOTE_MIN_WORDS} to ${FILING_QUOTE_MAX_WORDS} words from one paragraph. ` +
  'Leave out what fits no record (themes, plot outlines, rules for the book): it stays in the ' +
  'document. Categories as id (what goes in it): ' +
  `${BUILTIN_CATEGORIES.map((category) => `${category.id} (${category.hint})`).join('; ')}. ` +
  'Use world only when no other category fits. When several things share a kind no category ' +
  'fits, you may propose a new category in "categories" with a short kind, a plural name, and a ' +
  'singular, and use that kind for them. When an image file name or the text says whom or what a ' +
  'listed image shows, add it to "images". Reply with JSON only: {"records":[{"name":"Mara Vell",' +
  '"category":"character","aliases":["Mara"],"lines":[{"text":"Eyes: grey","q":"her eyes were ' +
  'grey as the river"}]}],"categories":[{"kind":"ships","name":"Ships","noun":"ship"}],' +
  '"images":[{"file":"mara.png","name":"Mara Vell"}]}. Empty lists are fine.'

/** The records of one category, as the prompt lists them: each name with its nicknames. */
export interface FilingRosterGroup {
  category: Pick<StoryCategory, 'id' | 'name'>
  records: readonly { name: string; aliases: readonly string[] }[]
}

export interface BuildContextImportPromptV3Input {
  /** The project's categories (the library's and its own); its own are listed in the user turn. */
  categories: readonly StoryCategory[]
  /** The records, category by category in picker order; empty categories may be left out. */
  roster: readonly FilingRosterGroup[]
  /** The names of the Research image pages. */
  images: readonly string[]
  /** The Research document's title. */
  title: string
  /** 1-based chunk number and count within the document. */
  part: number
  parts: number
  text: string
}

export interface BuiltContextImportPromptV3 {
  version: typeof CONTEXT_IMPORT_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The records with their nicknames, category by category, cut to `CONTEXT_SHEET_NAMES_CHARS`. */
export function rosterBlockV3(roster: readonly FilingRosterGroup[]): string {
  let budget = CONTEXT_SHEET_NAMES_CHARS
  const lines: string[] = []
  for (const group of roster) {
    const kept: string[] = []
    for (const record of group.records) {
      const entry =
        record.aliases.length === 0 ? record.name : `${record.name} (${record.aliases.join(', ')})`
      if (entry.length + 2 > budget) break
      budget -= entry.length + 2
      kept.push(entry)
    }
    if (kept.length > 0) lines.push(`${group.category.id}: ${kept.join('; ')}`)
  }
  return lines.length > 0 ? lines.join('\n') : '(none)'
}

/** The project's own categories as the user turn lists them; '' when it has none. */
function ownCategoriesBlock(categories: readonly StoryCategory[]): string {
  const own = categories.filter((category) => !category.builtIn)
  if (own.length === 0) return ''
  const lines = own.map((category) => `${category.id} (${category.hint || category.name})`)
  return `The project's own categories:\n${lines.join('\n')}\n\n`
}

export function buildContextImportPromptV3(
  input: BuildContextImportPromptV3Input
): BuiltContextImportPromptV3 {
  const images = input.images.slice(0, CONTEXT_IMAGE_NAMES_MAX)
  const heading =
    `Document "${input.title}"` +
    (input.parts > 1 ? ` (part ${input.part} of ${input.parts})` : '') +
    ':'
  return {
    version: CONTEXT_IMPORT_PROMPT_V3_VERSION,
    messages: [
      { role: 'system', content: CONTEXT_IMPORT_RULES_V3 },
      {
        role: 'user',
        content:
          ownCategoriesBlock(input.categories) +
          `Records by category:\n${rosterBlockV3(input.roster)}\n\n` +
          `Images: ${images.length > 0 ? images.join(', ') : '(none)'}\n\n` +
          `${heading}\n${input.text}`
      }
    ],
    maxTokens: outputBudget('contextImport')
  }
}
