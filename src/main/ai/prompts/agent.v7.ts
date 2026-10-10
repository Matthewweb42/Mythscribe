import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS } from '@shared/agent'
import type { AiMessage } from '../providers/types'
import { AGENT_FINAL_TURN } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import type { BuildAgentPromptV3Input } from './agent.v3'
import { AGENT_LADDER_RULES, AGENT_RULES_V6, AGENT_STATUS_RULES } from './agent.v6'

/**
 * The chat agent prompt (F-5.22), version 7 (F-5.25, 2026-10-10; the author asked the chat to
 * "delete everything in my story bible" to start fresh and re-upload, and it ran Organise, which
 * may only delete empty sheets and unused tags). Version 6's rules, ladder, and status labels
 * stay; the organise paragraph gives way to two: bulk changes (a delete, clear, remove, or wipe of
 * all of a kind is one `clear` edit, never organising; scenes and chapters never in bulk; an
 * unclear noun is asked about first) and organising, now only for tidying that needs judgment.
 * The edit rules gain the `clear` edit and the audit's bulk and story-bible edits (one tag on
 * many documents, many items moved, a tag or sheet renamed, sheets recategorised, merged, made).
 * Prompt files are versioned (F-5.12); `agent.v6.ts` stays as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules (identical for every read run and every
 * write run), then the map, the open document, the history, the message, the steps so far.
 */
export const AGENT_PROMPT_V7_VERSION = 'agent.v7'

const LIST_SHEETS_V6 =
  '- list_sheets {"kind"}: sheet names; kind is character, setting, world, or "" for all.\n'

/**
 * Version 6's rules with `list_sheets` able to read one field across the sheets (F-5.25, the
 * audit's fix 6: "which characters have no age?" in one call instead of a read per sheet).
 */
export const AGENT_RULES_V7 = AGENT_RULES_V6.replace(
  LIST_SHEETS_V6,
  '- list_sheets {"kind"} or {"kind","field","empty"}: sheet names; kind is character, ' +
    'setting, world, or "" for all; with field, each sheet\'s value of it ("empty":true: only ' +
    'the sheets where it is blank).\n'
)

/**
 * Bulk changes (F-5.25): which requests are a clear, what it names, and what a run without the
 * edit list (Plan) does instead. Identical for read and write runs, so it stays in the cached
 * prefix.
 */
export const AGENT_BULK_RULES =
  'Bulk changes: a message that asks to delete, clear, remove, or wipe all of a kind ("delete ' +
  'everything in my story bible", "remove all the tags", "start fresh") is a clear, never ' +
  'organising. With the edit list below, add one {"edit":"clear"} naming only what the message ' +
  'names ("the story bible" or "start fresh": sheets, tags, and library; notes only when ' +
  'asked); the app shows every kind with a checkbox for the author to confirm, backs the ' +
  'project up first, and keeps one undo. Without the edit list, say what would go and that Ask ' +
  'or Auto mode can do it. Scenes and chapters are never cleared in bulk: delete them one at a ' +
  'time. Tagging, moving, or recategorising many at once is one edit with a list or "all", ' +
  'never one edit per item. When the noun is unclear ("notes", "the outline"), ask what is ' +
  'meant before any edit.'

/** Version 4's organise paragraph, narrowed to tidying that needs judgment (F-5.25). */
export const AGENT_ORGANISE_RULES_V7 =
  'Organising: when the message asks to tidy with judgment (organise, clean up, merge ' +
  'duplicates, streamline, sort) the tags, story-bible sheets, notes, or binder, add ' +
  '"organise":{"scope":[…],"instruction":"…"} to your answer instead of edits: scope is any of ' +
  'tags, sheets, notes, binder ([] for all); instruction is what the author asked, in a ' +
  'sentence. The app plans the changes and shows them; say so in the answer in a sentence. ' +
  'Organising never changes the manuscript text and never deletes in bulk.'

/** The `clear` edit (F-5.25), added to version 2's edit list before its last line. */
export const AGENT_CLEAR_EDIT =
  '- {"edit":"clear","sheets","tags","library","notes"}: delete whole kinds at once; sheets is ' +
  '"all" or category names (characters, places, threads…), tags is "all" or tag categories ' +
  '(character, setting, worldBuilding, tone, content, plotThread, custom), library and notes ' +
  'are true for all; leave out what stays.\n'

/**
 * The bulk and story-bible edits (F-5.25, the audit's fixes 3 and 4): one tag on many documents,
 * many items moved, a tag or a sheet renamed, sheets moved to another category, merged, or made.
 */
export const AGENT_BIBLE_EDITS =
  '- {"edit":"tag","ids","tag","add"}: one tag on or off many documents; ids is "all" (every ' +
  "scene), a folder's id (its scenes), or a list of ids.\n" +
  '- {"edit":"move","ids","in"} or {"edit":"move","from","in"}: many items, or every child of ' +
  'folder "from", to the end of "in".\n' +
  '- {"edit":"rename_tag","tag","title"} and {"edit":"rename_sheet","name","title"}\n' +
  '- {"edit":"recategorise","sheets","to"} or {"edit":"recategorise","from","to"}: sheets, or ' +
  'all of category "from", into category "to".\n' +
  '- {"edit":"merge_sheets","sheets","into"} and {"edit":"create_sheet","name","category"}\n'

const LAST_EDIT_LINE = 'Keep "answer" to a few sentences.'

/** What a write run adds to the rules: version 2's edits, `clear`, and the bulk and story-bible edits. */
export const AGENT_EDIT_RULES_V7 = AGENT_EDIT_RULES_V2.replace(
  LAST_EDIT_LINE,
  `${AGENT_CLEAR_EDIT}${AGENT_BIBLE_EDITS}${LAST_EDIT_LINE}`
)

export interface BuiltAgentPromptV7 {
  version: typeof AGENT_PROMPT_V7_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** `voice` is ignored, as in versions 2 to 6: the drafting request carries the voice block. */
export function buildAgentPromptV7(input: BuildAgentPromptV3Input): BuiltAgentPromptV7 {
  const system = [
    AGENT_RULES_V7,
    AGENT_STATUS_RULES,
    AGENT_LADDER_RULES,
    AGENT_BULK_RULES,
    AGENT_ORGANISE_RULES_V7
  ]
  if (input.access === 'write') system.push(AGENT_EDIT_RULES_V7)
  if (input.map) system.push(input.map)
  system.push(input.focus ?? 'No document is open.')

  const messages: AiMessage[] = [
    { role: 'system', content: system.join('\n\n') },
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: input.message }
  ]
  for (const step of input.steps) {
    messages.push({ role: 'assistant', content: step.call })
    messages.push({ role: 'user', content: step.result })
  }
  if (input.final) messages.push({ role: 'user', content: AGENT_FINAL_TURN })
  if (input.retry === true) messages.push({ role: 'user', content: AGENT_RETRY_TURN })

  return {
    version: AGENT_PROMPT_V7_VERSION,
    messages,
    maxTokens: input.retry === true ? AGENT_RETRY_MAX_TOKENS : AGENT_STEP_MAX_TOKENS
  }
}
