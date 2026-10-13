import { estimateTokens } from '@shared/ai'
import {
  AGENT_MAX_EDITS,
  AGENT_RETRY_MAX_TOKENS,
  AGENT_WORDS_MAX,
  AGENT_WORDS_MIN,
  type AgentAccess
} from '@shared/agent'
import {
  evidenceTag,
  SCRIBE_REASONING,
  SCRIBE_ROSTER_TOKENS,
  SCRIBE_SCENE_MAX_TOKENS,
  scribeMaxTokens,
  type EvidenceLabel,
  type ScribeReasoning,
  type ScribeTurnKind
} from '@shared/scribe'
import type { HistoryTurn } from '@shared/scribeAnswer'
import type { AiMessage } from '../providers/types'
import { AGENT_RETRY_TURN } from './agent.v2'

/**
 * Ms Scribe's answer prompt (F-16.25, F-16.26; plan P3 §2.2, design §2.6), version 9 of the chat
 * agent, story memory v2 only. One strong-tier JSON call answers from the evidence: no tools, no
 * lookups. The model reads the whole open scene (E0) and labelled evidence (E1…, and W1… for a
 * chapter it asked for once), and cites `[E7 "exact words"]` after every sentence that names a
 * person, place, thing or event; code checks every quote against the item as it was sent. When the
 * evidence cannot answer and one chapter or scene would, it asks for it once (`{"need":…}`, the
 * Self-Route). A write run (Ask, Auto) carries the edit list, with `pin` for a line the author
 * asked to put on a record's sheet (decision 3 as she changed it); a read run (Plan) never does.
 * Prompt files are versioned (F-5.12): `agent.v8.ts` stays for v1 projects as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the rules, the edit list (write
 * runs) and the roster (names and nicknames only), identical for every question of a
 * conversation until the records change, so the provider's prompt cache holds; then the earlier
 * turns, each labelled not a source; then one user turn: the voice block (edit and draft turns),
 * E0, the evidence, a widened chapter, the Searched line, and the question.
 */
export const AGENT_PROMPT_V9_VERSION = 'agent.v9'

/** The opening sentence; the e2e's fake provider keys on it. */
export const AGENT_V9_SENTINEL =
  "You are the story assistant inside a novel-writing app, answering the book's author from the evidence below."

/** The rules of every run (read and write); the golden holds them under 750 tokens. */
export const AGENT_V9_RULES =
  `${AGENT_V9_SENTINEL}\n` +
  'Reply with one JSON object: {"answer":"…","found":true,"edits":[]}. Or, once, when the ' +
  'evidence cannot answer and one chapter or scene would: {"need":"chapter 9"} (a chapter number ' +
  'or title, a scene like 9.3, or a range like 9.1-9.4).\n' +
  'Answer in the first sentence; keep the answer to a few sentences.\n' +
  'Evidence: E0 is the open scene as it reads now, E1… are labelled passages, W1… the chapter you ' +
  'asked for. Only evidence is a source; earlier turns are not.\n' +
  'Cite: after every sentence that names a person, place, thing or event, write the evidence it ' +
  'rests on as [E7 "exact words from E7"] (3 to 25 words, copied exactly). Never cite a map. ' +
  'Advice, opinion and questions back to the author need no citation.\n' +
  'Labels say what a passage is: only "happened" text has happened by now; "later in the book" ' +
  'happens after now; your notes, source documents and "filed from" lines are canon about who and ' +
  'what things are but never make an event happen; "planned" text and idea scenes have not ' +
  'happened; "not canon" is never true; "your idea" is the author\'s idea, not in the book: say ' +
  'so ("your idea, not in the book"); "computed from your book" is worked out from the text.\n' +
  'For first, last, ever, never, how many and knows questions, say what you searched, using the ' +
  'Searched line ("The earliest I found, searching every scene up to 14.2 for distrust and lies, ' +
  'is 7.4"). Never say someone does not know something; say "I found no scene where … ' +
  '(searched …)".\n' +
  'If the evidence does not answer, set "found":false and say so plainly; never fill a gap with ' +
  'your own idea.\n' +
  "Sheet lines: when the author asks to put something on a record's sheet (\"add this to Mara's " +
  'sheet", "pin that on the Bell"), the edit is {"edit":"pin","name":"Mara","text":"…",' +
  '"place":"pinned"}; "place":"ideas" when she says idea, maybe or brainstorm, or asks to save ' +
  'an idea; "place":"ask" when she asks to save something and you cannot tell whether it is ' +
  'canon or an idea. Only what she asked to save, in her words; never facts you read in the book ' +
  '(the app reads those itself). Without the edit list, say what you would add and that Ask or ' +
  'Auto mode can do it.'

/** The edit list of a write run (Ask, Auto); agent.v2's brief sentence is kept word for word. */
export const AGENT_V9_EDIT_TOOLS =
  `Edits: only when the message asks for a change or clearly invites one, add "edits" (at most ` +
  `${AGENT_MAX_EDITS}); the author approves each, or it is applied with an undo. "id", "in" and ` +
  '"into" are ids as the evidence shows them (id n5); "find", "after" and "at" are exact text ' +
  'copied from the scene. Never write manuscript prose yourself: for new or rewritten prose give ' +
  'a "brief" (what to write, in a sentence or two: who, what happens, the beat) and the app ' +
  "drafts it in the author's voice.\n" +
  '- {"edit":"insert","id","after","brief","words"}: new prose after the paragraph holding ' +
  `"after" ("" for the caret); words ${AGENT_WORDS_MIN}-${AGENT_WORDS_MAX}.\n` +
  '- {"edit":"text","id","find","brief"}: rewrite one passage; "replace":"" cuts it.\n' +
  '- {"edit":"synopsis","id","text"}; {"edit":"notes","id","text"}: points added, one per line ' +
  '("" clears them).\n' +
  '- {"edit":"create","level":"scene" or "chapter","in","after","title"}; ' +
  '{"edit":"rename","id","title"}\n' +
  '- {"edit":"move","id","in","after"} or {"edit":"move","ids","in"}; "after":"" for first.\n' +
  '- {"edit":"split","id","at","title"}; {"edit":"merge","id","into"}; {"edit":"delete","id"}: ' +
  'a scene or folder.\n' +
  '- {"edit":"undo"}: undo the last turn.\n' +
  '- {"edit":"pin","name","text","place"}: a line on a record\'s sheet, as above.'

/** What each earlier turn of the conversation is labelled with (P3-D12). */
export const AGENT_V9_HISTORY_LABEL = '[earlier turn, not a source]'

/** The roster's heading in the system turn. */
export const AGENT_V9_ROSTER_HEADING = 'Records (names and nicknames):'

/** The heading of the labelled evidence. */
export const AGENT_V9_EVIDENCE_HEADING = 'Evidence:'

/** The heading of a Self-Route widening (P3-D15): the model may not ask again. */
export const AGENT_V9_WIDENED_HEADING = 'The chapter you asked for (do not ask again)'

/** What the user turn says in E0's place when no scene is open. */
export const AGENT_V9_NO_SCENE = 'E0: no scene is open.'

/** A record as the roster lists it: its name and nicknames (NAMED_KINDS only, chosen by the caller). */
export interface ScribeRosterRecord {
  id: string
  name: string
  nicknames: readonly string[]
  /** Creation order key: the roster lists records in it, so the prefix stays stable. */
  created: string
}

/** One roster line: `Mara Vell (Mara; Mars)`. */
export function scribeRosterLine(record: Pick<ScribeRosterRecord, 'name' | 'nicknames'>): string {
  const others = record.nicknames.filter((nickname) => nickname !== record.name)
  return others.length === 0 ? record.name : `${record.name} (${others.join('; ')})`
}

/**
 * The roster within `budget` tokens (`SCRIBE_ROSTER_TOKENS`), one line per record in creation
 * order; past the cap the least-named records are left out (the newest first among equals), as
 * the reader's roster does.
 */
export function scribeRoster(
  records: readonly ScribeRosterRecord[],
  named: ReadonlyMap<string, number>,
  budget: number = SCRIBE_ROSTER_TOKENS
): string[] {
  const ordered = [...records].sort(
    (a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id)
  )
  const kept = new Set(ordered.map((record) => record.id))
  const lines = (): string[] =>
    ordered.filter((record) => kept.has(record.id)).map(scribeRosterLine)
  const dropOrder = [...ordered].sort(
    (a, b) => (named.get(a.id) ?? 0) - (named.get(b.id) ?? 0) || b.created.localeCompare(a.created)
  )
  for (const record of dropOrder) {
    if (estimateTokens(lines().join('\n')) <= budget) break
    kept.delete(record.id)
  }
  return lines()
}

/** The open scene as E0 is built from it (`step0.ts`'s `SceneE0`). */
export interface ScribeSceneInput {
  ref: string
  label: EvidenceLabel
  title: string
  paragraphs: readonly string[]
  caretPara: number | null
  selection: string | null
  /** A write run's ids: the scene's own (`n5`) and its parent's (`n4`), so edits can name them. */
  id?: string
  parentId?: string
}

/** E0 as sent: its text and the paragraphs shown (all of them, unless the scene was too long). */
export interface RenderedScene {
  text: string
  /** The paragraph numbers sent, in order: the quote check reads only these. */
  shown: number[]
  /**
   * Each paragraph as sent, by number: its whole text, or, for one paragraph alone over the cap,
   * its opening and its end (`parts`), which the quote check reads one at a time.
   */
  sent: { para: number; parts: string[] }[]
}

/** "¶3–9", "¶4". */
const paraRange = (from: number, to: number): string =>
  from === to ? `¶${from}` : `¶${from}–${to}`

/** What stands between a shortened paragraph's opening and its end. */
export const SCENE_CUT_MARK = '[…]'

/**
 * A paragraph cut to about `tokens` tokens: its opening and its end, each at a word, around the
 * mark; the parts as the quote check reads them.
 */
function shortened(text: string, tokens: number): string[] {
  const half = Math.max(1, Math.floor((tokens * 4) / 2))
  const headCut = text.slice(0, half)
  const headAt = headCut.lastIndexOf(' ')
  const head = (headAt > half / 2 ? headCut.slice(0, headAt) : headCut).trimEnd()
  const tailCut = text.slice(-half)
  const tailAt = tailCut.indexOf(' ')
  const tail = (tailAt >= 0 && tailAt < half / 2 ? tailCut.slice(tailAt + 1) : tailCut).trimStart()
  return [head, tail]
}

/**
 * E0, the whole open scene (P3-D10): its tag, its paragraphs numbered from ¶0, then where the
 * caret is and the selection's opening. Over `maxTokens` (12,000), the paragraphs around the
 * caret (the end, without one) that fit, and a line naming the ones left out; a paragraph over
 * the cap alone (imported text with no breaks) is sent as its opening and its end, and the line
 * says it was shortened.
 */
export function renderScribeScene(
  scene: ScribeSceneInput,
  maxTokens: number = SCRIBE_SCENE_MAX_TOKENS
): RenderedScene {
  const ids =
    scene.id === undefined
      ? ''
      : `, id ${scene.id}${scene.parentId === undefined ? '' : ` in ${scene.parentId}`}`
  const head = `E0 [${evidenceTag(scene.label, `the open scene ${scene.ref}`.trim())}${ids}] ${scene.title}`
  const lines = scene.paragraphs.map((text, i) => `¶${i} ${text}`)
  const total = lines.length
  let shown = lines.map((_, i) => i)
  let cut: number | null = null
  if (estimateTokens(lines.join('\n')) > maxTokens && total > 0) {
    const centre = Math.min(Math.max(scene.caretPara ?? total - 1, 0), total - 1)
    let from = centre
    let to = centre
    let used = estimateTokens(lines[centre] ?? '')
    if (used > maxTokens) cut = centre
    for (let step = 0; cut === null && (from > 0 || to < total - 1); step++) {
      const before = step % 2 === 0
      const next = before ? from - 1 : to + 1
      if (next < 0 || next >= total) continue
      const cost = estimateTokens(lines[next] ?? '')
      if (used + cost > maxTokens) break
      used += cost
      if (before) from = next
      else to = next
    }
    shown = shown.filter((i) => i >= from && i <= to)
  }
  const sent = shown.map((para) => ({
    para,
    parts:
      para === cut
        ? shortened(scene.paragraphs[para] ?? '', maxTokens - 20)
        : [scene.paragraphs[para] ?? '']
  }))
  const first = shown[0] ?? 0
  const last = shown.at(-1) ?? -1
  const left: string[] = []
  if (first > 0) left.push(paraRange(0, first - 1))
  if (last < total - 1) left.push(paraRange(last + 1, total - 1))
  const notes: string[] = []
  if (left.length > 0) notes.push(`(${left.join(' and ')} not shown)`)
  if (cut !== null) notes.push(`(¶${cut} shortened: its middle not shown)`)
  if (scene.caretPara !== null && scene.caretPara < total) {
    notes.push(`The author's caret is in ¶${scene.caretPara}.`)
  }
  if (scene.selection !== null && scene.selection.trim() !== '') {
    notes.push(`Selected: “${scene.selection.trim()}”`)
  }
  const body = sent.map(({ para, parts }) => `¶${para} ${parts.join(` ${SCENE_CUT_MARK} `)}`)
  return { text: [head, ...body, ...notes].join('\n'), shown, sent }
}

export interface BuildAgentPromptV9Input {
  access: AgentAccess
  turn: ScribeTurnKind
  /** `scribeRoster`'s lines; empty for none. */
  roster: readonly string[]
  /** The earlier turns (`scribeHistory`), oldest first. */
  history: readonly HistoryTurn[]
  /** The voice block and author rules: edit and draft turns only; null otherwise. */
  voice: string | null
  /** E0 (`renderScribeScene`), or null with no scene open. */
  scene: string | null
  /** The labelled evidence as rendered (`renderEvidence`); empty for none. */
  evidence: string
  /** A Self-Route widening: what was asked for and its rendered `W` items; null otherwise. */
  widened: { what: string; text: string } | null
  /** What code searched (`scopeLine`), for first/last/ever and knows questions; null otherwise. */
  searched: string | null
  question: string
  /** True for the one retry of a reply that was cut off or unreadable. */
  retry?: boolean
}

export interface BuiltAgentPromptV9 {
  version: typeof AGENT_PROMPT_V9_VERSION
  messages: AiMessage[]
  maxTokens: number
  /** The request's own reasoning (P3-D11): off for answer turns, low for edit turns. */
  reasoning: ScribeReasoning
}

/** The system turn: rules, the edit list on a write run, the roster. Identical across a conversation. */
export function agentV9System(access: AgentAccess, roster: readonly string[]): string {
  const parts = [AGENT_V9_RULES]
  if (access === 'write') parts.push(AGENT_V9_EDIT_TOOLS)
  if (roster.length > 0) parts.push(`${AGENT_V9_ROSTER_HEADING}\n${roster.join('\n')}`)
  return parts.join('\n\n')
}

export function buildAgentPromptV9(input: BuildAgentPromptV9Input): BuiltAgentPromptV9 {
  const tail: string[] = []
  if (input.voice !== null && input.voice.trim() !== '') tail.push(input.voice)
  tail.push(input.scene ?? AGENT_V9_NO_SCENE)
  if (input.evidence.trim() !== '') tail.push(`${AGENT_V9_EVIDENCE_HEADING}\n${input.evidence}`)
  if (input.widened !== null && input.widened.text.trim() !== '') {
    tail.push(`${AGENT_V9_WIDENED_HEADING}, ${input.widened.what}:\n${input.widened.text}`)
  }
  if (input.searched !== null) tail.push(`${input.searched}.`)
  tail.push(`Question: ${input.question}`)

  const messages: AiMessage[] = [
    { role: 'system', content: agentV9System(input.access, input.roster) },
    ...input.history.map((turn) => ({
      role: turn.role,
      content: `${AGENT_V9_HISTORY_LABEL} ${turn.content}`
    })),
    { role: 'user', content: tail.join('\n\n') }
  ]
  if (input.retry === true) messages.push({ role: 'user', content: AGENT_RETRY_TURN })
  const reasoning = SCRIBE_REASONING[input.turn]
  return {
    version: AGENT_PROMPT_V9_VERSION,
    messages,
    maxTokens:
      input.retry === true ? AGENT_RETRY_MAX_TOKENS : scribeMaxTokens(input.turn, reasoning),
    reasoning
  }
}
