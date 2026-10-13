import { isFeatureAllowed } from '@shared/aiSettings'
import type { AgentFocus, AgentStep } from '@shared/agent'
import {
  localRoute,
  ROUTE_HISTORY_TURNS,
  ROUTE_MESSAGE_CHARS,
  ROUTE_SELECTION_PREVIEW_CHARS,
  ROUTE_TITLE_CHARS,
  ROUTE_TURN_CHARS,
  routeActionFeature,
  routeForMemory,
  settleRoute,
  type RouteDecision,
  type RouteSituation
} from '@shared/assistantRoute'
import { pageTextBlocks } from '@shared/memory/pageMarks'
import { isNamedKind } from '@shared/memory/topics'
import type { ReadNowResult } from '@shared/memory/views'
import {
  NAVIGATION_EVIDENCE_MAX,
  NAVIGATION_HITS_MAX,
  NAVIGATION_TERMS_MAX,
  NAVIGATOR_STEPS,
  sameEvidence,
  type EvidenceKey,
  type InstantCard,
  type Navigation,
  type ScribeTurnKind,
  type SearchHit
} from '@shared/scribe'
import { searchableText } from '@shared/search'
import { loadAgentProject } from '../ai/agentTools'
import { headTruncate } from '../ai/context/chatContext'
import { assertFeatureAllowed } from '../ai/dial'
import { cancelInflight, registerInflight, releaseInflight } from '../ai/inflight'
import type { ChatTurn } from '../ai/prompts/chat.v1'
import {
  buildNavigatorPrompt,
  navigatorIdeas,
  navigatorMenuLine,
  navigatorRoster,
  parseNavigatorStep,
  renderNavigatorMap,
  stepFound,
  type NavigatorIdea,
  type NavigatorMapChapter,
  type NavigatorPrefix,
  type NavigatorStepTurn
} from '../ai/prompts/navigator.v1'
import { AiCancelledError, AiProviderError, type CompletionUsage } from '../ai/providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from '../ai/request'
import { cardLines } from '../memory/reading/cardContext'
import { rowTexts } from '../memory/reading/readingFrame'
import { namedTotals } from '../memory/nameIndexer'
import { listRecords } from '../memory/recordStore'
import { getAiSettings } from '../project/settingsStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { evidenceFrame, frameRecord, type EvidenceFrame } from './evidence'
import { instantCard } from './instant'
import { settleTurn } from './runScribe'
import {
  askIndexOf,
  caretParaOf,
  EvidenceMenu,
  gatherStep0,
  type MenuItem,
  type Step0
} from './step0'
import { runNavigatorTool, type NavigatorWorld } from './tools'

/**
 * Ms Scribe's navigation (F-16.24, F-16.25; plan P3 §4.3, design §2.6): what one v2 chat message
 * gets before the answer. A typed action needs no request (`localRoute`). Then Step 0 (local): a
 * question the memory answers is an **instant card** with no AI call, after reading the latest
 * change first when an unread sentence bears on it (one reader request, *Read now*'s path); a stale
 * or contested value goes to Ms Scribe as a lookup turn with that slot's evidence, with no
 * navigator call (P3-D5), as does a change the read-first could not read. A slot the memory has no
 * value for, or a knows question that is not a yes, goes to the navigator, which searches by
 * meaning. Otherwise `navigator.v1` (fast, at most three steps): its first step
 * picks route.v2's action (P3-D7: settled by `settleRoute` and `routeForMemory`, so F-5.26's edit
 * passes and every other route action run as before) and the turn's kind (`settleTurn`: the words
 * decide whether it is a change, so an explicit sheet request is never a read-only query); for a
 * chat message or a question it calls the tools (`tools.ts`) and names the evidence to use (on a
 * first/last/ever/never/how-many/knows question, with every ordered scene hit it passed over). The
 * answer turn carries the navigation (the evidence keys, the scope, the words and every paragraph
 * returned): main keeps nothing between this and `ai:agent` (P3-D1). With the navigator switched
 * off, a message is answered from Step 0's evidence (as v1's router off falls back to chat). An
 * unreadable first step never costs the author the turn: Step 0's evidence answers. Stop cancels
 * the read-first and every step (all under the caller's request id). Nothing here writes but the
 * read-first (the anchors check of the scene, then the reader).
 */

export interface NavigateInput {
  /** The open document, or null with none open. */
  nodeId: string | null
  message: string
  /** The recent turns, oldest first; the last `ROUTE_HISTORY_TURNS` are read. */
  history: ChatTurn[]
  focus: AgentFocus
  /** The caller's id for `ai:cancel`; the steps and the read-first register under it. */
  requestId?: string
}

/** What navigation needs from the reader: *Read now* on one scene (the read-first, P3-D4). */
export interface NavigateReader {
  readNow(nodeId: string, requestId: string): Promise<ReadNowResult>
  /**
   * The scene's anchors check now, as the anchors job runs it (its counts and its
   * `memory:changed`): a fact whose sentence changed a moment ago goes stale before the read.
   */
  checkAnchors(nodeId: string): void
}

interface Spend {
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string | null
}

/** What a message gets: an instant card, a route action, or an answer turn with its navigation. */
export type NavigateResult =
  | ({ kind: 'instant'; card: InstantCard } & Spend)
  | ({ kind: 'route'; decision: RouteDecision; routedBy: 'local' | 'model' } & Spend)
  | ({
      kind: 'answer'
      action: 'chat' | 'query'
      /** Null: Step 0's evidence and the turn's kind from its words (`runScribe` without one). */
      navigation: Navigation | null
      routedBy: 'local' | 'model'
      steps: AgentStep[]
      /** Tool calls the navigator named that were skipped (an unknown tool, past the cap). */
      skipped: number
      /**
       * What reading the latest change first cost, of `costUsd` (P3-D23): the chat's cost title
       * lists it apart from the navigator's own requests, which may be none.
       */
      readUsd: number
    } & Spend)

/** The request id of the navigator's step `n` of run `requestId`, so `ai:cancel` stops it too. */
export function navigatorRequestId(requestId: string, n: number): string {
  return `${requestId}:nav${n}`
}

/** The request id of the read-first's `n`th scene. */
export function readFirstRequestId(requestId: string, n: number): string {
  return `${requestId}:read${n}`
}

/** What the chat shows while the latest change is read first. */
export const READING_FIRST = 'Reading your latest change first…'

const NONE: Spend = {
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  cached: false,
  model: null
}

/**
 * The answer turn's kind from the navigator's `t` (`settleTurn`, as a write run would have it; the
 * answer settles it again for its own access): the words decide whether it is a change; a `t` of
 * lookup is an answer (the lookup kind, with its smaller budgets, is Step 0's own handover); no
 * `t` is an idea turn for an idea question, else an answer.
 */
export function navigationTurn(
  named: ScribeTurnKind | null,
  message: string,
  cues: Step0['cues']
): ScribeTurnKind {
  const kind = named === 'lookup' ? 'answer' : (named ?? (cues.idea ? 'idea' : null))
  return settleTurn(kind, { access: 'write', message }, cues)
}

/**
 * The action an answer turn runs as: a `query` the words ask to change something by (an edit, a
 * sheet line, a Write this) runs as `chat`, so Ask and Auto keep their write access (decision 3);
 * Plan still answers read-only (`routeActionFor`, `agentAccessFor`).
 */
export function answerAction(action: 'chat' | 'query', turn: ScribeTurnKind): 'chat' | 'query' {
  return turn === 'edit' || turn === 'draft' ? 'chat' : action
}

/** The open document as the router's tail names it (`scene "The quay"`), or null. */
function activeOf(db: TreeDb, nodeId: string | null): string | null {
  const row = nodeId === null ? undefined : getNode(db, nodeId)
  if (row?.parentId == null) return null
  return `${row.hierarchyLevel ?? row.kind} "${headTruncate(row.title, ROUTE_TITLE_CHARS)}"`
}

/** The story map's chapters: the readable scenes in reading order, grouped by their chapter. */
export function mapChapters(
  db: TreeDb,
  frame: EvidenceFrame
): { chapters: NavigatorMapChapter[]; nowChapter: number | null } {
  const lines = cardLines(db)
  const scenes = [...frame.reading.order.entries()].sort((a, b) => a[1] - b[1])
  const byId = new Map(frame.nodes.map((row) => [row.id, row]))
  const chapterRow = (nodeId: string): string | null => {
    let at = byId.get(nodeId)
    while (at !== undefined) {
      if (at.hierarchyLevel === 'chapter') return at.id
      at = at.parentId === null ? undefined : byId.get(at.parentId)
    }
    return null
  }
  const chapters: (NavigatorMapChapter & { key: string })[] = []
  for (const [nodeId] of scenes) {
    const ref = frame.reading.refs.get(nodeId) ?? ''
    const number = ref.includes('.') ? ref.slice(0, ref.indexOf('.')) : ref
    const key = chapterRow(nodeId) ?? `ref:${number}`
    const row = byId.get(nodeId)
    const title = searchableText(row?.title ?? '').trim() || 'Untitled'
    let chapter = chapters.at(-1)
    if (chapter?.key !== key) {
      const folder = byId.get(key)
      chapter = {
        key,
        number,
        title: folder === undefined ? title : searchableText(folder.title).trim() || 'Untitled',
        scenes: []
      }
      chapters.push(chapter)
    }
    chapter.scenes = [...chapter.scenes, { ref, title, line: lines.get(nodeId) ?? null }]
  }
  const nowRef = frame.nowId === null ? undefined : frame.reading.refs.get(frame.nowId)
  const nowIndex = chapters.findIndex((chapter) =>
    chapter.scenes.some((scene) => scene.ref === nowRef)
  )
  return {
    chapters: chapters.map(({ number, title, scenes: list }) => ({ number, title, scenes: list })),
    nowChapter: nowIndex < 0 ? null : nowIndex
  }
}

/**
 * The cached prefix's parts (P3 §4.2): the roster (names and nicknames of the named kinds, the
 * secrets' and threads' labels), the first line of each record's Ideas, the story map.
 */
export function navigatorPrefix(db: TreeDb, frame: EvidenceFrame): NavigatorPrefix {
  const records = listRecords(db)
  const named = namedTotals(db)
  const people = records.filter((record) => isNamedKind(record.kind))
  const ideas: NavigatorIdea[] = people.flatMap((record) => {
    const page = frameRecord(frame, record.id)?.ideas ?? null
    const first = page === null ? undefined : pageTextBlocks(page)[0]?.text.trim()
    return first === undefined || first === ''
      ? []
      : [{ recordId: record.id, name: record.name, first, created: record.created }]
  })
  const map = mapChapters(db, frame)
  return {
    roster: navigatorRoster({
      records: people.map((record) => ({
        id: record.id,
        name: record.name,
        created: record.created,
        nicknames: record.aliases.filter((alias) => !alias.isMain).map((alias) => alias.text)
      })),
      named,
      secrets: records.filter((record) => record.kind === 'secret').map((record) => record.name),
      threads: records.filter((record) => record.kind === 'thread').map((record) => record.name)
    }),
    ideas: navigatorIdeas(ideas, named),
    map: renderNavigatorMap(map.chapters, map.nowChapter)
  }
}

/** Keys without repeats, in order, at most `NAVIGATION_EVIDENCE_MAX`. */
function distinct(keys: readonly EvidenceKey[]): EvidenceKey[] {
  const out: EvidenceKey[] = []
  for (const key of keys) {
    if (!out.some((each) => sameEvidence(each, key))) out.push(key)
  }
  return out.slice(0, NAVIGATION_EVIDENCE_MAX)
}

/** Paragraphs without repeats, in order, at most `NAVIGATION_HITS_MAX`. */
function distinctHits(...lists: (readonly SearchHit[])[]): SearchHit[] {
  const out: SearchHit[] = []
  for (const hit of lists.flat()) {
    if (!out.some((each) => each.nodeId === hit.nodeId && each.para === hit.para)) out.push(hit)
  }
  return out.slice(0, NAVIGATION_HITS_MAX)
}

/** The most ordered scene hits an every-earlier-scene answer carries besides the navigator's picks. */
export const ORDERED_PASSED_MAX = 8

/**
 * An every-earlier-scene question's evidence (P3-D8): the navigator's picks, after the ordered
 * scene hits on the menu it passed over: every one before its first scene pick (after its last,
 * for a last question; all of them when it picked none), earliest first (latest first for a last
 * question), at most `ORDERED_PASSED_MAX`. They go first so the fit, which drops the farthest
 * evidence first, never drops the earliest passage code's ordered search found while the scope
 * line says every earlier scene was searched.
 */
export function withOrderedHits(
  keys: readonly EvidenceKey[],
  menu: readonly MenuItem[],
  orderOf: (nodeId: string) => number | undefined,
  latest: boolean
): EvidenceKey[] {
  const at = (key: EvidenceKey): [number, number] | null =>
    key.kind === 'passage' && key.source === 'scene'
      ? [orderOf(key.ownerId) ?? Infinity, key.para]
      : key.kind === 'scene'
        ? [orderOf(key.nodeId) ?? Infinity, key.from]
        : null
  const before = (a: [number, number], b: [number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
  const scenes = menu
    .flatMap((item) => {
      const place = item.key.kind === 'passage' ? at(item.key) : null
      return place === null || place[0] === Infinity ? [] : [{ key: item.key, place }]
    })
    .sort((a, b) => (before(a.place, b.place) ? -1 : before(b.place, a.place) ? 1 : 0))
  const picked = keys.flatMap((key) => {
    const place = at(key)
    return place === null || place[0] === Infinity ? [] : [place]
  })
  const edge =
    picked.length === 0
      ? null
      : picked.reduce((best, each) =>
          (latest ? before(best, each) : before(each, best)) ? each : best
        )
  const passed = (latest ? [...scenes].reverse() : scenes)
    .filter(
      (each) => edge === null || (latest ? before(edge, each.place) : before(each.place, edge))
    )
    .slice(0, ORDERED_PASSED_MAX)
    .map((each) => each.key)
  return [...passed, ...keys]
}

/** What the instant path decided: a result, or the navigator next (with what the read-first cost). */
type InstantStep =
  | { kind: 'done'; result: NavigateResult }
  | { kind: 'navigate'; costUsd: number; keys: EvidenceKey[] }

/**
 * The instant answer (P3-D2–D5), or the navigator next: the card; the latest change read first and
 * then the card (its cost on it); or a lookup turn for Ms Scribe with the slot's evidence and Step
 * 0's (no navigator call) for a stale or contested value. A read the reader cannot make now (Use
 * AI, the reading switch, a pause, a refusal), or one that left the change unread, hands over too:
 * E0 has the change. A slot with no value ('none') or a knows question that is not a yes ('no')
 * goes on to the navigator with the slot's evidence on the menu. `under` runs each read under its
 * own request id, so a Stop on the turn cancels it.
 */
async function instantTurn(
  db: TreeDb,
  reader: NavigateReader,
  step0: Step0,
  caretPara: number | null,
  requestId: string,
  under: <T>(id: string, work: () => Promise<T>) => Promise<T>,
  onStep: (step: AgentStep) => void
): Promise<InstantStep> {
  const shape = step0.shape
  if (shape === null) return { kind: 'navigate', costUsd: 0, keys: [] }
  const menuKeys = step0.menu.map((item) => item.key)
  const lookup = (keys: readonly EvidenceKey[], costUsd: number): InstantStep => ({
    kind: 'done',
    result: {
      kind: 'answer',
      action: 'query',
      navigation: {
        turn: 'lookup',
        evidence: distinct([...keys, ...menuKeys]),
        scope: step0.scope,
        terms: step0.terms.slice(0, NAVIGATION_TERMS_MAX),
        hits: step0.hits.slice(0, NAVIGATION_HITS_MAX)
      },
      routedBy: 'local',
      steps: [],
      skipped: 0,
      ...NONE,
      costUsd,
      readUsd: costUsd
    }
  })
  let outcome = instantCard(db, shape, step0.nowId, { caretPara })
  let spent = 0
  let readFirst = false
  if ('readFirst' in outcome) {
    readFirst = true
    onStep({ tool: 'read', label: READING_FIRST })
    for (const [n, nodeId] of outcome.readFirst.entries()) {
      // The change was saved a moment ago, before the anchors job could look: a fact whose
      // sentence changed goes stale first (with the job's own pushes), so the read re-checks it
      // (P2a-D23 deletes what it does not revive) instead of leaving the old value to go stale
      // after it and contest the new.
      reader.checkAnchors(nodeId)
      const read = await under(readFirstRequestId(requestId, n + 1), () =>
        reader.readNow(nodeId, readFirstRequestId(requestId, n + 1))
      )
      if (read.ok) spent += read.costUsd
      if (!read.ok || (!read.read && read.reason !== 'upToDate')) return lookup([], spent)
    }
    // Read: the card only when nothing that bears on it is still unread (a reply the reader could
    // not use leaves its sentences unread); never read again, so this never loops.
    outcome = instantCard(db, shape, step0.nowId, { caretPara })
  }
  if ('card' in outcome) {
    const card: InstantCard = readFirst
      ? { ...outcome.card, readFirst: { costUsd: spent } }
      : outcome.card
    return { kind: 'done', result: { kind: 'instant', card, ...NONE, costUsd: spent } }
  }
  if ('readFirst' in outcome) return lookup([], spent)
  if (outcome.handover === 'stale' || outcome.handover === 'contested') {
    return lookup(outcome.keys, spent)
  }
  return { kind: 'navigate', costUsd: spent, keys: outcome.keys }
}

/** Runs one message's navigation (P3 §4.3). */
export async function runNavigate(
  db: TreeDb,
  deps: AiRequestDeps,
  reader: NavigateReader,
  input: NavigateInput,
  onStep: (step: AgentStep) => void
): Promise<NavigateResult> {
  const settings = getAiSettings(db)
  // The chat itself: Ms Scribe's switch (P3-D17), at Ask and Auto.
  assertFeatureAllowed(settings, routeActionFeature('chat', 'v2'))
  const requestId = input.requestId ?? 'navigate'

  const row = input.nodeId === null ? undefined : getNode(db, input.nodeId)
  const document = row !== undefined && row.parentId !== null && row.kind === 'document'
  const selection = input.focus.selection.replace(/\s+/gu, ' ').trim()
  const situation: RouteSituation = { hasNode: document, hasSelection: selection !== '' }
  const local = localRoute(input.message, situation)
  if (local !== null) {
    return { kind: 'route', decision: routeForMemory(local, 'v2'), routedBy: 'local', ...NONE }
  }

  const caretPara =
    row !== undefined && document ? caretParaOf(rowTexts(row), input.focus.beforeCaret) : null
  const step0 = gatherStep0(db, {
    nodeId: input.nodeId,
    question: input.message,
    focus: { caretPara, selection: selection === '' ? null : selection }
  })

  // Stop (`ai:cancel` on the caller's id) cancels whatever runs under it: a read-first or a step.
  const outer = input.requestId === undefined ? null : registerInflight(input.requestId)
  let current: string | null = null
  const stop = (): void => {
    if (current !== null) cancelInflight(current)
  }
  const stopped = (): void => {
    if (outer?.signal.aborted === true) throw new AiCancelledError('The request was stopped.')
  }
  const under = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    stopped()
    current = id
    try {
      return await work()
    } finally {
      current = null
      stopped()
    }
  }
  outer?.signal.addEventListener('abort', stop)
  try {
    const instant = await instantTurn(db, reader, step0, caretPara, requestId, under, onStep)
    if (instant.kind === 'done') return instant.result
    return await navigateSteps(db, deps, input, {
      step0,
      selection,
      situation,
      settings,
      requestId,
      handover: instant,
      under,
      onStep
    })
  } finally {
    outer?.signal.removeEventListener('abort', stop)
    if (input.requestId !== undefined) releaseInflight(input.requestId)
  }
}

/** What the steps carry over from Step 0 and the instant path. */
interface StepsFrom {
  step0: Step0
  selection: string
  situation: RouteSituation
  settings: ReturnType<typeof getAiSettings>
  requestId: string
  /** What the read-first cost, and the slot's evidence an instant answer handed on. */
  handover: { costUsd: number; keys: EvidenceKey[] }
  under: <T>(id: string, work: () => Promise<T>) => Promise<T>
  onStep: (step: AgentStep) => void
}

/** The navigator's steps (at most three) and the navigation they settle on. */
async function navigateSteps(
  db: TreeDb,
  deps: AiRequestDeps,
  input: NavigateInput,
  from: StepsFrom
): Promise<NavigateResult> {
  const { step0, selection, situation, settings, requestId, handover, under, onStep } = from
  const answer = (
    action: 'chat' | 'query',
    navigation: Navigation | null,
    routedBy: 'local' | 'model',
    spend: Spend,
    steps: AgentStep[] = [],
    skipped = 0
  ): NavigateResult => ({
    kind: 'answer',
    action,
    navigation,
    routedBy,
    steps,
    skipped,
    ...spend,
    readUsd: handover.costUsd
  })

  // The navigator off: Step 0's evidence answers (as v1's router off falls back to chat).
  if (!isFeatureAllowed(settings, 'navigator')) {
    return answer('chat', null, 'local', { ...NONE, costUsd: handover.costUsd })
  }

  const frame = evidenceFrame(db, step0.nowId)
  // Step 0's menu, then the slot's evidence an instant answer handed on; the hits the navigator's
  // own calls return are kept apart, so Step 0's full list never crowds them out (P3-D15).
  const menu = new EvidenceMenu(frame, { items: step0.menu, hits: [] })
  for (const key of handover.keys) menu.addKey(key)
  const world: NavigatorWorld = {
    project: loadAgentProject(db, input.nodeId, 'v2'),
    frame,
    ask: askIndexOf(db),
    step0,
    menu,
    terms: [],
    scope: null,
    reads: 0
  }
  const prefix = navigatorPrefix(db, frame)
  const tail = {
    now: step0.nowRef,
    active: activeOf(db, input.nodeId),
    selection: selection === '' ? null : headTruncate(selection, ROUTE_SELECTION_PREVIEW_CHARS),
    history: input.history.slice(-ROUTE_HISTORY_TURNS).map((turn) => ({
      role: turn.role,
      content: headTruncate(turn.content.trim(), ROUTE_TURN_CHARS)
    })),
    message: headTruncate(input.message.trim(), ROUTE_MESSAGE_CHARS)
  }
  const menuLines = menu.items.map((item) => ({
    id: item.id,
    label: item.label,
    ref: item.ref,
    snippet: item.snippet
  }))

  const spend: Spend = {
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: handover.costUsd,
    cached: true,
    model: null
  }
  const steps: AgentStep[] = []
  const turns: NavigatorStepTurn[] = []
  let action: 'chat' | 'query' = 'chat'
  let named: ScribeTurnKind | null = null
  let use: string[] | null = null
  let skipped = 0
  for (let n = 1; n <= NAVIGATOR_STEPS; n++) {
    const prompt = buildNavigatorPrompt({ prefix, tail, menu: menuLines, steps: turns })
    const stepId = navigatorRequestId(requestId, n)
    let text: string
    try {
      const reply = await under(stepId, () =>
        runAiRequest(deps, {
          feature: 'navigator',
          tier: 'fast',
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          json: true,
          contextHash: sha256(JSON.stringify(prompt.messages)),
          promptVersion: prompt.version,
          ...(input.requestId === undefined ? {} : { requestId: stepId })
        })
      )
      spend.usage.inputTokens += reply.usage.inputTokens
      spend.usage.outputTokens += reply.usage.outputTokens
      spend.costUsd += reply.costUsd
      spend.cached &&= reply.cached
      spend.model = reply.model
      text = reply.text
    } catch (err) {
      // A later step that fails answers from what was found; the first one, or a stop, does not.
      if (n === 1 || !(err instanceof AiProviderError) || err instanceof AiCancelledError) throw err
      break
    }
    const step = parseNavigatorStep(text, n)
    skipped += step.skipped
    if (n === 1) {
      // Unreadable: Step 0's evidence answers, the author never loses the turn.
      if (!step.readable) return answer('chat', null, 'model', spend)
      const decision = routeForMemory(
        settleRoute(step.route ?? { action: 'chat', instruction: null, edit: null }, situation),
        'v2'
      )
      if (decision.action !== 'chat' && decision.action !== 'query') {
        return { kind: 'route', decision, routedBy: 'model', ...spend }
      }
      action = decision.action
      named = step.turn
    }
    if (step.use !== null) {
      use = step.use
      break
    }
    if (step.calls.length === 0) break
    const found: string[] = []
    const notes: string[] = []
    for (const call of step.calls) {
      const run = runNavigatorTool(world, call)
      steps.push(run.step)
      onStep(run.step)
      found.push(
        ...run.added.map((item) =>
          navigatorMenuLine({
            id: item.id,
            label: item.label,
            ref: item.ref,
            snippet: item.snippet
          })
        )
      )
      if (run.note !== null) notes.push(run.note)
    }
    turns.push({ reply: text.trim(), found: stepFound(text, found), notes })
  }

  // The evidence: what `use` named, in its order; else the whole menu by rank. On a question that
  // asks for every earlier scene, the ordered scene hits it passed over go first (P3-D8).
  const byId = new Map(world.menu.items.map((item) => [item.id, item.key]))
  const used = (use ?? []).flatMap((id) => {
    const key = byId.get(id)
    return key === undefined ? [] : [key]
  })
  const picked = used.length > 0 ? used : world.menu.items.map((item) => item.key)
  const keys =
    step0.ordinal || world.scope !== null
      ? withOrderedHits(
          picked,
          world.menu.items,
          (nodeId) => frame.reading.order.get(nodeId),
          step0.latest
        )
      : picked
  const scope =
    world.scope === null
      ? step0.scope
      : {
          ...world.scope,
          terms: [...new Set([...world.scope.terms, ...(step0.scope?.terms ?? [])])].slice(
            0,
            NAVIGATION_TERMS_MAX
          )
        }
  const turn = navigationTurn(named, input.message, step0.cues)
  const navigation: Navigation = {
    turn,
    evidence: distinct(keys),
    scope,
    terms: [...new Set([...world.terms, ...step0.terms])].slice(0, NAVIGATION_TERMS_MAX),
    // The navigator's own paragraphs first, then Step 0's: the search-miss baseline (P3-D15).
    hits: distinctHits(world.menu.hits, step0.hits)
  }
  return answer(answerAction(action, turn), navigation, 'model', spend, steps, skipped)
}
