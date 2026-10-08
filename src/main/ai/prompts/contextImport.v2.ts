import { outputBudget } from '@shared/ai'
import { BUILTIN_CATEGORIES, type StoryCategory } from '@shared/categories'
import {
  CONTEXT_IMAGE_NAMES_MAX,
  CONTEXT_SHEET_NAMES_CHARS,
  contextFieldsFor
} from '@shared/contextLibrary'
import type { AiMessage } from '../providers/types'

/**
 * The context library prompt (F-9.8), version 2 (F-9.11, story-bible categories): version 1's
 * reading of one chunk, with the built-in library of categories in place of the three kinds — a
 * magic system is filed as a magic system, not as a World item — and leave to propose a new
 * category, with its own fields, for a group of things no category fits. A proposed category is
 * only a proposal: the review shows it and the author accepts, renames, or declines it before
 * anything is written. Prompt files are versioned (F-5.12): a change is a new file.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules, with every library category's field ids,
 * are the same for every chunk of every project, so they lead; the user turn starts with what is
 * stable for the whole run (the project's own categories, the existing sheet names, the image
 * names), the document last. No voice block: nothing here is prose for the manuscript.
 */
export const CONTEXT_IMPORT_PROMPT_V2_VERSION = 'contextImport.v2'

const categoryLine = (category: StoryCategory): string =>
  `${category.id} (${category.hint}): ${contextFieldsFor(category).join(', ')}`

/** The one-line fields of the library, which the rules ask to keep short. */
const ONE_LINE_FIELDS = [
  ...new Set(
    BUILTIN_CATEGORIES.flatMap((category) =>
      category.fields.filter((field) => !field.multiline).map((field) => field.id)
    )
  )
]

/**
 * The rules. The opening sentence is version 1's, byte for byte: the e2e's fake OpenAI
 * recognises a context-library request by it.
 */
export const CONTEXT_IMPORT_RULES_V2 =
  'You are the context-library feature inside a novel-writing app, sorting the author’s own ' +
  'notes into their story bible. Read the document and list every person, place, and thing it ' +
  'describes under the category it belongs to. Use only what the document states, in the ' +
  'author’s words; never invent or embellish. When someone or something is one of the existing ' +
  'sheets listed (or a nickname of one), use that sheet’s name and category exactly and put the ' +
  'other names in "aliases". Categories as kind (what goes in it): field ids — ' +
  `${BUILTIN_CATEGORIES.map(categoryLine).join('; ')}. Use world only when no other category ` +
  'fits. When several things share a kind no category fits, you may propose a new category in ' +
  '"categories" with a short kind, a plural name, a singular, and up to 6 field names, and use ' +
  'that kind and those field names for them. Put a fact in a field when one fits; keep ' +
  `one-line fields (${ONE_LINE_FIELDS.join(', ')}) short. Everything else about it goes in ` +
  '"details" as short paragraphs, each starting with a topic and a colon ("History: …"). What ' +
  'fits no sheet (themes, the plot outline, rules for the book) goes in "notes" the same way. ' +
  'When an image file name or the text says whom or what a listed image shows, add it to ' +
  '"images". Reply with JSON only: {"entities":[{"kind":"character","name":"Mara Vell",' +
  '"aliases":["Mara"],"fields":{"age":"34"},"details":["History: …"]},{"kind":"ships",' +
  '"name":"The Gull","fields":{"Crew":"twelve"}}],"categories":[{"kind":"ships","name":' +
  '"Ships","noun":"ship","fields":["Crew","Home port"]}],"notes":["Theme: …"],' +
  '"images":[{"file":"mara.png","name":"Mara Vell"}]}. Empty lists are fine.'

/** The existing sheets of one category, as the prompt lists them. */
export interface ContextSheetGroup {
  category: Pick<StoryCategory, 'id' | 'name'>
  names: readonly string[]
}

export interface BuildContextImportPromptV2Input {
  /** The project's own categories (not the library's), with their field ids. */
  categories: readonly StoryCategory[]
  /** The existing sheets, category by category in picker order; empty categories may be left out. */
  sheets: readonly ContextSheetGroup[]
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

export interface BuiltContextImportPromptV2 {
  version: typeof CONTEXT_IMPORT_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The sheet names, category by category, cut to `CONTEXT_SHEET_NAMES_CHARS` in all. */
export function sheetNamesBlockV2(sheets: readonly ContextSheetGroup[]): string {
  let budget = CONTEXT_SHEET_NAMES_CHARS
  const lines: string[] = []
  for (const group of sheets) {
    const kept: string[] = []
    for (const name of group.names) {
      if (name.length + 2 > budget) break
      budget -= name.length + 2
      kept.push(name)
    }
    if (kept.length > 0) lines.push(`${group.category.id}: ${kept.join(', ')}`)
  }
  return lines.length > 0 ? lines.join('\n') : '(none)'
}

/** The project's own categories as the user turn lists them; '' when it has none. */
function projectCategoriesBlock(categories: readonly StoryCategory[]): string {
  const own = categories.filter((category) => !category.builtIn)
  if (own.length === 0) return ''
  const lines = own.map(
    (category) =>
      `${category.id} (${category.hint || category.name}): ${contextFieldsFor(category).join(', ')}`
  )
  return `The project's own categories:\n${lines.join('\n')}\n\n`
}

export function buildContextImportPromptV2(
  input: BuildContextImportPromptV2Input
): BuiltContextImportPromptV2 {
  const images = input.images.slice(0, CONTEXT_IMAGE_NAMES_MAX)
  const heading =
    `Document "${input.fileName}"` +
    (input.parts > 1 ? ` (part ${input.part} of ${input.parts})` : '') +
    (input.changedOnly ? ', only the passages new since it was last sorted' : '') +
    ':'
  return {
    version: CONTEXT_IMPORT_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: CONTEXT_IMPORT_RULES_V2 },
      {
        role: 'user',
        content:
          projectCategoriesBlock(input.categories) +
          `Existing sheets by kind:\n${sheetNamesBlockV2(input.sheets)}\n\n` +
          `Images: ${images.length > 0 ? images.join(', ') : '(none)'}\n\n` +
          `${heading}\n${input.text}`
      }
    ],
    maxTokens: outputBudget('contextImport')
  }
}
