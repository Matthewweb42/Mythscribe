import { outputBudget } from '@shared/ai'
import { shortenParagraph, STRUCTURE_TAGS_MAX, STRUCTURE_TITLE_MAX } from '@shared/importStructure'
import type { AiMessage } from '../providers/types'

/**
 * The import structure prompt (F-12.3), version 1: one chunk of an imported manuscript read
 * back as the chapter and scene boundaries the model is confident of, a title for every scene
 * in the chunk, and tag candidates from the author's bank, answered as JSON on the fast tier.
 * Prompt files are versioned (F-5.12): a change to the text, the caps, or the message order is
 * a new file (`importStructure.v2.ts`) with its own golden test, never an edit here, so every
 * ledger row's `promptVersion` stays true.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules are identical for every chunk of every
 * import, so they lead as the stable prefix for provider-side caching; inside the user turn the
 * bank names come first (stable for the whole pass) and the chunk's paragraphs last. Paragraphs
 * carry their global index, so the suggestions of every chunk merge without renumbering, and the
 * boundaries the draft already has are marked, so the model titles those scenes instead of
 * proposing them again. No voice block: this is structure, not prose.
 */
export const IMPORT_STRUCTURE_PROMPT_VERSION = 'importStructure.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises an import-structure request by it, so it must not change within this version.
 */
export const IMPORT_STRUCTURE_RULES =
  'You are the structure-detection feature inside a novel-writing app, splitting an imported ' +
  'manuscript into chapters and scenes. The paragraphs below are numbered in reading order; a ' +
  'line above a paragraph marks a boundary the draft already has. Propose a break only where ' +
  'you are confident one belongs (a jump in time or place, a change of viewpoint, a new ' +
  'chapter opening), never where that boundary already exists, and never at the first ' +
  'paragraph. Give every scene in the chunk a title of at most ' +
  `${STRUCTURE_TITLE_MAX} characters, or null when nothing fits, and up to ` +
  `${STRUCTURE_TAGS_MAX} tags taken only from the tag bank; never invent a tag name. Reply ` +
  'with JSON only: {"breaks":[{"before":12,"kind":"scene","reason":"why, in a few words"}],' +
  '"scenes":[{"start":0,"title":"A title","tags":["name"]}]}. "before" and "start" are the ' +
  'numbers in brackets; "kind" is "chapter" or "scene".'

/** One paragraph of the chunk as the prompt needs it; `FlatParagraph` (F-12.3) satisfies it. */
export interface StructurePromptParagraph {
  /** The index over the whole flattened draft, which is what the answer refers to. */
  index: number
  text: string
  sceneStart: boolean
  chapterStart: boolean
  sceneTitle: string
  chapterTitle: string
}

export interface BuildImportStructurePromptInput {
  /** The chunk's paragraphs in reading order; long ones are shortened here. */
  paragraphs: readonly StructurePromptParagraph[]
  /** Every name in the bank, in `tag:list` order. */
  tagNames: readonly string[]
}

export interface BuiltImportStructurePrompt {
  version: typeof IMPORT_STRUCTURE_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildImportStructurePrompt({
  paragraphs,
  tagNames
}: BuildImportStructurePromptInput): BuiltImportStructurePrompt {
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.chapterStart) {
      lines.push(`— chapter starts here: "${paragraph.chapterTitle}" —`)
    }
    if (paragraph.sceneStart) lines.push(`— scene starts here: "${paragraph.sceneTitle}" —`)
    lines.push(`[${paragraph.index}] ${shortenParagraph(paragraph.text)}`)
  }
  // An empty bank is normal (a fresh project has no tags): the model is told so rather than
  // being handed a dangling label it might fill in itself.
  const bank = tagNames.length > 0 ? tagNames.join(', ') : '(none)'
  return {
    version: IMPORT_STRUCTURE_PROMPT_VERSION,
    messages: [
      { role: 'system', content: IMPORT_STRUCTURE_RULES },
      { role: 'user', content: `Tag bank: ${bank}\n\nParagraphs:\n${lines.join('\n')}` }
    ],
    maxTokens: outputBudget('importStructure')
  }
}
