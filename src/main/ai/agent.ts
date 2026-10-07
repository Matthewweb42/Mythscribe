import { estimateTokens, inputBudget } from '@shared/ai'
import {
  AGENT_ANSWER_MAX,
  AGENT_COST_CAP_USD,
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
import {
  QUERY_QUOTE_MAX,
  stripDanglingMarkers,
  type QueryCitation,
  type QueryTurn
} from '@shared/query'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { getSummary } from '../document/summaryStore'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, documentText, type VoiceProfile } from '../voice/profile'
import { voiceBlock } from '../voice/voiceBlock'
import {
  loadAgentProject,
  nodeByRef,
  resolveAgentEdit,
  runAgentTool,
  type AgentProject
} from './agentTools'
import { checkChatFidelity } from './chat'
import { headTruncate } from './context/chatContext'
import { notesText } from './context/scenePanel'
import { assertFeatureAllowed } from './dial'
import { cancelInflight, registerInflight, releaseInflight } from './inflight'
import {
  buildAgentPrompt,
  renderAgentFocus,
  type AgentTranscriptStep,
  type BuildAgentPromptInput,
  type BuiltAgentPrompt
} from './prompts/agent.v1'
import type { ChatTurn } from './prompts/chat.v1'
import { AiCancelledError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

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

/** The answer when the model was still looking things up after the last allowed step. */
export const AGENT_OUT_OF_STEPS =
  'I ran out of lookups before I could answer. Ask again, a little more narrowly.'
/** What an older tool result becomes when the step would go over the input budget. */
export const AGENT_DROPPED_RESULT = '(Result dropped to save space; look again if you need it.)'

/** The request id of step `n` of run `requestId`, so `ai:cancel` on the run stops the step in flight. */
export function agentStepRequestId(requestId: string, n: number): string {
  return `${requestId}:step${n}`
}

/** One parsed reply: a tool call, or the answer with its raw citations and edits. */
export type AgentReply =
  | { kind: 'tool'; tool: unknown; args: Record<string, unknown> }
  | { kind: 'answer'; answer: string; found: boolean; citations: unknown[]; edits: unknown[] }

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * The model's reply, leniently: a fenced or bare JSON object with `tool` is a call, one with
 * `answer` the reply; anything that is not JSON is taken as a plain answer with no citations,
 * so a model that forgets the protocol still answers the author.
 */
export function parseAgentReply(text: string): AgentReply {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let json: unknown
  try {
    json = JSON.parse(body)
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
    edits: Array.isArray(reply.edits) ? reply.edits : []
  }
}

/**
 * The chat agent (F-5.22): research, then answer. The gate first (`agent`, which the one switch
 * allows at Ask and Auto). The open document goes in every step (title, synopsis, notes head,
 * stored summary, the caret window and the selection the renderer sends); everything else the
 * model reads only through the tools, one step at a time, each step shown live through `onStep`.
 * Every step is one strong-tier JSON request through `runAiRequest` (a ledger row each); before a
 * step goes, the oldest tool results are dropped until it fits the input budget, then the oldest
 * history. After `AGENT_MAX_STEPS` lookups, or once the run has spent `AGENT_COST_CAP_USD`, the
 * model is told to answer at once. A write run carries the voice block, and every edit's prose
 * is checked against the profile (F-14.7): an off-voice edit is offered flagged, never applied
 * on its own. Citations are kept only when the cited document holds the quote; edits only when
 * `resolveAgentEdit` can place them. Nothing is written here.
 *
 * Cancel (F-5.10): the run registers `requestId` itself, and an abort of it stops the step in
 * flight (each step registers `agentStepRequestId`) and the loop before the next.
 */
export async function runAgent(
  db: TreeDb,
  deps: AiRequestDeps,
  input: AgentInput,
  onStep: (step: AgentStep) => void
): Promise<AgentResult> {
  assertFeatureAllowed(getAiSettings(db), 'agent')
  const project = loadAgentProject(db)
  const active = input.nodeId === null ? undefined : project.byId.get(input.nodeId)
  const activeText = active?.kind === 'document' ? documentText(active) : ''
  const pov = active ? parseStoredSceneMeta(active.sceneMeta).pov.trim() : ''
  const profile: VoiceProfile | null =
    input.access === 'write' ? buildVoiceProfile(db, { pov: pov || undefined }) : null
  const voice = profile ? voiceBlock(profile, { text: activeText, pov: pov || null }) : null
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
  let model: string
  let promptVersion: string
  try {
    for (let n = 0; ; n++) {
      if (outer?.signal.aborted === true) throw new AiCancelledError('The request was stopped.')
      const final = n >= AGENT_MAX_STEPS || costUsd >= AGENT_COST_CAP_USD
      const prompt = fitAgentPrompt({
        access: input.access,
        voice,
        focus,
        history: input.history,
        message: input.message,
        steps: transcript,
        final
      })
      current = input.requestId === undefined ? null : agentStepRequestId(input.requestId, n)
      const reply = await runAiRequest(deps, {
        feature: 'agent',
        tier: 'strong',
        messages: prompt.messages,
        maxTokens: prompt.maxTokens,
        json: true,
        contextHash: sha256(JSON.stringify(prompt.messages)),
        promptVersion: prompt.version,
        ...(current === null ? {} : { requestId: current })
      })
      current = null
      usage.inputTokens += reply.usage.inputTokens
      usage.outputTokens += reply.usage.outputTokens
      costUsd += reply.costUsd
      cached &&= reply.cached
      model = reply.model
      promptVersion = prompt.version

      const parsed = parseAgentReply(reply.text)
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

/**
 * The prompt for one step within `inputBudget('agent')`, measured as `runAiRequest` measures:
 * the oldest tool results give way first (the call stays, so the model knows it looked), then
 * the oldest history turns. Whatever still does not fit is refused by the request path.
 */
export function fitAgentPrompt(input: BuildAgentPromptInput): BuiltAgentPrompt {
  const budget = inputBudget('agent')
  const estimate = (built: BuiltAgentPrompt): number =>
    estimateTokens(built.messages.map((m) => m.content).join('\n'))
  let steps = input.steps
  let history = input.history
  let built = buildAgentPrompt({ ...input, steps, history })
  for (let i = 0; i < steps.length && estimate(built) > budget; i++) {
    if (steps[i]?.result === AGENT_DROPPED_RESULT) continue
    steps = steps.map((step, j) => (j === i ? { ...step, result: AGENT_DROPPED_RESULT } : step))
    built = buildAgentPrompt({ ...input, steps, history })
  }
  while (history.length > 0 && estimate(built) > budget) {
    history = history.slice(1)
    built = buildAgentPrompt({ ...input, steps, history })
  }
  return built
}

interface SettledReply {
  answer: string
  found: boolean
  citations: unknown[]
  edits: unknown[]
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
): Pick<AgentResult, 'answer' | 'query' | 'changes' | 'dropped'> {
  let dropped = 0
  const citations: QueryCitation[] = []
  reply.citations.slice(0, AGENT_MAX_CITATIONS).forEach((raw, index) => {
    const cite = asRecord(raw)
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
    access === 'read' || citations.length > 0
      ? {
          found: reply.found,
          uncited: access === 'read' && reply.found && citations.length === 0,
          citations,
          sheets: [],
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
  return { answer, query, changes, dropped }
}
