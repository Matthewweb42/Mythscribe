import { estimateTokens, inputBudget } from '@shared/ai'
import type { AgentFocus, AgentStep } from '@shared/agent'
import type { AssistantMode } from '@shared/aiSettings'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import {
  SCRIBE_COST_CAP_USD,
  SCRIBE_MAX_STEPS,
  SCRIBE_SOURCE_QUOTES_MAX,
  SCRIBE_SOURCES_MAX,
  scribeAccess,
  scribeProseMax,
  type ScribeSources
} from '@shared/scribe2'
import { getAiSettings } from '../project/settingsStore'
import { searchPassages } from '../search/passageIndex'
import type { NodeRow } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, documentText } from '../voice/profile'
import {
  AGENT_DROPPED_RESULT,
  AGENT_OUT_OF_STEPS,
  runAgentLoop,
  type AgentHooks,
  type AgentLoopPrompt,
  type AgentProposal
} from '../ai/agent'
import type { AgentProject } from '../ai/agentTools'
import { assertFeatureAllowed } from '../ai/dial'
import type { AgentTranscriptStep } from '../ai/prompts/agent.v1'
import type { ChatTurn } from '../ai/prompts/chat.v1'
import type { BuildScribePromptInput } from '../ai/prompts/scribe.v1'
import { scribeModeLineV3 } from '../ai/prompts/scribe.v3'
import { buildScribePromptV4, SCRIBE_V4_RULES } from '../ai/prompts/scribe.v4'
import type { CompletionUsage } from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import { buildScribeContext } from './context'
import { checkQuotes } from './quotes'
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
export function fitScribePrompt(
  input: BuildScribePromptInput,
  build: (input: BuildScribePromptInput) => AgentLoopPrompt = buildScribePromptV4
): AgentLoopPrompt {
  const budget = inputBudget('scribe')
  const estimate = (built: AgentLoopPrompt): number =>
    estimateTokens(built.messages.map((m) => m.content).join('\n'))
  let steps: AgentTranscriptStep[] = input.steps
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

/** Refs as they stand in an answer ("(n3)", "p2"), for its sources. */
const REF = /\b([np]\d+)\b/g

/** One source as she lists it: a ref (`"n3"`), or (`scribe.v2`) a ref with the words she relied on. */
interface ListedSource {
  ref: string
  quote: string | null
}

function listedSource(value: unknown): ListedSource | null {
  if (typeof value === 'string') return { ref: value.trim().toLowerCase(), quote: null }
  if (typeof value !== 'object' || value === null || !('ref' in value)) return null
  if (typeof value.ref !== 'string') return null
  const quote = 'quote' in value && typeof value.quote === 'string' ? value.quote : null
  return { ref: value.ref.trim().toLowerCase(), quote }
}

/**
 * The scenes and pages an answer rests on: those it lists in `sources`, then those its text names
 * by ref, then those she opened or edited; each once, scenes in the order met. Each keeps the
 * quotes she gave for it that its text holds (`checkQuotes`); one not found is dropped, and the
 * source stays without it.
 */
export function answerSources(
  run: Pick<ScribeRun, 'project' | 'pages' | 'scenes' | 'used'>,
  answer: string,
  listed: readonly unknown[]
): ScribeSources {
  const entries: ListedSource[] = [
    ...listed.flatMap((value) => {
      const entry = listedSource(value)
      return entry === null ? [] : [entry]
    }),
    ...[...answer.matchAll(REF)].map((match) => ({ ref: match[1] ?? '', quote: null }))
  ]
  const quotesOf = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.quote === null) continue
    quotesOf.set(entry.ref, [...(quotesOf.get(entry.ref) ?? []), entry.quote])
  }
  const scenes: ScribeSources['scenes'] = []
  const pages: ScribeSources['pages'] = []
  const addScene = (nodeId: string): void => {
    const row = run.project.byId.get(nodeId)
    if (row?.kind !== 'document' || scenes.some((s) => s.nodeId === nodeId)) return
    const ref = run.project.refOf.get(nodeId)
    const asked = ref === undefined ? [] : (quotesOf.get(ref) ?? [])
    const text =
      asked.length === 0
        ? ''
        : (run.scenes.find((scene) => scene.nodeId === nodeId)?.text ?? documentText(row))
    scenes.push({
      nodeId,
      title: run.project.titleOf(nodeId) || row.title,
      quotes: checkQuotes(text, asked, SCRIBE_SOURCE_QUOTES_MAX)
    })
  }
  const addPage = (id: string): void => {
    const page = run.pages.find((p) => p.id === id)
    if (page === undefined || pages.some((p) => p.id === id)) return
    pages.push({
      id,
      title: page.title,
      kind: page.kind,
      quotes: checkQuotes(page.text, quotesOf.get(page.ref) ?? [], SCRIBE_SOURCE_QUOTES_MAX)
    })
  }
  for (const { ref } of entries) {
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

/** The chapter a node sits in: its folder's title, or '' at the top of its section. */
export function chapterOf(project: Pick<AgentProject, 'byId'>, row: NodeRow): string {
  const parent = row.parentId === null ? undefined : project.byId.get(row.parentId)
  return parent?.sectionType !== null ? '' : parent.title
}

/** How a ref reads in an answer: a chapter, a scene outside any chapter, a page, or itself. */
export interface ScribePlace {
  kind: 'chapter' | 'scene' | 'page' | 'raw'
  name: string
  /** What she may have written before a bracketed ref to name it (its titles). */
  titles: string[]
}

function placeOf(run: Pick<ScribeRun, 'project' | 'pages'>, ref: string): ScribePlace {
  if (ref.startsWith('n')) {
    const row = run.project.byRef.get(ref)
    if (row === undefined) return { kind: 'raw', name: ref, titles: [] }
    if (row.kind !== 'document') {
      const kind = row.sectionType === null ? 'chapter' : 'scene'
      return { kind, name: row.title, titles: [row.title] }
    }
    const chapter = chapterOf(run.project, row)
    // A scene's own title is often a character's name ("Tash"): only its full name is dropped.
    return chapter === ''
      ? { kind: 'scene', name: row.title, titles: [row.title] }
      : { kind: 'chapter', name: chapter, titles: [run.project.titleOf(row.id)] }
  }
  const page = run.pages.find((p) => p.ref === ref)
  return page === undefined
    ? { kind: 'raw', name: ref, titles: [] }
    : { kind: 'page', name: page.title, titles: [page.title] }
}

const andList = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`

/** A chapter folder already called "Chapter 3" reads as itself, not "the chapter Chapter 3". */
const namedChapter = (name: string): boolean => /^chapter\b/i.test(name.trim())

/**
 * Places cited together, each once: chapters as "the chapter Blades of Alandor" (several as "the
 * chapters A and B"; a folder called "Chapter 3" as itself), a scene outside any chapter by its
 * title, a page by its title.
 */
export function placesText(places: readonly ScribePlace[]): string {
  const seen = new Set<string>()
  const unique = places.filter((place) => {
    const key = `${place.kind}\u0000${place.name.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const chapters = unique.filter((place) => place.kind === 'chapter').map((place) => place.name)
  if (chapters.length > 1 && chapters.length === unique.length) {
    if (chapters.every(namedChapter)) return andList(chapters)
    if (!chapters.some(namedChapter)) return `the chapters ${andList(chapters)}`
  }
  return andList(
    unique.map((place) =>
      place.kind !== 'chapter' || namedChapter(place.name)
        ? place.name
        : `the chapter ${place.name}`
    )
  )
}

/** Refs cited together ("n3", "(n3, n4 and p2)"), with the brackets around them if any. */
const REF_GROUP = /(\(\s*)?\b[np]\d+\b(?:(?:\s*[,/&;]\s*(?:and\s+)?|\s+and\s+)[np]\d+\b)*(\s*\))?/g

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where the title `before` ends with starts (one of `titles`, in quote marks or not), or -1. */
function titleEndsAt(before: string, titles: readonly string[]): number {
  for (const title of titles) {
    const trimmed = title.trim()
    if (trimmed.length < 2) continue
    const match = new RegExp(
      `(^|[^\\p{L}\\p{N}])["“‘']?${escapeRegExp(trimmed)}["”’']?\\s*$`,
      'iu'
    ).exec(before)
    if (match !== null) return match.index + (match[1]?.length ?? 0)
  }
  return -1
}

/**
 * The answer as the author reads it (2026-10-15): refs cited together read as the places they
 * stand for, a scene as its chapter ("in n3 and n4" → "in the chapter Blades of Alandor" when both
 * are in it; a scene outside any chapter by its own title), a page by its title; the sources list
 * under the answer holds the links. A bracketed ref right after the title it stands for ("Tash
 * (n3)", "Mara (p2)") replaces that title. An unknown ref stays as written.
 */
export function readableAnswer(run: Pick<ScribeRun, 'project' | 'pages'>, answer: string): string {
  let out = ''
  let last = 0
  for (const match of answer.matchAll(REF_GROUP)) {
    out += answer.slice(last, match.index)
    last = match.index + match[0].length
    const refs = match[0].match(/[np]\d+/g) ?? []
    const places = refs.map((ref) => placeOf(run, ref))
    let open = match[1] ?? ''
    let close = match[2] ?? ''
    const only = new Set(refs).size === 1 ? places[0] : undefined
    if (open !== '' && close !== '' && only !== undefined) {
      const cut = titleEndsAt(out, only.titles)
      if (cut >= 0) {
        out = out.slice(0, cut)
        open = ''
        close = ''
      }
    }
    let text = placesText(places)
    if (open === '' && text.startsWith('the ') && /(^|[.!?]\s+|\n\s*)$/.test(out)) {
      text = `T${text.slice(1)}`
    }
    out += `${open}${text}${close}`
  }
  return out + answer.slice(last)
}

/**
 * Ms Scribe's turn in a story memory v1 project (notes redesign phase 1). The gate first
 * (`scribe`); then the context (`buildScribeContext`: every note page, the book map, the book whole
 * when it fits or the picked scenes, the moment), and the chat agent's research loop
 * (`runAgentLoop`, strong tier) with her tools, on `scribe.v4` (the mode said in the moment; the
 * notes block ends with the folders' templates, which v4's rule line has her follow).
 * Note writes land in the notebook as she makes them (`notebookChanged` tells the windows); prose
 * suggestions come back for the author's accept, at most `scribeProseMax(mode)` of them (three in
 * Vibe, where she proposes them unasked).
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
    rulesTokens: estimateTokens(`${SCRIBE_V4_RULES}\n${scribeModeLineV3(input.mode, access)}`),
    pages: material.pages,
    scenes: material.scenes,
    currentId: input.nodeId,
    selection: input.focus.selection,
    question: input.message,
    wholeBook: input.wholeBook,
    searchHits: [
      ...new Set(searchPassages(db, input.message, PICK_SEARCH_RESULTS).map((hit) => hit.nodeId))
    ],
    names: material.names,
    folderTemplates: material.folderTemplates
  })
  const run: ScribeRun = {
    db,
    project: material.project,
    pages: material.pages,
    scenes: material.scenes,
    access,
    proseMax: scribeProseMax(input.mode),
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
