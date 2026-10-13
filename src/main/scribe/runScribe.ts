import { estimateTokens } from '@shared/ai'
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
import type { RecordPage } from '@shared/memory/records'
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
  markerize,
  needsCitation,
  notFoundLine,
  parseCitedAnswer,
  scopeLine,
  scribeHistory,
  stripCitationMarkup,
  type HistoryTurn,
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
import { recordByNameV2 } from '../ai/agentToolsV2'
import { assertFeatureAllowed } from '../ai/dial'
import { cancelInflight, registerInflight, releaseInflight } from '../ai/inflight'
import {
  AGENT_PROMPT_V9_VERSION,
  buildAgentPromptV9,
  renderScribeScene,
  scribeRoster,
  type BuildAgentPromptV9Input,
  type BuiltAgentPromptV9
} from '../ai/prompts/agent.v9'
import { promptInputBudget } from '../ai/prompts/catalogue'
import type { ChatTurn } from '../ai/prompts/chat.v1'
import { AiCancelledError, type CompletionUsage } from '../ai/providers/types'
import { runAiStream, sha256, type AiRequestDeps, type AiRequestResult } from '../ai/request'
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
 * citation are marked "not checked" (P3-D13), and so is a found answer's first sentence without
 * one (slice 3 retries it). Edits go through `offerEdit` (v2 refuses what it never offers); `pin`
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

/** A turn's kind (P3 §2.3 step 1): the navigation's, else a Write this, an edit, or an answer. */
export function scribeTurnOf(
  input: Pick<ScribeInput, 'navigation' | 'access' | 'message'>,
  cues: Pick<Step0['cues'], 'change' | 'sheetWrite'>
): ScribeTurnKind {
  if (input.navigation !== null) return input.navigation.turn
  if (input.access !== 'write') return 'answer'
  if (isDirectionMessage(input.message)) return 'draft'
  return cues.change || cues.sheetWrite ? 'edit' : 'answer'
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
 * rules, E0 or the question.
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
  let built = buildAgentPromptV9(fitted)
  while (sizeOf(built) > budget) {
    if (evidence.length > 0) evidence = evidence.slice(0, -1)
    else if (history.length > 0) history = history.slice(1)
    else if (widened.length > 0) widened = widened.slice(0, -1)
    else if (input.voice !== null && voice !== input.voice.bare) voice = input.voice.bare
    else break
    fitted = inputOf()
    built = buildAgentPromptV9(fitted)
  }
  return {
    built,
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

/** The first paragraph among `paragraphs` (numbered by `numbers`) holding `quote`; null for none. */
function paraOf(
  paragraphs: readonly string[],
  numbers: readonly number[],
  quote: string
): number | null {
  for (const n of numbers) {
    if (findQuote(paragraphs[n] ?? '', quote)) return n
  }
  return null
}

/** A sentence item's paragraphs: `¶4 text` lines (a scene read) as numbers and texts. */
function numberedLines(text: string): { para: number; text: string }[] {
  return text.split('\n').flatMap((line) => {
    const match = /^¶(\d+) (.*)$/u.exec(line)
    return match === null ? [] : [{ para: Number(match[1]), text: match[2] ?? '' }]
  })
}

/** A sheet line the answer may offer, or what it says instead (null: nothing to say). */
export function pinOf(
  project: AgentProject,
  raw: Record<string, unknown>,
  turn: string
): { edit: Extract<AgentEdit, { kind: 'sheetLine' }> } | { say: string | null } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const text =
    typeof raw.text === 'string'
      ? raw.text.replace(/\s+/gu, ' ').trim().slice(0, SHEET_LINE_MAX)
      : ''
  if (text === '') return { say: null }
  if (name === '') return { say: PIN_NO_RECORD('') }
  const summary = recordByNameV2(project, name)
  if (summary === undefined) return { say: PIN_NO_RECORD(name) }
  if (!isNamedKind(summary.kind)) return { say: PIN_TOPIC(summary.name) }
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
  text: string
  open: EvidenceItem['open']
  /** For E0 and scene reads: the paragraphs sent, by number. */
  lines: { para: number; text: string }[] | null
  /** The scene a citation of it lands in, for the search-miss log (widened items only). */
  widened: boolean
}

function sentE0(e0: SceneE0, shown: readonly number[]): SentItem {
  return {
    id: 'E0',
    label: e0.label,
    ref: e0.ref,
    title: e0.title,
    text: shown.map((n) => e0.paragraphs[n] ?? '').join('\n'),
    open: { kind: 'scene', id: e0.nodeId, para: null },
    lines: shown.map((para) => ({ para, text: e0.paragraphs[para] ?? '' })),
    widened: false
  }
}

function sentOf(item: EvidenceItem, frame: EvidenceFrame): SentItem {
  const lines = item.key.kind === 'scene' ? numberedLines(item.text) : null
  return {
    id: item.id,
    label: item.label,
    ref:
      lines === null
        ? item.ref
        : sceneRefOf(frame, item.key.kind === 'scene' ? item.key.nodeId : ''),
    title: item.title,
    text: item.text,
    open: item.open,
    lines,
    widened: item.id.startsWith('W')
  }
}

/** One kept citation in full: its label, the paragraph it lands in, where it opens. */
function citationOf(n: number, evidence: string, quote: string, item: SentItem): ScribeCitation {
  const lines = item.lines
  const para =
    lines === null
      ? null
      : paraOf(
          lines.map((line) => line.text),
          lines.map((_, i) => i),
          quote
        )
  const at = para === null || lines === null ? null : (lines[para]?.para ?? null)
  const ref = at === null ? item.ref : `${item.ref} ¶${at}`
  const open = item.open === null ? null : at === null ? item.open : { ...item.open, para: at }
  return { n, evidence, label: item.label, ref, title: item.title, open, quote, checked: 'quote' }
}

/**
 * Runs one Ms Scribe turn. `onStep` hears a Self-Route's read ("Reading chapter 9…"); `hooks`
 * stream the answer, reset it, and annotate the developer tools as `runAgent`'s do.
 */
export async function runScribe(
  db: TreeDb,
  deps: AiRequestDeps,
  input: ScribeInput,
  onStep: (step: AgentStep) => void,
  hooks: AgentHooks = {},
  now: () => Date = () => new Date()
): Promise<ScribeResult> {
  assertFeatureAllowed(getAiSettings(db), 'agent')
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
  const keys = (input.navigation?.evidence ?? step0.menu.map((item) => item.key)).filter(
    (key) => !inE0(key, e0)
  )
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
  const scope = input.navigation?.scope ?? step0.scope
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

  const outer = input.requestId === undefined ? null : registerInflight(input.requestId)
  let current: string | null = null
  const stopStep = (): void => {
    if (current !== null) cancelInflight(current)
  }
  outer?.signal.addEventListener('abort', stopStep)

  const steps: AgentStep[] = []
  const usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd = 0
  let cached = true
  let model = ''
  let dropped = resolved.dropped

  /** One request, its answer streamed with the markup held back, added to the turn's totals. */
  const send = async (
    prompt: BuiltAgentPromptV9,
    requestId: string | null
  ): Promise<AiRequestResult> => {
    if (outer?.signal.aborted === true) throw new AiCancelledError('The request was stopped.')
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
    usage.inputTokens += reply.usage.inputTokens
    usage.outputTokens += reply.usage.outputTokens
    costUsd += reply.costUsd
    cached &&= reply.cached
    model = reply.model
    if (streamed && readScribeReply(reply.text, reply.finishReason ?? null).kind !== 'answer') {
      hooks.reset?.()
    }
    return reply
  }

  /** Asks once, and once more with the larger cap when the reply was cut off or unreadable. */
  const ask = async (
    fitted: FittedScribePrompt,
    n: number
  ): Promise<{ reply: ScribeReply; id: string | null }> => {
    const stepId = input.requestId === undefined ? null : agentStepRequestId(input.requestId, n)
    const first = await send(fitted.built, stepId)
    const read = readScribeReply(first.text, first.finishReason ?? null)
    if (read.kind !== 'broken') return { reply: read, id: stepId }
    if (stepId !== null) hooks.note?.(stepId, brokenNote(read.reason, first, true))
    const retryId = input.requestId === undefined ? null : agentRetryRequestId(input.requestId, n)
    const again = await send(buildAgentPromptV9({ ...fitted.input, retry: true }), retryId)
    const reread = readScribeReply(again.text, again.finishReason ?? null)
    if (reread.kind === 'broken' && retryId !== null) {
      hooks.note?.(retryId, brokenNote(reread.reason, again, false))
    }
    return { reply: reread, id: retryId ?? stepId }
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
  /** The scenes a not-found answer looked in: the scenes of the evidence sent, E0 apart. */
  const lookedIn = (sent: readonly EvidenceItem[]): string[] =>
    sent.flatMap((item) =>
      item.open?.kind === 'scene' && item.label !== 'map'
        ? [sceneRefOf(frame, item.open.id)].filter((ref) => ref !== '')
        : []
    )
  const notFound = (sent: readonly EvidenceItem[], widened: string | null): ScribeResult => ({
    ...totals(),
    answer: notFoundLine(scope, { open: e0?.ref ?? null, cited: lookedIn(sent) }),
    changes: [],
    dropped,
    steps,
    scribe: scribeOf({ notFound: true, widened: widened === null ? null : { ref: widened } })
  })

  try {
    let fitted = fitScribePrompt({
      base,
      evidence: resolved.items,
      evidenceBudget,
      history,
      widened: null,
      voice,
      ...(idOf === undefined ? {} : { idOf })
    })
    let asked = await ask(fitted, 0)
    let widenedWhat: string | null = null
    if (asked.reply.kind === 'need') {
      // P3-D15: one Self-Route a turn, while the turn is under its cost cap.
      const target = costUsd >= AGENT_COST_CAP_USD ? null : resolveNeed(frame, asked.reply.need)
      if (target === null) return notFound(fitted.sent, null)
      const step: AgentStep = { tool: 'read', label: `Reading ${target.what}…` }
      steps.push(step)
      onStep(step)
      const nodeIds = target.nodeIds.filter((id) => id !== e0?.nodeId)
      const widened = resolveEvidence(db, widenKeys(frame, nodeIds), step0.nowId, {
        frame,
        prefix: 'W'
      })
      fitted = fitScribePrompt({
        base,
        evidence: resolved.items,
        evidenceBudget,
        history,
        widened: { what: target.what, items: widened.items },
        voice,
        ...(idOf === undefined ? {} : { idOf })
      })
      widenedWhat = target.what
      asked = await ask(fitted, 1)
      if (asked.reply.kind === 'need') return notFound(fitted.sent, widenedWhat)
    }
    const reply = asked.reply
    if (reply.kind === 'broken') {
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

    // Edits: Plan drops them all; a pin becomes a sheet line or a sentence saying why not.
    const changes: AgentProposal[] = []
    const notOffered: string[] = []
    if (!write) {
      dropped += reply.edits.length
    } else {
      for (const raw of reply.edits.slice(0, AGENT_MAX_EDITS)) {
        const edit =
          typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
        if (edit?.edit === 'pin') {
          const pin = pinOf(project, edit, turnId)
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
          if ('say' in pin && pin.say !== null && !notOffered.includes(pin.say)) {
            notOffered.push(pin.say)
          }
          continue
        }
        const offered = offerEdit(project, raw, profile)
        if ('error' in offered) dropped += 1
        else changes.push(offered)
      }
      dropped += Math.max(0, reply.edits.length - AGENT_MAX_EDITS)
    }
    const said = notOffered.length === 0 ? '' : `\n\n${notOffered.join(' ')}`

    if (!reply.found) {
      const missing = notFound(fitted.sent, widenedWhat)
      return { ...missing, answer: `${missing.answer}${said}`, changes }
    }

    // The code check of every citation (P3 §2.3 step 4).
    const sent = new Map<string, SentItem>()
    if (e0 !== null && scene !== null) sent.set('E0', sentE0(e0, scene.shown))
    for (const item of fitted.sent) sent.set(item.id, sentOf(item, frame))
    const parsed = parseCitedAnswer(reply.answer.slice(0, AGENT_ANSWER_MAX))
    const index = askIndexOf(db, listRecords(db))
    // Edit and draft turns describe what Ms Scribe changes, not the book: no "not checked" marks.
    const checkable = turn !== 'edit' && turn !== 'draft'
    const kept = new Set<string>()
    let refused = parsed.malformed
    const verdicts: SentenceVerdict[] = parsed.sentences.map((sentence, i) => ({
      keep: sentence.citations.map((citation) => {
        const item = sent.get(citation.evidence)
        const key = `${citation.evidence}\u0000${citation.quote}`
        const ok =
          item !== undefined &&
          item.label !== 'map' &&
          citation.quote.trim() !== '' &&
          findQuote(item.text, citation.quote) &&
          (kept.has(key) || kept.size < SCRIBE_CITATIONS_MAX)
        if (ok) kept.add(key)
        else refused += 1
        return ok
      }),
      // The main claim: a found answer's first sentence must rest on a citation (P3-D14).
      needsCitation: checkable && (i === 0 || needsCitation(sentence.text, index)),
      unsupported: false
    }))
    const marked = markerize(parsed, verdicts)
    const citations: ScribeCitation[] = marked.citations.flatMap((citation) => {
      const item = sent.get(citation.evidence)
      return item === undefined
        ? []
        : [citationOf(citation.n, citation.evidence, citation.quote, item)]
    })

    // Search misses (P3-D15): a kept citation into the widened text at a paragraph the turn's
    // search did not return. Without a search (no words to search for) nothing is a miss.
    const baseline = input.navigation?.hits ?? step0.hits
    const terms = input.navigation?.terms ?? step0.terms
    let misses = 0
    if (terms.length > 0) {
      for (const citation of citations) {
        const item = sent.get(citation.evidence)
        const nodeId = citation.open?.kind === 'scene' ? citation.open.id : null
        const para = citation.open?.para ?? null
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
      answer: `${marked.text}${said}`,
      changes,
      dropped: dropped + refused,
      steps,
      scribe: scribeOf({
        citations,
        notChecked: marked.notChecked,
        unsupported: marked.unsupported,
        widened: widenedWhat === null ? null : { ref: widenedWhat },
        misses
      })
    }
  } finally {
    outer?.signal.removeEventListener('abort', stopStep)
    if (input.requestId !== undefined) releaseInflight(input.requestId)
  }
}
