import { estimateTokens, inputBudget } from '@shared/ai'
import {
  AGENT_ANSWER_MAX,
  AGENT_COST_CAP_USD,
  AGENT_CUT_OFF_MESSAGE,
  AGENT_MAX_CITATIONS,
  AGENT_MAX_EDITS,
  AGENT_MAX_STEPS,
  AGENT_NOTES_CHARS,
  editProse,
  type AgentAccess,
  type AgentEdit,
  type AgentFocus,
  type AgentStep
} from '@shared/agent'
import { findQuote } from '@shared/critique'
import { ORGANISE_INSTRUCTION_MAX, OrganiseScope, type OrganiseRequest } from '@shared/organise'
import {
  QUERY_QUOTE_MAX,
  stripDanglingMarkers,
  type QueryCitation,
  type QuerySheetRef,
  type QueryTurn
} from '@shared/query'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { STORY_MAP_TOKEN_BUDGET } from '@shared/storyTime'
import { getSummary } from '../document/summaryStore'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, documentText, type VoiceProfile } from '../voice/profile'
import {
  loadAgentProject,
  nodeByRef,
  resolveAgentEdit,
  runAgentTool,
  sheetByName,
  type AgentProject
} from './agentTools'
import { checkChatFidelity } from './chat'
import { headTruncate } from './context/chatContext'
import { notesText } from './context/scenePanel'
import { buildStoryMap } from './context/storyTime'
import { assertFeatureAllowed } from './dial'
import { cancelInflight, registerInflight, releaseInflight } from './inflight'
import { renderAgentFocus, type AgentTranscriptStep } from './prompts/agent.v1'
import type { BuildAgentPromptV2Input } from './prompts/agent.v2'
import type { BuildAgentPromptV3Input } from './prompts/agent.v3'
import { buildAgentPromptV5, type BuiltAgentPromptV5 } from './prompts/agent.v5'
import type { ChatTurn } from './prompts/chat.v1'
import { AiCancelledError, type CompletionUsage } from './providers/types'
import { runAiStream, sha256, type AiRequestDeps, type AiRequestResult } from './request'

export interface AgentInput {
  /** The open document, or null with none open. */
  nodeId: string | null
  message: string
  /** The recent turns the renderer keeps, oldest first. */
  history: ChatTurn[]
  access: AgentAccess
  focus: AgentFocus
  /** The caller's id for `ai:cancel` (F-5.10); optional so tests can run without one. */
  requestId?: string
}

/** An edit the answer proposes, with the voice check's complaint about its prose, if any. */
export interface AgentProposal {
  edit: AgentEdit
  violation: string | null
}

export interface AgentResult {
  answer: string
  /** The verified citations and flags, for a read run always and for a write run that cited. */
  query: QueryTurn | null
  steps: AgentStep[]
  changes: AgentProposal[]
  /** F-9.10 (agent.v4): the organise run the answer asks for, or null. */
  organise: OrganiseRequest | null
  /** Citations whose quote the document does not hold, and edits that could not be offered. */
  dropped: number
  /** Summed over every step. */
  usage: CompletionUsage
  costUsd: number
  /** True only when every step came from the cache. */
  cached: boolean
  model: string
  promptVersion: string
}

/**
 * What a run reports while it goes, beside its lookups (2026-10-07): the answer as it streams
 * (`answer`, each new piece of the reply's `answer` text), `reset` when what streamed so far is
 * void (the step was cut off and is asked again), and `note` for the developer tools' AI
 * inspector (the step's request id and what happened to its reply).
 */
export interface AgentHooks {
  answer?: (delta: string) => void
  reset?: () => void
  note?: (requestId: string, note: string) => void
}

/** The answer when the model was still looking things up after the last allowed step. */
export const AGENT_OUT_OF_STEPS =
  'I ran out of lookups before I could answer. Ask again, a little more narrowly.'
/** What an older tool result becomes when the step would go over the input budget. */
export const AGENT_DROPPED_RESULT = '(Result dropped to save space; look again if you need it.)'

/** The request id of step `n` of run `requestId`, so `ai:cancel` on the run stops the step in flight. */
export function agentStepRequestId(requestId: string, n: number): string {
  return `${requestId}:step${n}`
}

/** The request id of the one retry of step `n` (2026-10-07). */
export function agentRetryRequestId(requestId: string, n: number): string {
  return `${requestId}:step${n}:retry`
}

/** One parsed reply: a tool call, or the answer with its raw citations and edits. */
export type AgentReply =
  | { kind: 'tool'; tool: unknown; args: Record<string, unknown> }
  | {
      kind: 'answer'
      answer: string
      found: boolean
      citations: unknown[]
      edits: unknown[]
      /** F-9.10 (agent.v4): the raw organise request, or undefined. */
      organise?: unknown
    }

/**
 * A reply that is not usable (2026-10-07): `cutOff` when the output cap ended it, `unreadable`
 * when it set out as JSON (or came back empty) and does not parse. Never shown to the author.
 */
export interface BrokenReply {
  kind: 'broken'
  reason: 'cutOff' | 'unreadable'
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const unfence = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

/**
 * The model's reply, leniently: a fenced or bare JSON object with `tool` is a call, one with
 * `answer` the reply; anything that is not JSON is taken as a plain answer with no citations,
 * so a model that forgets the protocol still answers the author.
 */
export function parseAgentReply(text: string): AgentReply {
  let json: unknown
  try {
    json = JSON.parse(unfence(text))
  } catch {
    return { kind: 'answer', answer: text.trim(), found: true, citations: [], edits: [] }
  }
  const reply = asRecord(json)
  if (typeof reply.tool === 'string') {
    return { kind: 'tool', tool: reply.tool, args: asRecord(reply.args) }
  }
  return {
    kind: 'answer',
    answer: typeof reply.answer === 'string' ? reply.answer.trim() : '',
    found: reply.found !== false,
    citations: Array.isArray(reply.citations) ? reply.citations : [],
    edits: Array.isArray(reply.edits) ? reply.edits : [],
    organise: reply.organise
  }
}

/**
 * `parseAgentReply` with the failures told apart (2026-10-07: a reply cut off mid-JSON used to
 * reach the chat raw). A reply that does not parse is broken when the output cap ended it, when
 * it is empty, or when it set out as JSON (a brace, a fence, a protocol key); only prose that
 * never tried to be JSON is still the plain answer.
 */
export function readAgentReply(
  text: string,
  finishReason: string | null
): AgentReply | BrokenReply {
  const body = unfence(text)
  let parses = true
  try {
    JSON.parse(body)
  } catch {
    parses = false
  }
  if (!parses) {
    if (finishReason === 'length') return { kind: 'broken', reason: 'cutOff' }
    const jsonish =
      body === '' ||
      /^[{[]/.test(body) ||
      text.trim().startsWith('```') ||
      /"(answer|tool)"\s*:/.test(body)
    if (jsonish) return { kind: 'broken', reason: 'unreadable' }
  }
  return parseAgentReply(text)
}

/**
 * Pulls the `answer` string out of a JSON reply while it streams (2026-10-07), so the chat shows
 * the first words as they arrive: once `"answer": "` has come, every further character of the
 * string, unescaped, is handed back by `feed`; nothing before it, and nothing after its closing
 * quote. An escape split across two pieces waits for the rest.
 */
export class AnswerStream {
  private buffer = ''
  private start = -1
  private read = 0
  private done = false

  feed(delta: string): string {
    if (this.done) return ''
    this.buffer += delta
    if (this.start < 0) {
      const opening = /"answer"\s*:\s*"/.exec(this.buffer)
      if (opening === null) return ''
      this.start = opening.index + opening[0].length
      this.read = this.start
    }
    let out = ''
    let i = this.read
    while (i < this.buffer.length) {
      const ch = this.buffer[i] ?? ''
      if (ch === '"') {
        this.done = true
        i++
        break
      }
      if (ch !== '\\') {
        out += ch
        i++
        continue
      }
      const next = this.buffer[i + 1]
      if (next === undefined) break
      if (next === 'u') {
        const hex = this.buffer.slice(i + 2, i + 6)
        if (hex.length < 4) break
        out += String.fromCharCode(Number.parseInt(hex, 16) || 0x3f)
        i += 6
        continue
      }
      out += ESCAPES[next] ?? next
      i += 2
    }
    this.read = i
    return out
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '', b: '', f: '', '/': '/' }

/**
 * The chat agent (F-5.22): research, then answer. The gate first (`agent`, which the one switch
 * allows at Ask and Auto). The open document goes in every step (title, synopsis, notes head,
 * stored summary, the caret window and the selection the renderer sends); everything else the
 * model reads only through the tools, one step at a time, each step shown live through `onStep`.
 * Every step is one strong-tier JSON request (`agent.v5` since F-9.16) through `runAiStream` (a ledger row
 * each); the reply's `answer` text streams to `hooks.answer` as it arrives (2026-10-07). Before
 * a step goes, the oldest tool results are dropped until it fits the input budget, then the
 * oldest history. After `AGENT_MAX_STEPS` lookups, or once the run has spent
 * `AGENT_COST_CAP_USD`, the model is told to answer at once.
 *
 * A reply that was cut off by its output cap or does not parse (`readAgentReply`) is never
 * shown: the step is asked once more with a larger cap and a nudge to be brief (`hooks.reset`
 * voids what streamed); if that fails too, the answer is `AGENT_CUT_OFF_MESSAGE` with the step's
 * request id for the developer tools. Neither reply is cached (the request path's rule).
 *
 * Prose never travels in a step (agent.v2): an insertion or a rewrite comes back as an intent
 * with a brief, which the renderer has drafted through `ai:agentDraft`. Prose the model wrote
 * anyway is still voice-checked against the profile (F-14.7): an off-voice edit is offered
 * flagged, never applied on its own. Citations are kept only when the cited document holds the
 * quote (a cited sheet only when the project has it); edits only when `resolveAgentEdit` can
 * place them. Nothing is written here.
 *
 * Cancel (F-5.10): the run registers `requestId` itself, and an abort of it stops the step in
 * flight (each step registers `agentStepRequestId`) and the loop before the next.
 */
export async function runAgent(
  db: TreeDb,
  deps: AiRequestDeps,
  input: AgentInput,
  onStep: (step: AgentStep) => void,
  hooks: AgentHooks = {}
): Promise<AgentResult> {
  assertFeatureAllowed(getAiSettings(db), 'agent')
  const project = loadAgentProject(db, input.nodeId)
  // F-5.23: the story map, with now at the open scene (or the latest written one).
  const map = buildStoryMap(db, project.time, {
    maxTokens: STORY_MAP_TOKEN_BUDGET,
    refOf: project.refOf
  })
  const active = input.nodeId === null ? undefined : project.byId.get(input.nodeId)
  const pov = active ? parseStoredSceneMeta(active.sceneMeta).pov.trim() : ''
  const profile: VoiceProfile | null =
    input.access === 'write' ? buildVoiceProfile(db, { pov: pov || undefined }) : null
  const focus = !active?.parentId
    ? null
    : renderAgentFocus({
        ref: project.refOf.get(active.id) ?? '',
        title: project.titleOf(active.id) || active.title,
        level: active.hierarchyLevel ?? active.kind,
        synopsis: parseStoredSceneMeta(active.sceneMeta).synopsis.trim(),
        notes: headTruncate(notesText(active.notes, active.id), AGENT_NOTES_CHARS),
        summary: getSummary(db, active.id)?.summary ?? '',
        beforeCaret: input.focus.beforeCaret.trim(),
        selection: input.focus.selection.trim()
      })

  const outer = input.requestId === undefined ? null : registerInflight(input.requestId)
  let current: string | null = null
  const stopStep = (): void => {
    if (current !== null) cancelInflight(current)
  }
  outer?.signal.addEventListener('abort', stopStep)

  const steps: AgentStep[] = []
  const transcript: AgentTranscriptStep[] = []
  const usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd = 0
  let cached = true
  let model = ''
  let promptVersion = ''
  /** Sends one step (or its retry), streaming the answer text, and adds it to the run's totals. */
  const send = async (
    prompt: BuiltAgentPromptV5,
    requestId: string | null
  ): Promise<AiRequestResult> => {
    if (outer?.signal.aborted === true) throw new AiCancelledError('The request was stopped.')
    current = requestId
    const answer = new AnswerStream()
    let streamed = false
    const reply = await runAiStream(
      deps,
      {
        feature: 'agent',
        tier: 'strong',
        messages: prompt.messages,
        maxTokens: prompt.maxTokens,
        json: true,
        contextHash: sha256(JSON.stringify(prompt.messages)),
        promptVersion: prompt.version,
        ...(requestId === null ? {} : { requestId })
      },
      (delta) => {
        const piece = answer.feed(delta)
        if (piece === '') return
        streamed = true
        hooks.answer?.(piece)
      }
    )
    current = null
    usage.inputTokens += reply.usage.inputTokens
    usage.outputTokens += reply.usage.outputTokens
    costUsd += reply.costUsd
    cached &&= reply.cached
    model = reply.model
    promptVersion = prompt.version
    if (streamed && readAgentReply(reply.text, reply.finishReason ?? null).kind === 'broken') {
      hooks.reset?.()
    }
    return reply
  }

  try {
    for (let n = 0; ; n++) {
      const final = n >= AGENT_MAX_STEPS || costUsd >= AGENT_COST_CAP_USD
      const base: BuildAgentPromptV3Input = {
        access: input.access,
        voice: null,
        map,
        focus,
        history: input.history,
        message: input.message,
        steps: transcript,
        final
      }
      const stepId = input.requestId === undefined ? null : agentStepRequestId(input.requestId, n)
      const first = await send(fitAgentPrompt(base), stepId)
      let reply = first
      let parsed = readAgentReply(first.text, first.finishReason ?? null)
      if (parsed.kind === 'broken') {
        // 2026-10-07: asked once more, briefly and with room, before anything is shown.
        if (stepId !== null) hooks.note?.(stepId, brokenNote(parsed.reason, first, true))
        const retryId =
          input.requestId === undefined ? null : agentRetryRequestId(input.requestId, n)
        reply = await send(fitAgentPrompt({ ...base, retry: true }), retryId)
        parsed = readAgentReply(reply.text, reply.finishReason ?? null)
        if (parsed.kind === 'broken') {
          if (retryId !== null) hooks.note?.(retryId, brokenNote(parsed.reason, reply, false))
          const id = retryId ?? stepId
          return {
            answer:
              id === null ? AGENT_CUT_OFF_MESSAGE : `${AGENT_CUT_OFF_MESSAGE} (Request ${id})`,
            query: null,
            changes: [],
            organise: null,
            dropped: 0,
            steps,
            usage,
            costUsd,
            cached: false,
            model,
            promptVersion
          }
        }
      }
      if (parsed.kind === 'tool' && !final) {
        const outcome = runAgentTool(project, active?.id ?? null, parsed.tool, parsed.args)
        steps.push(outcome.step)
        onStep(outcome.step)
        const name = typeof parsed.tool === 'string' ? parsed.tool : 'tool'
        transcript.push({
          call: reply.text.trim(),
          result: `Result of ${name}:\n${outcome.result}`
        })
        continue
      }
      const settled =
        parsed.kind === 'tool'
          ? { answer: AGENT_OUT_OF_STEPS, found: true, citations: [], edits: [] }
          : parsed
      return {
        ...finishAnswer(project, input.access, settled, profile),
        steps,
        usage,
        costUsd,
        cached,
        model,
        promptVersion
      }
    }
  } finally {
    outer?.signal.removeEventListener('abort', stopStep)
    if (input.requestId !== undefined) releaseInflight(input.requestId)
  }
}

/** The developer tools' note on a step whose reply could not be used. */
function brokenNote(
  reason: BrokenReply['reason'],
  reply: AiRequestResult,
  retrying: boolean
): string {
  const what =
    reason === 'cutOff'
      ? `Reply cut off by the output cap (finish reason length, ${reply.usage.outputTokens} output tokens` +
        `${reply.usage.reasoningTokens === undefined ? '' : `, ${reply.usage.reasoningTokens} reasoning`})`
      : `Reply was not one JSON object (${reply.text.length} characters, finish reason ${reply.finishReason ?? 'not reported'})`
  return `${what}; ${retrying ? 'not shown, asked again with a larger cap' : 'not shown; the chat says it was cut off'}`
}

/**
 * The prompt for one step within `inputBudget('agent')`, measured as `runAiRequest` measures:
 * the oldest tool results give way first (the call stays, so the model knows it looked), then
 * the oldest history turns. Whatever still does not fit is refused by the request path. The
 * builder is `agent.v3`'s (F-5.23); the eval harness passes the older builders for their cases.
 */
export function fitAgentPrompt<
  I extends BuildAgentPromptV2Input,
  T extends { messages: { content: string }[] }
>(input: I, build: (input: I) => T): T
export function fitAgentPrompt(input: BuildAgentPromptV3Input): BuiltAgentPromptV5
export function fitAgentPrompt(
  input: BuildAgentPromptV3Input,
  build: (input: BuildAgentPromptV3Input) => {
    messages: { content: string }[]
  } = buildAgentPromptV5
): { messages: { content: string }[] } {
  const budget = inputBudget('agent')
  const estimate = (built: { messages: { content: string }[] }): number =>
    estimateTokens(built.messages.map((m) => m.content).join('\n'))
  let steps = input.steps
  let history = input.history
  let built = build({ ...input, steps, history })
  for (let i = 0; i < steps.length && estimate(built) > budget; i++) {
    if (steps[i]?.result === AGENT_DROPPED_RESULT) continue
    steps = steps.map((step, j) => (j === i ? { ...step, result: AGENT_DROPPED_RESULT } : step))
    built = build({ ...input, steps, history })
  }
  while (history.length > 0 && estimate(built) > budget) {
    history = history.slice(1)
    built = build({ ...input, steps, history })
  }
  return built
}

interface SettledReply {
  answer: string
  found: boolean
  citations: unknown[]
  edits: unknown[]
  organise?: unknown
}

/**
 * The organise request an answer carries (F-9.10, agent.v4), read leniently: a scope that is not
 * one of the four is dropped, an instruction is cut to its cap; anything that is not an object is
 * no request.
 */
export function readOrganiseRequest(raw: unknown): OrganiseRequest | null {
  if (raw === true) return { instruction: '', scope: [] }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = asRecord(raw)
  const scope = Array.isArray(record.scope)
    ? record.scope.filter((s): s is OrganiseScope => OrganiseScope.safeParse(s).success)
    : []
  const instruction =
    typeof record.instruction === 'string'
      ? record.instruction.trim().slice(0, ORGANISE_INSTRUCTION_MAX)
      : ''
  return { instruction, scope: [...new Set(scope)] }
}

/**
 * The answer as the chat gets it: citations kept only where the cited document holds the quote
 * (their `[n]` numbers are the model's order, so the markers still point right; a marker whose
 * citation went is stripped), edits resolved against the project, prose edits voice-checked.
 * A read run never edits: any edits it wrote are dropped and counted.
 */
function finishAnswer(
  project: AgentProject,
  access: AgentAccess,
  reply: SettledReply,
  profile: VoiceProfile | null
): Pick<AgentResult, 'answer' | 'query' | 'changes' | 'dropped' | 'organise'> {
  let dropped = 0
  const citations: QueryCitation[] = []
  const sheets: QuerySheetRef[] = []
  reply.citations.slice(0, AGENT_MAX_CITATIONS).forEach((raw, index) => {
    const cite = asRecord(raw)
    if (typeof cite.sheet === 'string') {
      const entity = sheetByName(project, cite.sheet)
      if (entity === undefined || sheets.some((sheet) => sheet.entityId === entity.id)) {
        dropped++
        return
      }
      sheets.push({ entityId: entity.id, name: entity.name, kind: entity.kind })
      return
    }
    const row = nodeByRef(project, cite.id)
    const quote = typeof cite.quote === 'string' ? cite.quote.trim() : ''
    if (row?.kind !== 'document' || quote === '' || !findQuote(documentText(row), quote)) {
      dropped++
      return
    }
    citations.push({
      nodeId: row.id,
      title: project.titleOf(row.id) || row.title,
      scene: index + 1,
      quote: quote.slice(0, QUERY_QUOTE_MAX)
    })
  })
  dropped += Math.max(0, reply.citations.length - AGENT_MAX_CITATIONS)
  const answer = stripDanglingMarkers(
    reply.answer.slice(0, AGENT_ANSWER_MAX),
    citations.map((c) => c.scene)
  )
  const query: QueryTurn | null =
    access === 'read' || citations.length > 0 || sheets.length > 0
      ? {
          found: reply.found,
          uncited:
            access === 'read' && reply.found && citations.length === 0 && sheets.length === 0,
          citations,
          sheets,
          also: []
        }
      : null

  const changes: AgentProposal[] = []
  if (access === 'write') {
    for (const raw of reply.edits.slice(0, AGENT_MAX_EDITS)) {
      const resolved = resolveAgentEdit(project, raw)
      if ('error' in resolved) {
        dropped++
        continue
      }
      const prose = editProse(resolved.edit)
      const violation =
        profile === null || prose === ''
          ? null
          : (checkChatFidelity(profile.stats, prose, profile.authorRules.bannedPhrases)[0]
              ?.message ?? null)
      changes.push({ edit: resolved.edit, violation })
    }
    dropped += Math.max(0, reply.edits.length - AGENT_MAX_EDITS)
  } else {
    dropped += reply.edits.length
  }
  return { answer, query, changes, dropped, organise: readOrganiseRequest(reply.organise) }
}
