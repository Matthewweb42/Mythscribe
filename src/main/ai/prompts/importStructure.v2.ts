import { outputBudget } from '@shared/ai'
import { shortenParagraph, STRUCTURE_TITLE_MAX } from '@shared/importStructure'
import type { AiMessage } from '../providers/types'
import type { StructurePromptParagraph } from './importStructure.v1'

/**
 * The import structure prompt (F-12.3), version 2 (F-16.15, story memory v2 only): version 1
 * without the tag bank and the tag output, since a v2 project has no tags (names in the prose
 * become records through the name scan instead). A v1 project keeps sending version 1 byte for
 * byte. The paragraphs are numbered and marked exactly as in version 1, so the suggestions of
 * every chunk merge the same way; the reply has no `tags`.
 */
export const IMPORT_STRUCTURE_PROMPT_V2_VERSION = 'importStructure.v2'

/**
 * The rules. The opening sentence is version 1's, which the e2e's fake OpenAI recognises an
 * import-structure request by.
 */
export const IMPORT_STRUCTURE_V2_RULES =
  'You are the structure-detection feature inside a novel-writing app, splitting an imported ' +
  'manuscript into chapters and scenes. The paragraphs below are numbered in reading order; a ' +
  'line above a paragraph marks a boundary the draft already has. Propose a break only where ' +
  'you are confident one belongs (a jump in time or place, a change of viewpoint, a new ' +
  'chapter opening), never where that boundary already exists, and never at the first ' +
  'paragraph. Give every scene in the chunk a title of at most ' +
  `${STRUCTURE_TITLE_MAX} characters, or null when nothing fits. Reply with JSON only: ` +
  '{"breaks":[{"before":12,"kind":"scene","reason":"why, in a few words"}],' +
  '"scenes":[{"start":0,"title":"A title"}]}. "before" and "start" are the numbers in ' +
  'brackets; "kind" is "chapter" or "scene".'

export interface BuildImportStructureV2PromptInput {
  /** The chunk's paragraphs in reading order; long ones are shortened here. */
  paragraphs: readonly StructurePromptParagraph[]
}

export interface BuiltImportStructureV2Prompt {
  version: typeof IMPORT_STRUCTURE_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildImportStructurePromptV2({
  paragraphs
}: BuildImportStructureV2PromptInput): BuiltImportStructureV2Prompt {
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.chapterStart) {
      lines.push(`— chapter starts here: "${paragraph.chapterTitle}" —`)
    }
    if (paragraph.sceneStart) lines.push(`— scene starts here: "${paragraph.sceneTitle}" —`)
    lines.push(`[${paragraph.index}] ${shortenParagraph(paragraph.text)}`)
  }
  return {
    version: IMPORT_STRUCTURE_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: IMPORT_STRUCTURE_V2_RULES },
      { role: 'user', content: `Paragraphs:\n${lines.join('\n')}` }
    ],
    maxTokens: outputBudget('importStructure')
  }
}
