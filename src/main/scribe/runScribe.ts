import { estimateTokens } from '@shared/ai'
import { isFeatureAllowed } from '@shared/aiSettings'
import {
  AGENT_ANSWER_MAX,
  AGENT_COST_CAP_USD,
  AGENT_CUT_OFF_MESSAGE,
  AGENT_MAX_EDITS,
  type AgentAccess,
  type AgentEdit,
  type AgentFocus,
  type AgentStep
} from '@shared/agent'
import { findQuote } from '@shared/critique'
import { ordinalSearch } from '@shared/memory/askParse'
import { caseForm, normName } from '@shared/memory/names'
import type { RecordPage, StoryRecordSummary } from '@shared/memory/records'
import { isNamedKind } from '@shared/memory/topics'
import { isDirectionMessage } from '@shared/quickActions'
import {
  SCRIBE_CITATIONS_MAX,
  SCRIBE_EVIDENCE_TOKENS,
  SCRIBE_LOOKUP_EVIDENCE_TOKENS,
  SCRIBE_WIDEN_TOKENS,
  SHEET_LINE_MAX,
  type EvidenceKey,
  type Navigation,
  type ScribeCitation,
  type ScribeTurn,
  type ScribeTurnKind
} from '@shared/scribe'
import {
  asksForFact,
  bareAnswer,
  isAbsence,
  isAdviceOrQuestion,
  isHedged,
  mainClaimAt,
  markerize,
  needsCitation,
  notFoundLine,
  parseCitedAnswer,
  quoteHeld,
  scopeLine,
  scribeHistory,
  searchedPhrase,
  statesAbsenceAsFact,
  statesScope,
  stripCitationMarkup,
  type HistoryTurn,
  type ParsedAnswer,
  type SentenceVerdict
} from '@shared/scribeAnswer'
import {
  AnswerStream,
  agentRetryRequestId,
  brokenNote,
  agentStepRequestId,
  offerEdit,
  readAgentReply,
  replyObject,
  type AgentHooks,
  type AgentProposal,
  type AgentResult
} from '../ai/agent'
import { loadAgentProject, type AgentProject } from '../ai/agentTools'
import { assertFeatureAllowed } from '../ai/dial'
import { cancelInflight, registerInflight, releaseInflight } from '../ai/inflight'
import {
  AGENT_PROMPT_V9_VERSION,
  AGENT_V9_UNSUPPORTED_SENTENCE_CHARS,
  buildAgentPromptV9,
  renderScribeScene,
  scribeRoster,
  UNSUPPORTED_REASONS,
  type BuildAgentPromptV9Input,
  type BuiltAgentPromptV9,
  type RenderedScene,
  type UnsupportedReason
} from '../ai/prompts/agent.v9'
import {
  buildCitePrompt,
  CITE_PROMPT_VERSION,
  parseCiteReply,
  type CitePromptScope
} from '../ai/prompts/cite.v1'
import { promptInputBudget } from '../ai/prompts/catalogue'
import type { ChatTurn } from '../ai/prompts/chat.v1'
import { AiCancelledError, type CompletionUsage } from '../ai/providers/types'
import {
  runAiRequest,
  runAiStream,
  sha256,
  type AiRequestDeps,
  type AiRequestResult
} from '../ai/request'
import { namedTotals } from '../memory/nameIndexer'
import { rowTexts } from '../memory/reading/readingFrame'
import { getRecord, listRecords } from '../memory/recordStore'
import { povOf } from '../memory/sceneDetailStore'
import { getAiSettings } from '../project/settingsStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, type VoiceProfile } from '../voice/profile'
import { voiceBlock } from '../voice/voiceBlock'
import {
  evidenceFrame,
  renderEvidence,
  resolveEvidence,
  sceneRefOf,
  type EvidenceFrame,
  type EvidenceIdOf,
  type EvidenceItem
} from './evidence'
import {
  applyCite,
  citationLevels,
  citedSentences,
  enforceScope,
  scopeHits,
  type CheckedItem
} from './checks'
import { logSearchMiss } from './searchMissStore'
import { resolveNeed, widenKeys } from './selfRoute'
import { relateToPage } from './sheetLines'
import { askIndexOf, caretParaOf, gatherStep0, type SceneE0, type Step0 } from './step0'

/**
 * Ms Scribe's answer (F-16.25, F-16.26; plan P3 §2.3, design §2.6): a story memory v2 chat turn
 * in one strong-tier call (`agent.v9`), where v1's agent looks things up step by step. Step 0 runs
 * again here (local; E0 is the open scene as saved after the renderer's flush); the evidence is
 * the navigation's keys when `ai:navigate` gave them, else Step 0's menu, each resolved against the
 * book as it is now (P3-D1). The request carries the turn's own reasoning and output cap (off for
 * answers, low for edit and draft turns: P3-D11); its answer streams with the citation markup held
 * back, and a reply cut off or unreadable is asked once more with the larger cap.
 *
 * One Self-Route per turn (P3-D15): a `{"need":"chapter 9"}` reply widens to that chapter, scene
 * or range, whole scenes in reading order up to 8,000 tokens as `W` items, and asks once more; a
 * second need, or one that names nothing, ends "Not found in the manuscript (I looked in …)" with
 * the scope code computed. A kept citation into the widened text at a paragraph the turn's search
 * did not return is logged as a search miss (F-16.35's trigger).
 *
 * Code checks every citation: kept only when its item was sent and the quote is in the item's text
 * as sent; a map (card) is never kept. Sentences that name a record or a scene and kept no
 * citation are marked "not checked" (P3-D13). Then `cite.v1` (fast, one call; none when nothing
 * was cited and no absence has passages to check) rules on every sentence with a kept citation:
 * `no` drops its citations and marks it unsupported, `yes` marks them "quote and sentence
 * checked"; for a first/last/ever/never answer (or one that found nothing) it also checks the
 * passages the search found (P3 slice 3). The scope comes first: such a question is answered over
 * every scene up to now, Step 0's search added when the navigation searched less. On a question
 * that asks for a fact from the book (`asksForFact`), a found answer whose main claim (P3-D14: the
 * first sentence, the second after a bare yes or no) keeps no citation (unless it is a
 * possibility or an opinion, `isHedged`), is found `no`, has an earlier passage, does not say what
 * was searched (those questions), or says someone does not know something is asked once more
 * with a retry turn; still unsupported, or the retry failing, the answer is "Not found in the
 * manuscript (I looked in …)". A Plan run asked for a change or a sheet line is checked as a
 * change turn. Edits go through `offerEdit` (v2 refuses what it never offers); `pin`
 * becomes a sheet line (decision 3 as the author changed it) unless its record is unknown, a secret
 * or thread, or its page already says it, which the answer then says. A read run (Plan) drops every
 * edit. Nothing is written here but search misses: never a claim, card or reading (P3 rule 6).
 */

export interface ScribeInput {
  /** The open document, or null with none open. */
  nodeId: string | null
  message: string
  /** The recent turns the renderer keeps, oldest first. */
  history: ChatTurn[]
  /** `read` (Plan) answers only; `write` (Ask, Auto) may propose edits and sheet lines. */
  access: AgentAccess
  focus: AgentFocus
  /** The caller's id for `ai:cancel` (F-5.10), also the sheet lines' `aiWritten` turn. */
  requestId?: string
  /** What `ai:navigate` found (slice 4); null: Step 0's evidence. */
  navigation: Navigation | null
}

export interface ScribeResult extends AgentResult {
  scribe: ScribeTurn
}

/** What a change turn says when its reply has no words of its own. */
export const CHANGE_READY = 'Here is the change.'

/** A sentence about Ms Scribe's own change on an edit or draft turn ("I added…", "I've moved…"). */
const OWN_CHANGE = /^I(?:['’](?:ve|ll|d|m))?\b/u

/** The `aiWritten` turn of a sheet line when the run has no request id (tests). */
export const SCRIBE_TURN_FALLBACK = 'chat'

/** What the answer says of a sheet line it could not offer (P3-D16). */
export const PIN_NO_RECORD = (name: string): string =>
  name === ''
    ? 'I could not tell whose sheet that goes on, so I put nothing on one; name the record and ask again.'
    : `There is no record called “${name}”, so I put nothing on a sheet; make the record first, then ask again.`
export const PIN_TOPIC = (name: string): string =>
  `“${name}” is a secret or a thread, which has no sheet, so I put nothing on it.`
export const PIN_SAID = (name: string, page: RecordPage): string =>
  `${name}’s ${page === 'pinned' ? 'Pinned' : 'Ideas'} already says that, so I added nothing.`
export const PIN_NOT_NAMED = (name: string): string =>
  `You did not name ${name}, so I put nothing on ${name}’s sheet.`
/** A sheet line the message never asked for (decision 3: only an explicit request writes). */
export const PIN_NOT_ASKED =
  'I put nothing on a sheet; ask me to put it on one if you want it there.'
/** What a read run (Plan) says of a sheet line or a change it dropped. */
export const PLAN_NO_PIN = 'Plan mode writes nothing; switch to Ask or Auto to put it on the sheet.'
export const PLAN_NO_EDIT = 'Plan mode changes nothing; switch to Ask or Auto to make the change.'

/**
 * A turn's kind (P3 §2.3 step 1): the words decide whether it changes anything, never a fast
 * model's label (slice 4 review). A Write this is a draft; a change or a sheet line asked for in
 * words is an edit (a draft when the navigator says so); an edit or draft the words do not ask
 * for is an answer. Otherwise the kind `named` (`navigator.v1`'s idea, to-do or what-if; Step 0's
 * lookup), else an answer. A read run (Plan) writes nothing, so it is never a change turn.
 */
export function settleTurn(
  named: ScribeTurnKind | null,
  input: Pick<ScribeInput, 'access' | 'message'>,
  cues: Pick<Step0['cues'], 'change' | 'sheetWrite'>
): ScribeTurnKind {
  const draft = isDirectionMessage(input.message)
  if (input.access === 'write' && (draft || cues.change || cues.sheetWrite)) {
    return draft || named === 'draft' ? 'draft' : 'edit'
  }
  return named === null || named === 'edit' || named === 'draft' ? 'answer' : named
}

/** A turn's kind (`settleTurn`): the navigation's as the words and the access allow. */
export function scribeTurnOf(
  input: Pick<ScribeInput, 'navigation' | 'access' | 'message'>,
  cues: Pick<Step0['cues'], 'change' | 'sheetWrite'>
): ScribeTurnKind {
  return settleTurn(input.navigation?.turn ?? null, input, cues)
}

/** One reply of `agent.v9`, read: an answer, one Self-Route need, or unusable. */
export type ScribeReply =
  | { kind: 'answer'; answer: string; found: boolean; edits: unknown[] }
  | { kind: 'need'; need: string }
  | { kind: 'broken'; reason: 'cutOff' | 'unreadable' }

/** The longest need kept. */
const NEED_MAX = 200

/**
 * A reply as Ms Scribe reads it: `readAgentReply`'s answer or failure, a `{"need":…}` without an
 * answer as the Self-Route, and a tool call (`agent.v9` has none) as unreadable.
 */
export function readScribeReply(text: string, finishReason: string | null): ScribeReply {
  const read = readAgentReply(text, finishReason)
  if (read.kind === 'broken') return read
  const json = replyObject(text)
  if (json !== null && typeof json.need === 'string' && typeof json.answer !== 'string') {
    const need = json.need.trim().slice(0, NEED_MAX)
    if (need !== '') return { kind: 'need', need }
  }
  if (read.kind === 'tool') return { kind: 'broken', reason: 'unreadable' }
  return { kind: 'answer', answer: read.answer, found: read.found, edits: read.edits }
}

/**
 * The answer as the chat streams it: each piece of the reply's `answer` text added, the citation
 * markup taken out (an unfinished marker at the end held back), trailing space held until the
 * next word. When taking a marker out changes what already showed, the stream is reset and the
 * whole text sent again.
 */
export class ShownStream {
  private raw = ''
  private shown = ''

  constructor(
    private readonly emit: (delta: string) => void,
    private readonly reset: () => void
  ) {}

  feed(piece: string): void {
    this.raw += piece
    const next = stripCitationMarkup(this.raw).trimEnd()
    if (next.startsWith(this.shown)) {
      const delta = next.slice(this.shown.length)
      if (delta !== '') this.emit(delta)
    } else {
      this.reset()
      if (next !== '') this.emit(next)
    }
    this.shown = next
  }
}

/**
 * The longest retry turns together (P3-D14's main-claim retry with its longest reason, then the
 * cut-off retry): the fit holds the cap with both counted, so no retry is ever over it.
 */
const WORST_RETRY: Pick<BuildAgentPromptV9Input, 'retry' | 'unsupported'> = {
  retry: true,
  unsupported: {
    sentence: 'x'.repeat(AGENT_V9_UNSUPPORTED_SENTENCE_CHARS + 1),
    reason: (Object.keys(UNSUPPORTED_REASONS) as UnsupportedReason[]).reduce((a, b) =>
      UNSUPPORTED_REASONS[a].length >= UNSUPPORTED_REASONS[b].length ? a : b
    )
  }
}

/** What the fit is given: the fixed parts, and the parts it may trim (token rule 8). */
export interface ScribeFitInput {
  base: Omit<BuildAgentPromptV9Input, 'evidence' | 'history' | 'widened' | 'voice'>
  /** The evidence in rank order (the nearest first). */
  evidence: readonly EvidenceItem[]
  /** The evidence's own budget (3,000; 1,200 for a lookup). */
  evidenceBudget: number
  history: readonly HistoryTurn[]
  /** A Self-Route widening, its scenes in reading order. */
  widened: { what: string; items: readonly EvidenceItem[] } | null
  /** The voice block, and the same without its exemplars; null for no voice. */
  voice: { full: string; bare: string | null } | null
  idOf?: EvidenceIdOf
  /** The input cap; `agent.v9`'s 24,000 unless a test says otherwise. */
  budget?: number
}

export interface FittedScribePrompt {
  built: BuiltAgentPromptV9
  /** The builder's input as fitted (the retry rebuilds from it). */
  input: BuildAgentPromptV9Input
  /** Every evidence item sent (E… then W…), as the quote check reads them. */
  sent: EvidenceItem[]
  /** Evidence items left out for the budgets. */
  dropped: number
}

const sizeOf = (built: { messages: { content: string }[] }): number =>
  estimateTokens(built.messages.map((message) => message.content).join('\n'))

/**
 * `agent.v9` within its input cap (P3 §2.2): the evidence to its own budget, the widened scenes to
 * 8,000, then, while the whole is over the cap, the farthest evidence goes first, then the oldest
 * history, then the widened chapter's farthest scene, then the voice block's exemplars. Never the
 * rules, E0 or the question. The cap is held with the retry turns counted (`WORST_RETRY`), so
 * neither the main-claim retry nor the one retry of a cut-off reply is ever over it.
 */
export function fitScribePrompt(input: ScribeFitInput): FittedScribePrompt {
  const budget = input.budget ?? promptInputBudget('agent', AGENT_PROMPT_V9_VERSION)
  const firstEvidence = renderEvidence(input.evidence, input.evidenceBudget, input.idOf).kept
  let evidence = input.evidence.filter((item) => firstEvidence.includes(item.id))
  const firstWidened =
    input.widened === null
      ? []
      : renderEvidence(input.widened.items, SCRIBE_WIDEN_TOKENS, input.idOf).kept
  let widened = (input.widened?.items ?? []).filter((item) => firstWidened.includes(item.id))
  let history = [...input.history]
  let voice = input.voice?.full ?? null
  const inputOf = (): BuildAgentPromptV9Input => ({
    ...input.base,
    evidence: renderEvidence(evidence, Infinity, input.idOf).text,
    history,
    voice,
    widened:
      input.widened === null
        ? null
        : { what: input.widened.what, text: renderEvidence(widened, Infinity, input.idOf).text }
  })
  let fitted = inputOf()
  while (sizeOf(buildAgentPromptV9({ ...fitted, ...WORST_RETRY })) > budget) {
    if (evidence.length > 0) evidence = evidence.slice(0, -1)
    else if (history.length > 0) history = history.slice(1)
    else if (widened.length > 0) widened = widened.slice(0, -1)
    else if (input.voice !== null && voice !== input.voice.bare) voice = input.voice.bare
    else break
    fitted = inputOf()
  }
  return {
    built: buildAgentPromptV9(fitted),
    input: fitted,
    sent: [...evidence, ...widened],
    dropped:
      input.evidence.length - evidence.length + (input.widened?.items.length ?? 0) - widened.length
  }
}

/** Whether a key names text E0 already holds (the open scene's own paragraphs). */
function inE0(key: EvidenceKey, e0: SceneE0 | null): boolean {
  if (e0 === null) return false
  if (key.kind === 'scene') return key.nodeId === e0.nodeId
  return (
    key.kind === 'passage' &&
    (key.source === 'scene' || key.source === 'ideaScene' || key.source === 'excludedScene') &&
    key.ownerId === e0.nodeId
  )
}

/** The voice block for an edit or draft turn, and the same without its exemplars (the fit's last cut). */
function voiceParts(
  profile: VoiceProfile,
  e0: SceneE0 | null,
  pov: string | null
): { full: string; bare: string | null } | null {
  const text = e0 === null ? '' : e0.paragraphs.join('\n\n')
  const full = voiceBlock(profile, { text, pov })
  if (full === null) return null
  return { full, bare: voiceBlock({ ...profile, exemplars: [] }, { text, pov }) }
}

/** The open scene's typed POV, by its record's name; null without one. */
function povName(db: TreeDb, e0: SceneE0 | null): string | null {
  const id = e0 === null ? null : povOf(db, e0.nodeId)
  if (id === null) return null
  return getRecord(db, id)?.name ?? null
}

/** A sentence item's paragraphs: `¶4 text` lines (a scene read) as numbers and texts. */
function numberedLines(text: string): { para: number; text: string }[] {
  return text.split('\n').flatMap((line) => {
    const match = /^¶(\d+) (.*)$/u.exec(line)
    return match === null ? [] : [{ para: Number(match[1]), text: match[2] ?? '' }]
  })
}

/**
 * The record a sheet line's name is (identity rules, design §2.2): one whose name or nickname is
 * that name exactly (`normName`; a name matched in its exact case keeps its case), never a part of
 * a name ("Rin" is not Orrin). A name several records hold is the one whose own name it is, else
 * no one's: `ambiguous`. Undefined when no record has it.
 */
export function pinRecordOf(
  records: readonly StoryRecordSummary[],
  name: string
): StoryRecordSummary | 'ambiguous' | undefined {
  const norm = normName(name)
  if (norm === '') return undefined
  const holds = (record: StoryRecordSummary, main: boolean): boolean =>
    record.aliases.some(
      (alias) =>
        alias.norm === norm &&
        (!main || alias.isMain) &&
        (alias.caseRule !== 'exact' || caseForm(alias.text) === caseForm(name))
    )
  const exact = records.filter((record) => holds(record, false))
  if (exact.length === 1) return exact[0]
  if (exact.length === 0) return undefined
  const own = exact.filter((record) => holds(record, true))
  return own.length === 1 ? own[0] : 'ambiguous'
}

/**
 * A sheet line the answer may offer, or what it says instead (null: nothing to say). `named`:
 * the records the message names (with the ones a shared name may mean); when it names any, the
 * line goes on one of them only, never on a record she did not name.
 */
export function pinOf(
  project: AgentProject,
  raw: Record<string, unknown>,
  turn: string,
  named: ReadonlySet<string> = new Set()
): { edit: Extract<AgentEdit, { kind: 'sheetLine' }> } | { say: string | null } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const text =
    typeof raw.text === 'string'
      ? raw.text.replace(/\s+/gu, ' ').trim().slice(0, SHEET_LINE_MAX)
      : ''
  if (text === '') return { say: null }
  if (name === '') return { say: PIN_NO_RECORD('') }
  const summary = pinRecordOf(listRecords(project.db), name)
  if (summary === 'ambiguous') return { say: PIN_NO_RECORD('') }
  if (summary === undefined) return { say: PIN_NO_RECORD(name) }
  if (!isNamedKind(summary.kind)) return { say: PIN_TOPIC(summary.name) }
  if (named.size > 0 && !named.has(summary.id)) return { say: PIN_NOT_NAMED(summary.name) }
  const record = getRecord(project.db, summary.id)
  if (record === null) return { say: PIN_NO_RECORD(name) }
  // "ask" (or anything but a page): the chat asks "Is this an idea or canon?".
  const place: RecordPage | null =
    raw.place === 'pinned' || raw.place === 'ideas' ? raw.place : null
  const pages: RecordPage[] = place === null ? ['pinned', 'ideas'] : [place]
  const said = pages.find((page) => relateToPage(record, page, text) === 'duplicate')
  if (said !== undefined) return { say: PIN_SAID(record.name, said) }
  return { edit: { kind: 'sheetLine', recordId: record.id, name: record.name, place, text, turn } }
}

/** Where a sent item opens and what it is called, for one kept citation. */
interface SentItem {
  id: string
  label: EvidenceItem['label']
  ref: string
  title: string
  /** The book's own words as sent (`EvidenceItem.quotable`): what the quote check reads. */
  quotable: readonly string[]
  open: EvidenceItem['open']
  /** For E0 and scene reads: the paragraphs sent, by number (a shortened one's parts as sent). */
  lines: { para: number; parts: readonly string[] }[] | null
  /** The scene a citation of it lands in, for the search-miss log (widened items only). */
  widened: boolean
  /** A filed line's document (its tag reads "filed from <doc>"). */
  doc: string | null
  /** E0, tagged "the open scene 9.3" as it was sent. */
  e0: boolean
}

/** E0 as it was sent (`renderScribeScene`'s paragraphs, a shortened one as its two parts). */
function sentE0(e0: SceneE0, sent: RenderedScene['sent']): SentItem {
  return {
    id: 'E0',
    label: e0.label,
    ref: e0.ref,
    title: e0.title,
    quotable: sent.flatMap((line) => line.parts),
    open: { kind: 'scene', id: e0.nodeId, para: null },
    lines: sent,
    widened: false,
    doc: null,
    e0: true
  }
}

function sentOf(item: EvidenceItem, frame: EvidenceFrame): SentItem {
  const lines =
    item.key.kind === 'scene'
      ? numberedLines(item.text).map((line) => ({ para: line.para, parts: [line.text] }))
      : null
  return {
    id: item.id,
    label: item.label,
    ref:
      lines === null
        ? item.ref
        : sceneRefOf(frame, item.key.kind === 'scene' ? item.key.nodeId : ''),
    title: item.title,
    quotable: item.quotable,
    open: item.open,
    lines,
    widened: item.id.startsWith('W'),
    doc: item.doc,
    e0: false
  }
}

/** The paragraph of a scene item (E0, a scene read) a quote lies in; null for none or another item. */
function placeOf(item: SentItem, quote: string): number | null {
  const line = item.lines?.find((each) => each.parts.some((part) => findQuote(part, quote)))
  return line?.para ?? null
}

/** One kept citation in full: its label, the paragraph it lands in, where it opens, how far checked. */
function citationOf(
  n: number,
  evidence: string,
  quote: string,
  item: SentItem,
  checked: ScribeCitation['checked']
): ScribeCitation {
  const at = placeOf(item, quote)
  const ref = at === null ? item.ref : `${item.ref} ¶${at}`
  const open = item.open === null ? null : at === null ? item.open : { ...item.open, para: at }
  return { n, evidence, label: item.label, ref, title: item.title, open, quote, checked }
}

/** A sent item as the checks read it. */
const checkedOf = (item: SentItem): CheckedItem => ({
  label: item.label,
  ref: item.ref,
  doc: item.doc,
  quotable: item.quotable,
  context: item.lines === null ? item.quotable : [item.quotable.join('\n')],
  open: item.open,
  e0: item.e0
})

/** What the code checks and `cite.v1` made of one found answer. */
interface CheckedAnswer {
  parsed: ParsedAnswer
  verdicts: SentenceVerdict[]
  /** Citations the code check refused (not sent, not in the item, a map, past the cap). */
  refused: number
  /** How far each kept citation was checked, by `evidence\u0000quote`. */
  levels: Map<string, ScribeCitation['checked']>
  /** Why the main claim is unsupported; null when it stands. */
  main: UnsupportedReason | null
  /**
   * The main claim as the retry quotes it back (P3-D14): the first sentence, with the second when
   * the first only answers yes or no (`mainClaimAt`).
   */
  claim: string
}

/** What the step list shows while `cite.v1` runs (P3 §3.3 step 4). */
export const CHECKING_QUOTES = 'Checking the quotes…'

/** The request id of the `n`th quote check of run `requestId`, so `ai:cancel` stops it too. */
export function citeRequestId(requestId: string, n: number): string {
  return `${requestId}:cite${n}`
}

/** The longest step label (`AgentStep.label`). */
const STEP_LABEL_MAX = 300

/**
 * Runs one Ms Scribe turn. `onStep` hears a widened search, a Self-Route's read ("Reading chapter
 * 9…") and the quote check ("Checking the quotes…"); `hooks` stream the answer, reset it (before
 * the main-claim retry too), and annotate the developer tools as `runAgent`'s do.
 */
export async function runScribe(
  db: TreeDb,
  deps: AiRequestDeps,
  input: ScribeInput,
  onStep: (step: AgentStep) => void,
  hooks: AgentHooks = {},
  now: () => Date = () => new Date()
): Promise<ScribeResult> {
  const settings = getAiSettings(db)
  assertFeatureAllowed(settings, 'agent')
  const project = loadAgentProject(db, input.nodeId, 'v2')
  const openRow = input.nodeId === null ? undefined : getNode(db, input.nodeId)
  const caretPara =
    openRow?.kind === 'document' ? caretParaOf(rowTexts(openRow), input.focus.beforeCaret) : null
  const selection = input.focus.selection.trim()
  const step0 = gatherStep0(db, {
    nodeId: input.nodeId,
    question: input.message,
    focus: { caretPara, selection: selection === '' ? null : selection }
  })
  const frame = evidenceFrame(db, step0.nowId)
  const write = input.access === 'write'
  const turn = scribeTurnOf(input, step0.cues)
  const turnId = (input.requestId ?? SCRIBE_TURN_FALLBACK).slice(0, 100)
  const idOf: EvidenceIdOf | undefined = write ? (id) => project.refOf.get(id) : undefined

  const e0 = step0.e0
  const parentId = e0 === null ? undefined : (project.byId.get(e0.nodeId)?.parentId ?? undefined)
  const scene =
    e0 === null
      ? null
      : renderScribeScene({
          ...e0,
          ...(write
            ? {
                id: project.refOf.get(e0.nodeId),
                parentId: parentId === undefined ? undefined : project.refOf.get(parentId)
              }
            : {})
        })
  // The scope rule (P3 §3.3 step 2, P3-D8): a first/last/ever/never or knows question is answered
  // over every scene up to now; a navigation that searched less gets Step 0's search added.
  const search = enforceScope(input.navigation, step0)
  const keys = search.keys.filter((key) => !inE0(key, e0))
  const resolved = resolveEvidence(db, keys, step0.nowId, { frame })
  const records = listRecords(db).filter((record) => isNamedKind(record.kind))
  const roster = scribeRoster(
    records.map((record) => ({
      id: record.id,
      name: record.name,
      created: record.created,
      nicknames: record.aliases.filter((alias) => !alias.isMain).map((alias) => alias.text)
    })),
    namedTotals(db)
  )
  const pov = write ? povName(db, e0) : null
  const profile = write ? buildVoiceProfile(db, { pov: pov ?? undefined }) : null
  const voice =
    profile !== null && (turn === 'edit' || turn === 'draft') ? voiceParts(profile, e0, pov) : null
  const scope = search.scope
  const base: ScribeFitInput['base'] = {
    access: input.access,
    turn,
    roster,
    scene: scene?.text ?? null,
    searched: scope === null ? null : scopeLine(scope),
    question: input.message
  }
  const history = scribeHistory(input.history)
  const evidenceBudget = turn === 'lookup' ? SCRIBE_LOOKUP_EVIDENCE_TOKENS : SCRIBE_EVIDENCE_TOKENS
  // What the turn's search returned: a widening reads around it, and a citation outside it is a
  // search miss (P3-D15).
  const baseline = search.hits
  const terms = search.terms
  // The answer's checks (P3 §3.3): answer turns are asked again, then answered Not found; a first,
  // last, ever, never or how-many answer (or one that found nothing) must say what was searched
  // and has its scope checked; the quote check runs when its switch allows.
  // Edit and draft turns describe what Ms Scribe changes: a sentence about her own change ("I
  // added a beat…") is no claim, but one that names a record or a scene is checked as any. A Plan
  // run asked for a change or a sheet line is an answer turn to the prompt, but its reply only
  // describes the change, so it is checked as a change turn's (never turned Not found). Which
  // checks run comes from the words alone, whatever kind the navigator named (slice 4 review).
  const asked = settleTurn(null, { access: 'write', message: input.message }, step0.cues)
  const changeTurn = asked === 'edit' || asked === 'draft'
  // The main-claim rules (P3-D14) hold for questions that ask for a fact from the book; an opinion,
  // what-if or brainstorm answer is shown with its naming sentences marked "not checked".
  const claimRules = !changeTurn && asksForFact(input.message, step0.cues)
  const answerTurn =
    !changeTurn && (claimRules || turn === 'answer' || turn === 'lookup' || turn === 'idea')
  const knowsAsked = step0.cues.knows || step0.cues.learns
  const ordinal = step0.cues.scopeAll
  const latest = ordinalSearch(input.message, step0.names).latest
  const citeOn = isFeatureAllowed(settings, 'cite')
  /** Now, as the quote check reads "happened" and "later in the book" against: the open scene's ref. */
  const nowRef = step0.nowId === null ? null : sceneRefOf(frame, step0.nowId) || null
  const index = askIndexOf(db, listRecords(db))

  const outer = input.requestId === undefined ? null : registerInflight(input.requestId)
  let current: string | null = null
  const stopStep = (): void => {
    if (current !== null) cancelInflight(current)
  }
  outer?.signal.addEventListener('abort', stopStep)

  const steps: AgentStep[] = []
  const step = (each: AgentStep): void => {
    const shown = { ...each, label: each.label.slice(0, STEP_LABEL_MAX) }
    steps.push(shown)
    onStep(shown)
  }
  const usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd = 0
  let cached = true
  let model = ''
  let dropped = resolved.dropped
  let asks = 0
  let checks = 0
  /** The scenes the answers cited (code-kept), for the Not found line. */
  const citedNodes: string[] = []

  const stopped = (): void => {
    if (outer?.signal.aborted === true) throw new AiCancelledError('The request was stopped.')
  }
  const add = (reply: AiRequestResult): void => {
    usage.inputTokens += reply.usage.inputTokens
    usage.outputTokens += reply.usage.outputTokens
    costUsd += reply.costUsd
    cached &&= reply.cached
  }

  /** One request, its answer streamed with the markup held back, added to the turn's totals. */
  const send = async (
    prompt: BuiltAgentPromptV9,
    requestId: string | null
  ): Promise<AiRequestResult> => {
    stopped()
    current = requestId
    const answer = new AnswerStream()
    const shown = new ShownStream(
      (delta) => hooks.answer?.(delta),
      () => hooks.reset?.()
    )
    let streamed = false
    const reply = await runAiStream(
      deps,
      {
        feature: 'agent',
        tier: 'strong',
        messages: prompt.messages,
        maxTokens: prompt.maxTokens,
        json: true,
        reasoning: prompt.reasoning,
        contextHash: sha256(JSON.stringify(prompt.messages)),
        promptVersion: prompt.version,
        ...(requestId === null ? {} : { requestId })
      },
      (delta) => {
        const piece = answer.feed(delta)
        if (piece === '') return
        streamed = true
        shown.feed(piece)
      }
    )
    current = null
    add(reply)
    model = reply.model
    if (streamed && readScribeReply(reply.text, reply.finishReason ?? null).kind !== 'answer') {
      hooks.reset?.()
    }
    return reply
  }

  /**
   * Asks once, and once more with the larger cap when the reply was cut off or unreadable;
   * `unsupported` is the main-claim retry's turn (P3-D14).
   */
  const ask = async (
    fitted: FittedScribePrompt,
    unsupported: BuildAgentPromptV9Input['unsupported'] = null
  ): Promise<{ reply: ScribeReply; id: string | null }> => {
    const n = asks
    asks += 1
    const stepId = input.requestId === undefined ? null : agentStepRequestId(input.requestId, n)
    const prompt =
      unsupported === null ? fitted.built : buildAgentPromptV9({ ...fitted.input, unsupported })
    const first = await send(prompt, stepId)
    const read = readScribeReply(first.text, first.finishReason ?? null)
    if (read.kind !== 'broken') return { reply: read, id: stepId }
    if (stepId !== null) hooks.note?.(stepId, brokenNote(read.reason, first, true))
    const retryId = input.requestId === undefined ? null : agentRetryRequestId(input.requestId, n)
    const again = await send(
      buildAgentPromptV9({ ...fitted.input, unsupported, retry: true }),
      retryId
    )
    const reread = readScribeReply(again.text, again.finishReason ?? null)
    if (reread.kind === 'broken' && retryId !== null) {
      hooks.note?.(retryId, brokenNote(reread.reason, again, false))
    }
    return { reply: reread, id: retryId ?? stepId }
  }

  /**
   * The checks of one answer (P3 §2.3 step 4, §3.3): code's quote check of every citation; the
   * main claim by code (`mainClaimAt`: the first sentence, the second after a bare yes or no), on
   * questions that ask for a fact from the book only (`asksForFact`): it keeps a citation unless it
   * says the search found nothing or is a possibility or an opinion (`isHedged`); someone does not
   * know something is never said as a fact; an ordinal or absence answer says what was searched.
   * Then, when something was cited (or an absence answer has passages to check its scope against)
   * and the main claim stands, `cite.v1` on every cited sentence with the scope item.
   */
  const checkAnswer = async (
    answer: string,
    found: boolean,
    fitted: FittedScribePrompt
  ): Promise<CheckedAnswer> => {
    const sent = new Map<string, SentItem>()
    if (e0 !== null && scene !== null) sent.set('E0', sentE0(e0, scene.sent))
    for (const item of fitted.sent) sent.set(item.id, sentOf(item, frame))
    const parsed = parseCitedAnswer(answer.slice(0, AGENT_ANSWER_MAX))
    const at = mainClaimAt(parsed.sentences)
    const kept = new Set<string>()
    let refused = parsed.malformed
    const verdicts: SentenceVerdict[] = parsed.sentences.map((sentence, i) => ({
      keep: sentence.citations.map((citation) => {
        const item = sent.get(citation.evidence)
        const key = `${citation.evidence}\u0000${citation.quote}`
        const ok =
          item !== undefined &&
          item.label !== 'map' &&
          quoteHeld(item.quotable, citation.quote) &&
          (kept.has(key) || kept.size < SCRIBE_CITATIONS_MAX)
        if (ok) {
          kept.add(key)
          if (item.open?.kind === 'scene' && !citedNodes.includes(item.open.id)) {
            citedNodes.push(item.open.id)
          }
        } else refused += 1
        return ok
      }),
      needsCitation: changeTurn
        ? !OWN_CHANGE.test(sentence.text.trim()) && needsCitation(sentence.text, index)
        : // The main claim must rest on a citation (P3-D14), unless it is advice or a question
          // back to the author (P3-D13); a bare "Yes." before it is no claim of its own.
          i < at
          ? false
          : i === at
            ? !isAdviceOrQuestion(sentence.text)
            : needsCitation(sentence.text, index),
      unsupported: false
    }))
    const first = parsed.sentences[0]
    const claim = parsed.sentences[at]
    const claimText =
      first === undefined || claim === undefined
        ? ''
        : parsed.text.slice(first.start, claim.end).trim()
    const absent = claim !== undefined && isAbsence(claim.text)
    const hedged = claim !== undefined && isHedged(claim.text)
    const scoped = statesScope(parsed.text)
    let main: UnsupportedReason | null = null
    if (claimRules && found && first !== undefined && claim !== undefined) {
      // Someone does not know or never learns something, said as a fact (P2b rule 9; agent.v9:
      // "say I found no scene where … (searched …)"): unsupported as the main claim, or a bare
      // "No." to a knows question; marked unsupported anywhere after it.
      const asFact = (text: string): boolean =>
        !scoped && !isHedged(text) && statesAbsenceAsFact(text)
      parsed.sentences.forEach((sentence, i) => {
        const verdict = verdicts[i]
        if (i > at && verdict !== undefined && asFact(sentence.text)) {
          verdicts[i] = { ...verdict, unsupported: true }
        }
      })
      const bareNo = knowsAsked && !absent && !scoped && bareAnswer(first.text) === 'no'
      // A claim about the book (it names a record or a scene, P3-D13) with no kept citation; a
      // claim that names nothing stays marked "not checked", never turned Not found.
      const claims = !absent && !hedged && needsCitation(claim.text, index)
      const cites = verdicts.slice(0, at + 1).some((verdict) => verdict.keep.some(Boolean))
      if (bareNo || parsed.sentences.slice(0, at + 1).some((each) => asFact(each.text))) {
        main = 'absence'
      } else if (claims && !cites) {
        main = 'noCitation'
      } else if (scope !== null && (absent || (ordinal && claims)) && !scoped) {
        main = 'noScope'
      }
    }
    const itemOf = (id: string): CheckedItem | undefined => {
      const item = sent.get(id)
      return item === undefined ? undefined : checkedOf(item)
    }
    const paraOf = (id: string, quote: string): number | null => {
      const item = sent.get(id)
      return item === undefined ? null : placeOf(item, quote)
    }
    const cited = citedSentences(parsed, verdicts, itemOf, paraOf)
    const unchecked = (): CheckedAnswer => ({
      parsed,
      verdicts,
      refused,
      levels: citationLevels(parsed, verdicts, new Map()),
      main,
      claim: claimText
    })
    if (main !== null || !citeOn || costUsd >= AGENT_COST_CAP_USD) return unchecked()

    // The scope item (P3 §3.2): an ordinal answer's main claim and the scene it cites, with the
    // passages the search found before it (after it, for a last one); an answer that found
    // nothing, with every passage the search found (the earliest first). Nothing to list, nothing
    // sent.
    let scopeItem: CitePromptScope | null = null
    if (scope !== null && claim !== undefined && (ordinal || absent)) {
      const lead = absent
        ? undefined
        : claim.citations.find((citation, j) => {
            const item = sent.get(citation.evidence)
            return verdicts[at]?.keep[j] === true && item?.open?.kind === 'scene'
          })
      const leadItem = lead === undefined ? undefined : sent.get(lead.evidence)
      // A passage or a claim lands in its own paragraph, so the scene's earlier ones are listed.
      const place =
        lead === undefined || leadItem?.open?.kind !== 'scene'
          ? null
          : { nodeId: leadItem.open.id, para: placeOf(leadItem, lead.quote) ?? leadItem.open.para }
      const hits =
        absent || place !== null ? scopeHits(frame, baseline, place, { latest, terms }) : []
      if (hits.length > 0) {
        scopeItem = {
          searched: searchedPhrase(scope),
          claim: claimText,
          cited: place === null ? null : sceneRefOf(frame, place.nodeId) || null,
          latest,
          hits
        }
      }
    }
    // An answer that found nothing is checked against the passages the search found even when it
    // cites nothing (design rule 5: absence is never a fact).
    if (cited.length === 0 && scopeItem === null) return unchecked()
    const built = buildCitePrompt({
      question: input.message,
      now: nowRef,
      sentences: cited.map((each) => each.sentence),
      scope: scopeItem
    })
    step({ tool: 'check', label: CHECKING_QUOTES })
    const id = input.requestId === undefined ? null : citeRequestId(input.requestId, checks)
    checks += 1
    let text: string
    try {
      stopped()
      current = id
      const reply = await runAiRequest(deps, {
        feature: 'cite',
        tier: 'fast',
        messages: built.messages,
        maxTokens: built.maxTokens,
        json: true,
        contextHash: sha256(JSON.stringify(built.messages)),
        promptVersion: CITE_PROMPT_VERSION,
        ...(id === null ? {} : { requestId: id })
      })
      current = null
      add(reply)
      text = reply.text
    } catch (error) {
      current = null
      if (error instanceof AiCancelledError) throw error
      // The check never costs the author the answer: its citations stay quote-checked.
      if (id !== null) {
        const why = error instanceof Error ? error.message : String(error)
        hooks.note?.(id, `The quote check failed (${why}); the citations stay quote-checked.`)
      }
      return unchecked()
    }
    const outcome = applyCite(parseCiteReply(text), cited, built.sent, verdicts, {
      sent: built.scope,
      latest,
      absence: absent,
      claimAt: at
    })
    // A possibility or an opinion its quotes do not say is marked, never asked about again.
    const ruled = outcome.main === 'quotesDoNotSay' && hedged ? null : outcome.main
    return {
      parsed,
      verdicts,
      refused,
      levels: citationLevels(parsed, verdicts, outcome.verdicts),
      main: claimRules && found ? ruled : null,
      claim: claimText
    }
  }

  const totals = (): Omit<ScribeResult, 'answer' | 'changes' | 'dropped' | 'scribe' | 'steps'> => ({
    query: null,
    organise: null,
    usage,
    costUsd,
    cached,
    model,
    promptVersion: AGENT_PROMPT_V9_VERSION
  })
  const scribeOf = (over: Partial<ScribeTurn>): ScribeTurn => ({
    turn,
    citations: [],
    notChecked: [],
    unsupported: [],
    scope: scope === null ? null : scopeLine(scope),
    notFound: false,
    retried: false,
    widened: null,
    misses: 0,
    ...over
  })
  /**
   * The scenes a not-found answer looked in: the scenes its answers cited, then the scenes of the
   * evidence sent, E0 apart (the line names the open scene first).
   */
  const lookedIn = (sent: readonly EvidenceItem[]): string[] =>
    [
      ...citedNodes.map((id) => sceneRefOf(frame, id)),
      ...sent.flatMap((item) =>
        item.open?.kind === 'scene' && item.label !== 'map' ? [sceneRefOf(frame, item.open.id)] : []
      )
    ].filter((ref) => ref !== '')
  const notFound = (
    sent: readonly EvidenceItem[],
    widened: string | null,
    retried = false
  ): ScribeResult => ({
    ...totals(),
    answer: notFoundLine(scope, { open: e0?.ref ?? null, cited: lookedIn(sent) }),
    changes: [],
    dropped,
    steps,
    scribe: scribeOf({
      notFound: true,
      retried,
      widened: widened === null ? null : { ref: widened }
    })
  })

  try {
    if (search.widened && scope !== null) {
      step({ tool: 'search', label: `Searching ${searchedPhrase(scope)}…` })
    }
    let fitted = fitScribePrompt({
      base,
      evidence: resolved.items,
      evidenceBudget,
      history,
      widened: null,
      voice,
      ...(idOf === undefined ? {} : { idOf })
    })
    let asked = await ask(fitted)
    let widenedWhat: string | null = null
    if (asked.reply.kind === 'need') {
      // P3-D15: one Self-Route a turn, while the turn is under its cost cap.
      const target = costUsd >= AGENT_COST_CAP_USD ? null : resolveNeed(frame, asked.reply.need)
      if (target === null) return notFound(fitted.sent, null)
      // The open scene is E0 already; a scene too long for the budget is read in part.
      const nodeIds = target.nodeIds.filter((id) => id !== e0?.nodeId)
      const keys = widenKeys(frame, nodeIds, { budget: SCRIBE_WIDEN_TOKENS, hits: baseline })
      const widened = resolveEvidence(db, keys, step0.nowId, { frame, prefix: 'W' })
      const wide = fitScribePrompt({
        base,
        evidence: resolved.items,
        evidenceBudget,
        history,
        widened: { what: target.what, items: widened.items },
        voice,
        ...(idOf === undefined ? {} : { idOf })
      })
      // Nothing new to read (the need named the open scene, or nothing fits): no second call.
      if (!wide.sent.some((item) => item.id.startsWith('W'))) return notFound(fitted.sent, null)
      step({ tool: 'read', label: `Reading ${target.what}…` })
      fitted = wide
      widenedWhat = target.what
      asked = await ask(fitted)
      if (asked.reply.kind === 'need') return notFound(fitted.sent, widenedWhat)
    }
    if (asked.reply.kind === 'broken') {
      return {
        ...totals(),
        answer:
          asked.id === null
            ? AGENT_CUT_OFF_MESSAGE
            : `${AGENT_CUT_OFF_MESSAGE} (Request ${asked.id})`,
        changes: [],
        dropped,
        steps,
        cached: false,
        scribe: scribeOf({ widened: widenedWhat === null ? null : { ref: widenedWhat } })
      }
    }
    let reply = asked.reply

    // The checks (P3 §3.3). "Not found" answers a question, so a found:false answer turn is not
    // checked; an edit or draft turn's reply describes its change and is checked whatever it says.
    const checkOf = (
      each: Extract<ScribeReply, { kind: 'answer' }>
    ): Promise<CheckedAnswer | null> =>
      answerTurn && !each.found
        ? Promise.resolve(null)
        : checkAnswer(each.answer, each.found, fitted)
    let checked = await checkOf(reply)
    let retried = false
    // P3-D14: a main claim the checks do not support is asked about once more (under the cost
    // cap), quoted back with the reason; the second answer is checked the same. A retry that
    // fails (a rate limit, the daily cap) ends Not found, as one that cannot run does: never the
    // unsupported claim, never the whole turn lost.
    if (checked !== null && checked.main !== null && costUsd < AGENT_COST_CAP_USD) {
      retried = true
      hooks.reset?.()
      const retryId =
        input.requestId === undefined ? null : agentStepRequestId(input.requestId, asks)
      try {
        const again = await ask(fitted, { sentence: checked.claim, reason: checked.main })
        if (again.reply.kind === 'answer') {
          reply = again.reply
          checked = await checkOf(reply)
        }
      } catch (error) {
        current = null
        if (error instanceof AiCancelledError) throw error
        if (retryId !== null) {
          const why = error instanceof Error ? error.message : String(error)
          hooks.note?.(retryId, `The retry failed (${why}); the answer reads Not found.`)
        }
      }
    }

    // Edits: Plan drops them all and says so; a pin becomes a sheet line only when the message
    // asked for one (decision 3), on a record it named, or a sentence says why not.
    const changes: AgentProposal[] = []
    const notOffered: string[] = []
    const say = (sentence: string): void => {
      if (!notOffered.includes(sentence)) notOffered.push(sentence)
    }
    const isPin = (raw: unknown): boolean =>
      typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>).edit === 'pin'
    if (!write) {
      dropped += reply.edits.length
      if (reply.edits.some(isPin)) say(PLAN_NO_PIN)
      else if (reply.edits.length > 0) say(PLAN_NO_EDIT)
    } else {
      const named = new Set([
        ...step0.names.records.map((name) => name.recordId),
        ...step0.names.ambiguous.flatMap((name) => name.recordIds)
      ])
      for (const raw of reply.edits.slice(0, AGENT_MAX_EDITS)) {
        const edit =
          typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
        if (edit?.edit === 'pin' && !step0.cues.sheetWrite) {
          dropped += 1
          say(PIN_NOT_ASKED)
          continue
        }
        if (edit?.edit === 'pin') {
          const pin = pinOf(project, edit, turnId, named)
          const duplicate =
            'edit' in pin &&
            changes.some(
              (change) =>
                change.edit.kind === 'sheetLine' &&
                change.edit.recordId === pin.edit.recordId &&
                change.edit.text === pin.edit.text
            )
          if ('edit' in pin && !duplicate) {
            changes.push({ edit: pin.edit, violation: null })
            continue
          }
          dropped += 1
          if ('say' in pin && pin.say !== null) say(pin.say)
          continue
        }
        const offered = offerEdit(project, raw, profile)
        if ('error' in offered) dropped += 1
        else changes.push(offered)
      }
      dropped += Math.max(0, reply.edits.length - AGENT_MAX_EDITS)
    }
    const said = notOffered.length === 0 ? '' : `\n\n${notOffered.join(' ')}`
    /** The answer with what code adds; a change turn whose reply has no words says it has a change. */
    const withSaid = (text: string): string => {
      const body = text.trim() === '' && changeTurn && changes.length > 0 ? CHANGE_READY : text
      return body.trim() === '' ? said.trimStart() : `${body}${said}`
    }

    // Not found: an answer turn that found nothing, or whose main claim stayed unsupported.
    if (checked?.main !== null) {
      dropped += checked?.refused ?? 0
      const missing = notFound(fitted.sent, widenedWhat, retried)
      return { ...missing, answer: `${missing.answer}${said}`, changes }
    }

    const sent = new Map<string, SentItem>()
    if (e0 !== null && scene !== null) sent.set('E0', sentE0(e0, scene.sent))
    for (const item of fitted.sent) sent.set(item.id, sentOf(item, frame))
    const marked = markerize(checked.parsed, checked.verdicts)
    const levels = checked.levels
    const citations: ScribeCitation[] = marked.citations.flatMap((citation) => {
      const item = sent.get(citation.evidence)
      const level = levels.get(`${citation.evidence}\u0000${citation.quote}`) ?? 'quote'
      return item === undefined
        ? []
        : [citationOf(citation.n, citation.evidence, citation.quote, item, level)]
    })

    // Search misses (P3-D15): a kept citation into the widened text at a paragraph the turn's
    // search did not return. Without a search (no words to search for) nothing is a miss, and a
    // citation code could not place in one paragraph is never logged.
    let misses = 0
    if (terms.length > 0) {
      for (const citation of citations) {
        const item = sent.get(citation.evidence)
        const nodeId = citation.open?.kind === 'scene' ? citation.open.id : null
        const para = item === undefined ? null : placeOf(item, citation.quote)
        if (item?.widened !== true || nodeId === null || para === null) continue
        if (baseline.some((hit) => hit.nodeId === nodeId && hit.para === para)) continue
        logSearchMiss(
          db,
          {
            question: input.message,
            terms,
            nodeId,
            para,
            quote: citation.quote,
            promptVersion: AGENT_PROMPT_V9_VERSION
          },
          now()
        )
        misses += 1
      }
    }

    return {
      ...totals(),
      answer: withSaid(marked.text),
      changes,
      dropped: dropped + checked.refused,
      steps,
      scribe: scribeOf({
        citations,
        notChecked: marked.notChecked,
        unsupported: marked.unsupported,
        retried,
        widened: widenedWhat === null ? null : { ref: widenedWhat },
        misses
      })
    }
  } finally {
    outer?.signal.removeEventListener('abort', stopStep)
    if (input.requestId !== undefined) releaseInflight(input.requestId)
  }
}
