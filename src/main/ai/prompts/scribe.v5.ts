import type { AssistantMode } from '@shared/aiSettings'
import type { ScribeAccess } from '@shared/scribe2'
import type { AiMessage } from '../providers/types'
import type { BuildScribePromptInput } from './scribe.v1'
import { scribeModeLineV3, SCRIBE_V3_MODE_RULES } from './scribe.v3'
import { buildScribePromptV4, SCRIBE_V4_RULES } from './scribe.v4'

export const SCRIBE_V5_PROMPT_VERSION = 'scribe.v5'

/**
 * Ms Scribe moves, makes and deletes folders and files (notes structure part C, 2026-10-16,
 * `structure.md` §C): v4's request with the structure tools' one-line descriptions after v4's
 * rules, and mode lines that name them. Notes changes and the manuscript's new, moved, renamed and
 * split items land at once with Undo; deletions and merges ask; Brainstorm changes nothing. The
 * rules are the same in every mode, so the cached prefix holds across a mode switch.
 */
export const SCRIBE_V5_STRUCTURE_RULES = [
  'Structure tools, done at once (she can undo each): create_folder {"title":"…","parent":"<folder>"} makes a Notes folder; move_note {"ids":["p2","Places"],"to":"<folder, or top>","position":"first|last"} moves pages and folders, several in one call; rename_note {"id":"p2","title":"…"}; delete_note {"id":"p2"} asks her first. A folder is named by title or path ("Characters › Minor"); a missing one is made.',
  'Book: create_chapter {"title":"…","after":"<chapter>","scenes":["n3","n4"]} (the scenes move into it); create_scene {"title":"…","in":"<chapter>","after":"n3"} makes an empty scene; move_scene {"ids":["n3","n4"],"to":"<chapter>","after":"n2"}; rename_scene {"id":"<scene or chapter>","title":"…"}; split_scene {"id":"n3","at":"<exact words that start the new scene>","title":"…"}; merge_scenes {"id":"n4","into":"n3"} and delete_scene {"id":"…"} ask her first. A chapter is named by title or ref; "manuscript" is the top. These never write scene text.',
  'Reorganise in as few calls as you can: one move with every id. Use them only when she asks to move, make, rename or delete; then say in the answer what you changed.'
].join('\n')

/** v4's rules, then the structure tools: the same in every mode. */
export const SCRIBE_V5_RULES = `${SCRIBE_V4_RULES}\n${SCRIBE_V5_STRUCTURE_RULES}`

/** The mode's line, last in the moment: v3's with the structure tools named. */
export const SCRIBE_V5_MODE_RULES: Record<AssistantMode | 'save', string> = {
  brainstorm:
    'Mode Brainstorm: think and plan with her; you change nothing (no note, structure or prose tools).',
  save: 'Mode Brainstorm, and she asked you to save: put what was agreed into the right note page (edit it, or create one when none fits), then name the pages. No structure tools, no propose_prose_edit.',
  write: `${SCRIBE_V3_MODE_RULES.write} Make, move, rename or delete folders, pages, chapters and scenes when she asks.`,
  vibe: `${SCRIBE_V3_MODE_RULES.vibe} Make, move, rename or delete folders, pages, chapters and scenes when she asks.`
}

/** The mode line one message gets: Brainstorm asked to save reads as its own line. */
export function scribeModeLineV5(mode: AssistantMode, access: ScribeAccess): string {
  return SCRIBE_V5_MODE_RULES[mode === 'brainstorm' && access.notes ? 'save' : mode]
}

export interface BuiltScribePromptV5 {
  version: typeof SCRIBE_V5_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/**
 * v4's request (cache order: the rules, the notes, the map, the book, the moment ending with the
 * mode's line; then the turns and steps) with v5's rules and v5's mode line.
 */
export function buildScribePromptV5(input: BuildScribePromptInput): BuiltScribePromptV5 {
  const v4 = buildScribePromptV4(input)
  const [system, ...rest] = v4.messages
  const content = system?.content ?? ''
  const oldLine = scribeModeLineV3(input.mode, input.access)
  const middle = content.slice(SCRIBE_V4_RULES.length, content.length - oldLine.length)
  return {
    version: SCRIBE_V5_PROMPT_VERSION,
    messages: [
      {
        role: 'system',
        content: `${SCRIBE_V5_RULES}${middle}${scribeModeLineV5(input.mode, input.access)}`
      },
      ...rest
    ],
    maxTokens: v4.maxTokens
  }
}
