import { outputBudget } from '@shared/ai'
import {
  DEVELOPMENTAL_CATEGORIES,
  EDIT_PASS_MAX_ITEMS,
  EDIT_PASS_NOTE_MAX,
  EDIT_PASS_QUOTE_MAX,
  type EditPassType
} from '@shared/editPass'
import type { AiMessage } from '../providers/types'

/**
 * The edit-pass prompt (F-14.15), version 1: one chunk of one scene, edited the way a
 * professional editor edits it for the chosen pass type. One versioned file serves every type:
 * the shared rules and the JSON contract are the same, only the task paragraph differs, and the
 * golden test pins each type's text. A change to any of it is a new file (`editPass.v2.ts`).
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules,
 * the pass's task, the voice block (the passes that write prose), and the keep list (copy edit
 * and proofread) — so the provider's prefix cache applies across every chunk of a pass; the user
 * turn carries what changes: the continuity references, the author's instruction, the scene's
 * title, and the text.
 */
export const EDIT_PASS_PROMPT_VERSION = 'editPass.v1'

/**
 * The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI recognises an
 * edit-pass request by it, so it must not change within this version.
 */
export const EDIT_PASS_SENTINEL = 'You are the edit-pass feature inside a novel-writing app.'

const CHANGE_RULES =
  `${EDIT_PASS_SENTINEL} You edit one piece of a manuscript scene and return tracked changes the ` +
  'author reviews one by one. Each quote is copied word for word from the text, lies inside one ' +
  'paragraph, and occurs only once in the text: the shortest clause or sentence that changes, ' +
  `at most ${EDIT_PASS_QUOTE_MAX} characters. The replacement is that passage as edited, or an ` +
  'empty string to cut it; why is one short sentence. No two quotes overlap. Leave what already ' +
  `works alone. At most ${EDIT_PASS_MAX_ITEMS} changes, in text order. Reply with JSON only: ` +
  '{"changes":[{"quote":"...","replacement":"...","why":"..."}]}; with nothing to change, ' +
  '{"changes":[]}.'

const NOTE_RULES =
  `${EDIT_PASS_SENTINEL} You read one piece of a manuscript scene as a professional ` +
  'developmental editor and write notes the author reads in a report; you never rewrite the ' +
  'text. Each note cites the passage it is about: a quote copied word for word from the text, ' +
  `inside one paragraph, at most ${EDIT_PASS_QUOTE_MAX} characters; the note says what works or ` +
  `does not and what to try, at most ${EDIT_PASS_NOTE_MAX} characters. At most 8 notes, the ` +
  'most important first, no line-level fixes and no uncited praise. Reply with JSON only: ' +
  '{"notes":[{"category":"...","quote":"...","note":"..."}]}, category one of ' +
  `${DEVELOPMENTAL_CATEGORIES.join(', ')}.`

/** The task paragraph per pass type. */
export const EDIT_PASS_TASKS: Record<EditPassType, string> = {
  developmental:
    'Developmental edit: structure, pacing, character arcs and motivation, stakes, point of view, ' +
    'and how the scene opens and ends.',
  line:
    'Line edit: improve clarity, rhythm, flow, and word choice sentence by sentence and tighten ' +
    "slack phrasing, in the author's voice and by the author's rules. Never change plot, facts, " +
    'point of view, or tense.',
  copy:
    'Copy edit: fix grammar, tense slips, inconsistent spelling and capitals of names and terms ' +
    '(the keep list is the style sheet), unintended repetition, and wrong or weak word choice. ' +
    'Do not restyle a sentence that is correct.',
  proofread:
    'Proofread: correct only typos, spelling, punctuation, and doubled or missing words. Never ' +
    'change style, word choice, or rhythm; fragments and dialect are deliberate.',
  continuity:
    "Continuity pass: find statements that contradict the numbered references from the author's " +
    'story bible and change the fewest words that make the passage agree; why names the ' +
    'reference number. Anything the references do not cover is not a contradiction.',
  custom:
    "Custom pass: apply the author's instruction to the text and change only what it calls for, " +
    "in the author's voice and by the author's rules."
}

export interface BuildEditPassPromptInput {
  type: EditPassType
  /** The piece of the scene to edit (a chunk cut at paragraph breaks). */
  text: string
  /** The scene's title, and which piece this is when the scene was split. */
  title: string
  part: { index: number; count: number }
  /** The voice block (`voiceBlock`) for the passes that write prose; null otherwise or when empty. */
  voice: string | null
  /** Names and dictionary words that are correct as written (copy edit, proofread); empty otherwise. */
  keepWords: readonly string[]
  /** The continuity references as numbered lines; empty for the other passes. */
  references: readonly string[]
  /** The author's instruction for a custom pass; null otherwise. */
  instruction: string | null
}

export interface BuiltEditPassPrompt {
  version: typeof EDIT_PASS_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildEditPassPrompt(input: BuildEditPassPromptInput): BuiltEditPassPrompt {
  const rules = input.type === 'developmental' ? NOTE_RULES : CHANGE_RULES
  let system = `${rules} ${EDIT_PASS_TASKS[input.type]}`
  if (input.voice) system += ` ${input.voice}`
  if (input.keepWords.length > 0) system += `\n\nKeep as written: ${input.keepWords.join(', ')}.`

  const user: string[] = []
  if (input.references.length > 0) user.push(`References:\n${input.references.join('\n')}`)
  if (input.instruction) {
    user.push(`The author's instruction:\n"""\n${input.instruction}\n"""`)
  }
  const part = input.part.count > 1 ? ` (part ${input.part.index + 1} of ${input.part.count})` : ''
  user.push(`Scene: ${input.title}${part}\nText:\n"""\n${input.text}\n"""`)
  user.push(input.type === 'developmental' ? 'Write your notes.' : 'Edit the text.')

  return {
    version: EDIT_PASS_PROMPT_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('editPass')
  }
}
