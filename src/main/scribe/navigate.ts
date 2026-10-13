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
  type ScribeTurnKind
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
import { runAnchors } from '../memory/reading/anchors'
import { cardLines } from '../memory/reading/cardContext'
import { rowTexts } from '../memory/reading/readingFrame'
import { namedTotals } from '../memory/nameIndexer'
import { listRecords } from '../memory/recordStore'
import { getAiSettings } from '../project/settingsStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { evidenceFrame, frameRecord, type EvidenceFrame } from './evidence'
import { instantCard } from './instant'
import { askIndexOf, caretParaOf, EvidenceMenu, gatherStep0, type Step0 } from './step0'
import { runNavigatorTool, type NavigatorWorld } from './tools'

/**
 * Ms Scribe's navigation (F-16.24, F-16.25; plan P3 §4.3, design §2.6): what one v2 chat message
 * gets before the answer. A typed action needs no request (`localRoute`). Then Step 0 (local): a
 * question the memory answers is an **instant card** with no AI call, after reading the latest
 * change first when an unread sentence bears on it (one reader request, *Read now*'s path); a stale
 * or contested value goes to Ms Scribe as a lookup turn with that slot's evidence, with no
 * navigator call (P3-D5). Otherwise `navigator.v1` (fast, at most three steps): its first step
 * picks route.v2's action (P3-D7: settled by `settleRoute` and `routeForMemory`, so F-5.26's edit
 * passes and every other route action run as before) and the turn's kind; for a chat message or a
 * question it calls the tools (`tools.ts`) and names the evidence to use. The answer turn carries
 * the navigation (the evidence keys, the scope, the words and every paragraph returned): main keeps
 * nothing between this and `ai:agent` (P3-D1). With the navigator switched off, a message is
 * answered from Step 0's evidence (as v1's router off falls back to chat). An unreadable first
 * step never costs the author the turn: Step 0's evidence answers. Nothing here writes but the
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
 * The turn's kind from its words, for a navigation whose first step named none: an edit for a
 * change or a sheet line, an idea turn for an idea question, else an answer.
 */
export function turnOfWords(cues: Step0['cues']): ScribeTurnKind {
  if (cues.change || cues.sheetWrite) return 'edit'
  return cues.idea ? 'idea' : 'answer'
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

/**
 * The instant answer (P3-D2–D5), or null when the question has no instant shape: the card; the
 * latest change read first and then the card (its cost on it); or a lookup turn for Ms Scribe
 * with the slot's evidence and Step 0's (no navigator call). A read the reader cannot make now
 * (Use AI, the reading switch, a pause, a refusal) hands over too: E0 has the change.
 */
async function instantTurn(
  db: TreeDb,
  reader: NavigateReader,
  step0: Step0,
  caretPara: number | null,
  requestId: string,
  now: Date,
  onStep: (step: AgentStep) => void
): Promise<NavigateResult | null> {
  const shape = step0.shape
  if (shape === null) return null
  const menuKeys = step0.menu.map((item) => item.key)
  const lookup = (keys: readonly EvidenceKey[], spend: Spend): NavigateResult => ({
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
    ...spend
  })
  let outcome = instantCard(db, shape, step0.nowId, { caretPara })
  let spent = 0
  let readFirst = false
  if ('readFirst' in outcome) {
    readFirst = true
    onStep({ tool: 'read', label: READING_FIRST })
    for (const [n, nodeId] of outcome.readFirst.entries()) {
      // The change was saved a moment ago, before the anchors job could look: a fact whose
      // sentence changed goes stale first, so the read re-checks it (P2a-D23 deletes what it does
      // not revive) instead of leaving the old value to go stale after it and contest the new.
      runAnchors(db, nodeId, now)
      const read = await reader.readNow(nodeId, readFirstRequestId(requestId, n + 1))
      if (read.ok) spent += read.costUsd
      if (!read.ok || (!read.read && read.reason !== 'upToDate')) {
        return lookup([], { ...NONE, costUsd: spent })
      }
    }
    // Read: the claims are the new ones; never read again (a window it could not read never loops).
    outcome = instantCard(db, shape, step0.nowId, { caretPara, checkUnread: false })
  }
  const spend: Spend = { ...NONE, costUsd: spent }
  if ('card' in outcome) {
    const card: InstantCard = readFirst
      ? { ...outcome.card, readFirst: { costUsd: spent } }
      : outcome.card
    return { kind: 'instant', card, ...spend }
  }
  if ('readFirst' in outcome) return lookup([], spend)
  return lookup(outcome.keys, spend)
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
  const instant = await instantTurn(db, reader, step0, caretPara, requestId, deps.now(), onStep)
  if (instant !== null) return instant

  const answer = (
    action: 'chat' | 'query',
    navigation: Navigation | null,
    routedBy: 'local' | 'model',
    spend: Spend,
    steps: AgentStep[] = [],
    skipped = 0
  ): NavigateResult => ({ kind: 'answer', action, navigation, routedBy, steps, skipped, ...spend })

  // The navigator off: Step 0's evidence answers (as v1's router off falls back to chat).
  if (!isFeatureAllowed(settings, 'navigator')) return answer('chat', null, 'local', NONE)

  const frame = evidenceFrame(db, step0.nowId)
  const world: NavigatorWorld = {
    project: loadAgentProject(db, input.nodeId, 'v2'),
    frame,
    ask: askIndexOf(db),
    step0,
    menu: new EvidenceMenu(frame, { items: step0.menu, hits: step0.hits }),
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
  const menuLines = step0.menu.map((item) => ({
    id: item.id,
    label: item.label,
    ref: item.ref,
    snippet: item.snippet
  }))

  const outer = input.requestId === undefined ? null : registerInflight(input.requestId)
  let current: string | null = null
  const stop = (): void => {
    if (current !== null) cancelInflight(current)
  }
  outer?.signal.addEventListener('abort', stop)
  const spend: Spend = {
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    cached: true,
    model: null
  }
  const steps: AgentStep[] = []
  const turns: NavigatorStepTurn[] = []
  let action: 'chat' | 'query' = 'chat'
  let turn: ScribeTurnKind | null = null
  let use: string[] | null = null
  let skipped = 0
  try {
    for (let n = 1; n <= NAVIGATOR_STEPS; n++) {
      if (outer?.signal.aborted === true) throw new AiCancelledError('The request was stopped.')
      const prompt = buildNavigatorPrompt({ prefix, tail, menu: menuLines, steps: turns })
      current = navigatorRequestId(requestId, n)
      let text: string
      try {
        const reply = await runAiRequest(deps, {
          feature: 'navigator',
          tier: 'fast',
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          json: true,
          contextHash: sha256(JSON.stringify(prompt.messages)),
          promptVersion: prompt.version,
          ...(input.requestId === undefined ? {} : { requestId: current })
        })
        spend.usage.inputTokens += reply.usage.inputTokens
        spend.usage.outputTokens += reply.usage.outputTokens
        spend.costUsd += reply.costUsd
        spend.cached &&= reply.cached
        spend.model = reply.model
        text = reply.text
      } catch (err) {
        // A later step that fails answers from what was found; the first one, or a stop, does not.
        if (n === 1 || !(err instanceof AiProviderError) || err instanceof AiCancelledError)
          throw err
        break
      } finally {
        current = null
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
        turn = step.turn
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
  } finally {
    outer?.signal.removeEventListener('abort', stop)
    if (input.requestId !== undefined) releaseInflight(input.requestId)
  }

  // The evidence: what `use` named, in its order; else the whole menu by rank.
  const byId = new Map(world.menu.items.map((item) => [item.id, item.key]))
  const used = (use ?? []).flatMap((id) => {
    const key = byId.get(id)
    return key === undefined ? [] : [key]
  })
  const keys = used.length > 0 ? used : world.menu.items.map((item) => item.key)
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
  const navigation: Navigation = {
    turn: turn ?? turnOfWords(step0.cues),
    evidence: distinct(keys),
    scope,
    terms: [...new Set([...world.terms, ...step0.terms])].slice(0, NAVIGATION_TERMS_MAX),
    hits: world.menu.hits.slice(0, NAVIGATION_HITS_MAX)
  }
  return answer(action, navigation, 'model', spend, steps, skipped)
}
