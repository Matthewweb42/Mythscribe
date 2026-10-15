import { estimateTokens, inputBudget } from '@shared/ai'
import type { AgentFocus, AgentStep } from '@shared/agent'
import type { AssistantMode } from '@shared/aiSettings'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import {
  SCRIBE_COST_CAP_USD,
  SCRIBE_MAX_STEPS,
  SCRIBE_SOURCES_MAX,
  scribeAccess,
  type ScribeSources
} from '@shared/scribe2'
import { getAiSettings } from '../project/settingsStore'
import { searchPassages } from '../search/passageIndex'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile } from '../voice/profile'
import {
  AGENT_DROPPED_RESULT,
  AGENT_OUT_OF_STEPS,
  runAgentLoop,
  type AgentHooks,
  type AgentProposal
} from '../ai/agent'
import { assertFeatureAllowed } from '../ai/dial'
import type { AgentTranscriptStep } from '../ai/prompts/agent.v1'
import type { ChatTurn } from '../ai/prompts/chat.v1'
import {
  buildScribePrompt,
  scribeRules,
  type BuildScribePromptInput,
  type BuiltScribePrompt
} from '../ai/prompts/scribe.v1'
import type { CompletionUsage } from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import { buildScribeContext } from './context'
import { loadScribeSources } from './source'
import { runScribeTool, type ScribeRun } from './tools'

export interface Scribe2Input {
  /** The open document, or null with none open. */
  nodeId: string | null
  message: string
  history: ChatTurn[]
  mode: AssistantMode
  focus: AgentFocus
  /** "Whole book": send the whole book whatever its size (up to its cap). */
  wholeBook: boolean
  requestId?: string
}

export interface Scribe2Result {
  answer: string
  steps: AgentStep[]
  /** Note edits (applied already) and prose suggestions (waiting for the author), in order. */
  changes: (AgentProposal & { applied: boolean })[]
  sources: ScribeSources
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

/** Results of the passage index the context's pick reads, per question. */
const PICK_SEARCH_RESULTS = 20

/**
 * The prompt for one step within `inputBudget('scribe')`: the oldest tool results give way first
 * (the call stays, so she knows she looked), then the oldest history turns (the agent's rule).
 */
export function fitScribePrompt(input: BuildScribePromptInput): BuiltScribePrompt {
  const budget = inputBudget('scribe')
  const estimate = (built: BuiltScribePrompt): number =>
    estimateTokens(built.messages.map((m) => m.content).join('\n'))
  let steps: AgentTranscriptStep[] = input.steps
  let history = input.history
  let built = buildScribePrompt({ ...input, steps, history })
  for (let i = 0; i < steps.length && estimate(built) > budget; i++) {
    if (steps[i]?.result === AGENT_DROPPED_RESULT) continue
    steps = steps.map((step, j) => (j === i ? { ...step, result: AGENT_DROPPED_RESULT } : step))
    built = buildScribePrompt({ ...input, steps, history })
  }
  while (history.length > 0 && estimate(built) > budget) {
    history = history.slice(1)
    built = buildScribePrompt({ ...input, steps, history })
  }
  return built
}

/** Refs as they stand in an answer ("(n3)", "p2"), for its sources. */
const REF = /\b([np]\d+)\b/g

/**
 * The scenes and pages an answer rests on: those it lists in `sources`, then those its text names
 * by ref, then those she opened or edited; each once, scenes in the order met.
 */
export function answerSources(
  run: Pick<ScribeRun, 'project' | 'pages' | 'used'>,
  answer: string,
  listed: readonly unknown[]
): ScribeSources {
  const refs = [
    ...listed.filter((ref): ref is string => typeof ref === 'string'),
    ...[...answer.matchAll(REF)].map((match) => match[1] ?? '')
  ].map((ref) => ref.trim().toLowerCase())
  const scenes: ScribeSources['scenes'] = []
  const pages: ScribeSources['pages'] = []
  const addScene = (nodeId: string): void => {
    const row = run.project.byId.get(nodeId)
    if (row?.kind !== 'document' || scenes.some((s) => s.nodeId === nodeId)) return
    scenes.push({ nodeId, title: run.project.titleOf(nodeId) || row.title })
  }
  const addPage = (id: string): void => {
    const page = run.pages.find((p) => p.id === id)
    if (page === undefined || pages.some((p) => p.id === id)) return
    pages.push({ id, title: page.title, kind: page.kind })
  }
  for (const ref of refs) {
    if (ref.startsWith('n')) {
      const row = run.project.byRef.get(ref)
      if (row !== undefined) addScene(row.id)
    } else {
      const page = run.pages.find((p) => p.ref === ref)
      if (page !== undefined) addPage(page.id)
    }
  }
  for (const id of run.used) {
    addScene(id)
    addPage(id)
  }
  return { scenes: scenes.slice(0, SCRIBE_SOURCES_MAX), pages: pages.slice(0, SCRIBE_SOURCES_MAX) }
}

/** "(n3)" in an answer reads as the scene's title, "(p2)" as the page's: the sources list holds the links. */
export function readableAnswer(run: Pick<ScribeRun, 'project' | 'pages'>, answer: string): string {
  return answer.replace(REF, (whole, ref: string) => {
    const key = ref.toLowerCase()
    if (key.startsWith('n')) {
      const row = run.project.byRef.get(key)
      return row === undefined ? whole : run.project.titleOf(row.id) || row.title
    }
    return run.pages.find((page) => page.ref === key)?.title ?? whole
  })
}

/**
 * Ms Scribe's turn in a story memory v1 project (notes redesign phase 1). The gate first
 * (`scribe`); then the context (`buildScribeContext`: every note page, the book map, the book whole
 * when it fits or the picked scenes, the moment), and the chat agent's research loop
 * (`runAgentLoop`, strong tier) with her tools. Note writes land in the notebook as she makes them
 * (`notebookChanged` tells the windows); prose suggestions come back for the author's accept.
 */
export async function runScribe2(
  db: TreeDb,
  deps: AiRequestDeps,
  folder: string,
  input: Scribe2Input,
  onStep: (step: AgentStep) => void,
  hooks: AgentHooks,
  notebookChanged: (ids: string[]) => void
): Promise<Scribe2Result> {
  assertFeatureAllowed(getAiSettings(db), 'scribe')
  const material = await loadScribeSources(db, folder, input.nodeId)
  const access = scribeAccess(input.mode, input.message)
  const active = input.nodeId === null ? undefined : material.project.byId.get(input.nodeId)
  const pov = active ? parseStoredSceneMeta(active.sceneMeta).pov.trim() : ''
  const profile = access.prose ? buildVoiceProfile(db, { pov: pov || undefined }) : null
  const context = buildScribeContext({
    rulesTokens: estimateTokens(scribeRules(input.mode, access)),
    pages: material.pages,
    scenes: material.scenes,
    currentId: input.nodeId,
    selection: input.focus.selection,
    question: input.message,
    wholeBook: input.wholeBook,
    searchHits: [
      ...new Set(searchPassages(db, input.message, PICK_SEARCH_RESULTS).map((hit) => hit.nodeId))
    ],
    names: material.names
  })
  const run: ScribeRun = {
    db,
    project: material.project,
    pages: material.pages,
    scenes: material.scenes,
    access,
    profile,
    changes: [],
    used: new Set(),
    notebookChanged
  }
  const base: BuildScribePromptInput = {
    mode: input.mode,
    access,
    context,
    history: input.history,
    message: input.message,
    steps: [],
    final: false
  }
  const loop = await runAgentLoop(
    deps,
    {
      feature: 'scribe',
      tier: 'strong',
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      maxSteps: SCRIBE_MAX_STEPS,
      costCapUsd: SCRIBE_COST_CAP_USD,
      outOfSteps: AGENT_OUT_OF_STEPS,
      build: (steps, { final, retry }) => fitScribePrompt({ ...base, steps, final, retry }),
      runTool: (tool, args) => runScribeTool(run, tool, args)
    },
    onStep,
    hooks
  )
  const raw = loop.outcome.kind === 'answer' ? loop.outcome.reply.answer : loop.outcome.message
  const listed = loop.outcome.kind === 'answer' ? loop.outcome.reply.sources : []
  return {
    answer: readableAnswer(run, raw),
    steps: loop.steps,
    changes: run.changes.map(({ proposal, applied }) => ({ ...proposal, applied })),
    sources: answerSources(run, raw, listed),
    usage: loop.usage,
    costUsd: loop.costUsd,
    cached: loop.outcome.kind === 'answer' && loop.cached,
    model: loop.model,
    promptVersion: loop.promptVersion
  }
}
