import { outputBudget } from '@shared/ai'
import type { AiMessage } from '../providers/types'

/**
 * The To do list's whole-book check (F-9.16), version 1: the scene cards in reading order, the
 * open threads, and a digest of the story bible (names and which fields are blank, never their
 * values), against what is already listed or settled; the model flags the gaps only judgement can
 * see and offers options the author may choose. It runs only when the author clicks Check the
 * whole book (the author's call, 2026-10-09). Prompt files are versioned (F-5.12): a change to the
 * text, the caps, or the message order is a new file with its own golden test.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules alone in the system turn; the book (sheet
 * digest, threads, scene lines) in the first user turn; what is already listed or settled, which
 * moves with every Done and Dismiss, and the task in the last.
 */
export const TODO_PROMPT_VERSION = 'todo.v1'

/** The rules; the opening sentence is the one the e2e's fake provider keys on. */
export const TODO_RULES =
  'You are the To do check inside a novel-writing app. From the scene cards, threads, and sheet ' +
  'digest, list what the book leaves unexplained that only judgement can see: a timeline gap ' +
  '(time passes or the order is unclear), a rule a system follows that is implied but never ' +
  'stated, a motivation the story leans on but never states, a coined term nothing explains, a ' +
  'promise or question no thread holds. Flag only gaps the cards and sheets show. Never fill ' +
  'one. Suggestions are options the author may choose, consistent with what is stated, never ' +
  'facts. Do not repeat blank-field gaps the app already lists, or anything under Already ' +
  'listed or Settled. Reply with JSON only: {"items":[{"type":"timeline|rule|motivation|term|' +
  'question","about":"the name or term","scene":"S3","why":"one sentence","suggestions":["up ' +
  'to 3 short options"]}],"resolved":["A1"]}; at most 8 items; "resolved" names Already listed ' +
  'ids the cards now answer; with nothing to flag, {"items":[],"resolved":[]}.'

export interface BuildTodoPromptInput {
  /** One line per record the text names: `Name (Category): blank goals, costs`. */
  digest: readonly string[]
  /** One line per open thread: `Name: open question`. */
  threads: readonly string[]
  /** One line per written scene of this window: `S12 "Title" · when · POV · what changed`. */
  scenes: readonly string[]
  /** What is open now; the AI's own items carry an id (`A1 term: Hollowing`). */
  listed: readonly string[]
  /** The subjects the author marked done or dismissed: never listed again. */
  settled: readonly string[]
}

export interface BuiltTodoPrompt {
  version: typeof TODO_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

const section = (title: string, lines: readonly string[]): string =>
  `${title}:\n${lines.length === 0 ? '(none)' : lines.join('\n')}`

export function buildTodoPrompt(input: BuildTodoPromptInput): BuiltTodoPrompt {
  const book = [
    section('Sheets', input.digest),
    section('Open threads', input.threads),
    section('Scenes', input.scenes)
  ].join('\n\n')
  const task = [
    section('Already listed', input.listed),
    section('Settled', input.settled),
    'List the gaps.'
  ].join('\n\n')
  return {
    version: TODO_PROMPT_VERSION,
    messages: [
      { role: 'system', content: TODO_RULES },
      { role: 'user', content: book },
      { role: 'user', content: task }
    ],
    maxTokens: outputBudget('todo')
  }
}
