import { AI_NEXT_STEP, estimateTokens } from '@shared/ai'
import { normalizeForMatch } from '@shared/critique'
import { EDIT_PASS_TEXT_MIN } from '@shared/editPass'
import {
  EDIT_FLOW_DEEP_SLICE_TOKENS,
  EDIT_FLOW_MAX_TOKENS,
  EDIT_FLOW_OUTPUT_RATIO,
  EDIT_FLOW_TIER,
  type EditFlowCategory,
  type EditFlowFamily,
  type EditFlowNoteEdit,
  type EditFlowPlanResult,
  type EditFlowRun,
  type EditFlowSpec
} from '@shared/editFlow'
import type { AgentEdit } from '@shared/agent'
import { getAiSettings } from '../project/settingsStore'
import { projectSpellingWords } from '../spellcheck/projectWords'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, type VoiceProfile } from '../voice/profile'
import { updatePass } from '../editPass/editPassStore'
import { AppError } from '../ipc/errors'
import { scoreFix } from '../ai/critique'
import { assertFeatureAllowed } from '../ai/dial'
import { paragraphsOf, requestWithRetry } from '../ai/editPass'
import { cancelInflight } from '../ai/inflight'
import { buildEditFlowPrompt, type EDIT_FLOW_PROMPT_VERSION } from '../ai/prompts/editFlow.v1'
import { buildEditNotesPrompt, type EDIT_NOTES_PROMPT_VERSION } from '../ai/prompts/editNotes.v1'
import { createProposal, settleProposal } from '../ai/proposalStore'
import { AiCancelledError, AiProviderError, type AiMessage } from '../ai/providers/types'
import { sha256, type AiRequestDeps } from '../ai/request'
import { buildBookMap, buildNotesBlock, namesIn } from '../scribe2/context'
import { loadScribeSources, type ScribeMaterial } from '../scribe2/source'
import { runScribeTool, type ScribeRun } from '../scribe2/tools'
import {
  appendNoteEdits,
  appendOverview,
  createFlowRun,
  flowRunOf,
  insertIssues,
  requireFlowRow,
  setFlowDone,
  type IssueInput
} from './flowStore'
import { parseFlowIssues, parseFlowNotes } from './parse'
import {
  flowFamilies,
  planRequests,
  sliceScenes,
  type FlowRequest,
  type FlowScene,
  type FlowSlice
} from './plan'

/**
 * The edit flow's runs, main side (notes redesign phase 2). A run reads the project once when it
 * starts (`prepareFlow`: the notes, the book map, the scope's scenes cut into slices), then sends
 * its requests one at a time, slice by slice, each through the request path (ledger, cache, caps)
 * as JSON on its depth's tier, retried after a transient failure as an edit pass is. What each
 * request brings back is written at once (issues as `edit_change` rows, the overview, note edits
 * applied through Ms Scribe's own note tools, so each keeps its version for Undo), so a stopped
 * or failed run keeps everything that came back. Like the edit passes, one run at a time, and a
 * project closed mid-run stops it without writing into the next one.
 */

/** A run read from the project, ready to send. */
export interface PreparedFlow {
  spec: EditFlowSpec
  scopeTitle: string
  scenes: FlowScene[]
  slices: FlowSlice[]
  requests: FlowRequest[]
  notes: string
  map: string
  /** Deep on a scene or a chapter: the rest of the book for reference; null otherwise. */
  reference: string | null
  styleGuide: { ref: string; title: string } | null
  material: ScribeMaterial
}

const isFolder = (row: { kind: string; sectionType: string | null } | undefined): boolean =>
  row?.kind === 'folder' && row.sectionType === null

/** Whether `nodeId` sits under the folder `ancestorId`. */
function under(material: ScribeMaterial, nodeId: string, ancestorId: string): boolean {
  const seen = new Set<string>()
  let at = material.project.byId.get(nodeId)?.parentId ?? null
  while (at !== null && !seen.has(at)) {
    if (at === ancestorId) return true
    seen.add(at)
    at = material.project.byId.get(at)?.parentId ?? null
  }
  return false
}

/** The scope's scenes (non-empty ones, in reading order) and its title, or why there are none. */
function scopeOf(
  material: ScribeMaterial,
  spec: EditFlowSpec
): { scenes: FlowScene[]; title: string } {
  const all: FlowScene[] = material.scenes.map((scene) => {
    const row = material.project.byId.get(scene.nodeId)
    const parent = row?.parentId == null ? undefined : material.project.byId.get(row.parentId)
    const chapter = isFolder(parent) ? parent : undefined
    return {
      nodeId: scene.nodeId,
      ref: scene.ref,
      title: scene.title,
      chapterId: chapter?.id ?? null,
      chapterTitle: chapter?.title ?? null,
      text: paragraphsOf(scene.text)
    }
  })
  let picked: FlowScene[]
  let title: string
  const { scope } = spec
  if (scope.kind === 'book') {
    picked = all
    title = 'the whole book'
  } else if (scope.kind === 'scene') {
    const scene = all.find((s) => s.nodeId === scope.nodeId)
    if (scene === undefined) throw new AppError('VALIDATION', 'Open a scene of the manuscript first')
    picked = [scene]
    title = scene.title
  } else {
    const folder = scope.nodeId === null ? undefined : material.project.byId.get(scope.nodeId)
    if (folder === undefined || !isFolder(folder)) {
      throw new AppError('VALIDATION', 'This scene is not in a chapter.')
    }
    picked = all.filter((s) => under(material, s.nodeId, folder.id))
    title = folder.title
  }
  const scenes = picked.filter((scene) => scene.text.length >= EDIT_PASS_TEXT_MIN)
  if (scenes.length === 0) {
    throw new AppError('VALIDATION', 'There is no text to edit there yet.')
  }
  return { scenes, title }
}

/**
 * Deep on a scene or a chapter reads the rest of the book too (the plan's "whole book and notes"):
 * every other scene in reading order while it fits in `budget`, the ones past it named as left
 * out; null when there is no other scene.
 */
function referenceBook(
  material: ScribeMaterial,
  inScope: ReadonlySet<string>,
  budget: number
): string | null {
  const others = material.scenes.filter((scene) => !inScope.has(scene.nodeId))
  if (others.length === 0) return null
  const blocks: string[] = []
  const left: string[] = []
  let used = 0
  for (const scene of others) {
    const block = `### ${scene.ref} ${scene.title}\n${scene.text.trim() || '(empty)'}`
    const cost = estimateTokens(block) + 1
    if (left.length > 0 || used + cost > budget) {
      left.push(scene.ref)
      continue
    }
    used += cost
    blocks.push(block)
  }
  const tail = left.length === 0 ? '' : `\n\n(Left out for length: ${left.join(', ')}.)`
  return `${blocks.join('\n\n')}${tail}`
}

/** Reads the project for a run of `spec`: the scope, its slices and requests, and the prefix. */
export async function prepareFlow(
  db: TreeDb,
  folder: string,
  spec: EditFlowSpec
): Promise<PreparedFlow> {
  const material = await loadScribeSources(db, folder, spec.scope.nodeId)
  const { scenes, title } = scopeOf(material, spec)
  const slices = sliceScenes(scenes, spec.depth)
  const requests = planRequests(slices, flowFamilies(spec.categories))
  // The pages the scope names go whole first when the notes are past their budget.
  const text = scenes.map((scene) => scene.text).join('\n')
  const wanted = new Set(
    material.pages.filter((page) => namesIn(text, page.title, false)).map((page) => page.id)
  )
  const reference =
    spec.depth === 'deep' && spec.scope.kind !== 'book'
      ? referenceBook(
          material,
          new Set(scenes.map((scene) => scene.nodeId)),
          EDIT_FLOW_DEEP_SLICE_TOKENS - Math.max(0, ...slices.map((slice) => slice.tokens))
        )
      : null
  const guide = material.pages.find(
    (page) => page.kind === 'note' && page.title.trim().toLowerCase() === 'style guide'
  )
  return {
    spec,
    scopeTitle: title,
    scenes,
    slices,
    requests,
    notes: buildNotesBlock(material.pages, wanted).text,
    map: buildBookMap(material.scenes),
    reference,
    styleGuide: guide === undefined ? null : { ref: guide.ref, title: guide.title },
    material
  }
}

/** The messages of one request of a prepared run. */
export function flowMessages(
  prep: PreparedFlow,
  request: FlowRequest
): { version: typeof EDIT_FLOW_PROMPT_VERSION | typeof EDIT_NOTES_PROMPT_VERSION; messages: AiMessage[]; maxTokens: number } {
  const slice = prep.slices[request.slice]
  const base = {
    notes: prep.notes,
    map: prep.map,
    reference: prep.reference,
    slice: {
      index: request.slice,
      count: prep.slices.length,
      label: slice?.label ?? prep.scopeTitle
    },
    items: slice?.items ?? []
  }
  if (request.family === 'notes') return buildEditNotesPrompt(base)
  return buildEditFlowPrompt({
    ...base,
    family: request.family,
    checks: prep.spec.categories,
    styleGuide: prep.styleGuide
  })
}

const promptTokens = (messages: readonly AiMessage[]): number =>
  estimateTokens(messages.map((message) => message.content).join('\n'))

/**
 * What the run would send (the price the panel shows before Run): every request as it will be
 * built, its output estimated from the slice by the family's ratio (capped at the request's cap).
 */
export function countFlow(prep: PreparedFlow): EditFlowPlanResult {
  let tokensIn = 0
  let tokensOut = 0
  for (const request of prep.requests) {
    const slice = prep.slices[request.slice]
    tokensIn += promptTokens(flowMessages(prep, request).messages)
    const out = Math.ceil((slice?.tokens ?? 0) * EDIT_FLOW_OUTPUT_RATIO[request.family])
    tokensOut += Math.min(EDIT_FLOW_MAX_TOKENS, out + (request.family === 'developmental' ? 350 : 0))
  }
  return {
    scopeTitle: prep.scopeTitle,
    scenes: prep.scenes.length,
    words: prep.scenes.reduce(
      (sum, scene) => sum + scene.text.split(/\s+/u).filter(Boolean).length,
      0
    ),
    requests: prep.requests.length,
    tokensIn,
    tokensOut
  }
}

/** The categories of the run a family's issues may be filed under. */
function checksOf(spec: EditFlowSpec): EditFlowCategory[] {
  return spec.categories.filter(
    (category) =>
      category === 'continuity' ||
      category === 'plotHoles' ||
      category === 'voice' ||
      category === 'lineSpelling'
  )
}

/** The note edits a batch of Update notes writes applied, through Ms Scribe's own tools. */
function applyNoteWrites(
  run: ScribeRun,
  writes: ReturnType<typeof parseFlowNotes>['writes']
): EditFlowNoteEdit[] {
  const before = run.changes.length
  for (const write of writes) {
    if (write.kind === 'append') {
      runScribeTool(run, 'edit_note', { id: write.page, text: write.text, append: true })
    } else {
      runScribeTool(run, 'create_note', {
        title: write.title,
        folder: write.folder,
        text: write.text
      })
    }
  }
  return run.changes.slice(before).flatMap((change) => {
    const edit: AgentEdit = change.proposal.edit
    return edit.kind === 'notebook' ? [{ edit, undone: false }] : []
  })
}

export interface EditFlowRunnerDeps {
  /** The open project's database, or null while none is open. */
  db: () => TreeDb | null
  /** The open project's folder (the Library's files are read from it). */
  folder: () => string | null
  requestDeps: (db: TreeDb) => AiRequestDeps
  /** Every move of a run: started, a request answered, stopped, failed, done. */
  onChange: (run: EditFlowRun) => void
  /** Note pages Update notes wrote (`notebook:changed`). */
  notebookChanged: (ids: string[]) => void
  now?: () => string
}

export interface EditFlowRunner {
  /** What a run of `spec` would send, for its price; nothing is sent. */
  plan: (spec: EditFlowSpec) => Promise<EditFlowPlanResult>
  /**
   * Starts a run; gated like every AI feature, one run at a time. `automatic` marks a notes update
   * started by leaving a chapter (phase 3), kept apart from the author's own runs.
   */
  start: (spec: EditFlowSpec, options?: { automatic?: boolean }) => Promise<EditFlowRun>
  /** Stops the running run; what came back stays. */
  cancel: (runId: string) => void
  /** The running run's id, or null. */
  running: () => string | null
  /** Forgets the running run without writing (the project closed under it). */
  clear: () => void
  /** Resolves when the running loop (if any) has finished; for tests. */
  idle: () => Promise<void>
}

function stopIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AiCancelledError('The edit run was stopped.')
}

export function createEditFlowRunner(deps: EditFlowRunnerDeps): EditFlowRunner {
  const now = deps.now ?? (() => new Date().toISOString())
  let active: {
    runId: string
    controller: AbortController
    inFlight: string | null
    db: TreeDb
    loop: Promise<void>
  } | null = null

  const emit = (db: TreeDb, runId: string): void => {
    deps.onChange(flowRunOf(db, requireFlowRow(db, runId)))
  }

  const requireProject = (): { db: TreeDb; folder: string } => {
    const db = deps.db()
    const folder = deps.folder()
    if (db === null || folder === null) throw new AppError('NO_PROJECT', 'No project is open')
    return { db, folder }
  }

  const run = async (
    state: NonNullable<typeof active>,
    prep: PreparedFlow
  ): Promise<void> => {
    const { db, runId, controller } = state
    const live = (): boolean => deps.db() === db && active?.runId === runId
    const tier = EDIT_FLOW_TIER[prep.spec.depth]
    const keep = new Set(projectSpellingWords(db, 'v1').map((word) => word.toLocaleLowerCase()))
    const profile: VoiceProfile = buildVoiceProfile(db)
    const sceneNorm = new Map(
      prep.scenes.map((scene) => [scene.nodeId, normalizeForMatch(scene.text)])
    )
    const taken = new Map<string, { at: number; end: number }[]>()
    const notesRun: ScribeRun = {
      db,
      project: prep.material.project,
      pages: prep.material.pages,
      scenes: prep.material.scenes,
      access: { notes: true, prose: false },
      profile: null,
      changes: [],
      used: new Set(),
      notebookChanged: deps.notebookChanged
    }
    const checks = checksOf(prep.spec)
    let tokensIn = 0
    let tokensOut = 0
    let costUsd = 0
    let dropped = 0
    let model = ''
    try {
      for (const [index, request] of prep.requests.entries()) {
        stopIfCancelled(controller.signal)
        if (!live()) return
        // The author can turn Use AI or the feature off mid-run: it stops there.
        assertFeatureAllowed(getAiSettings(db), 'editFlow')
        const prompt = flowMessages(prep, request)
        const answer = await requestWithRetry(
          deps.requestDeps(db),
          (attempt) => ({
            feature: 'editFlow',
            tier,
            messages: prompt.messages,
            maxTokens: prompt.maxTokens,
            json: true,
            contextHash: sha256(JSON.stringify({ tier, messages: prompt.messages })),
            promptVersion: prompt.version,
            requestId: `flow-${runId}:${index}:${attempt}`
          }),
          controller.signal,
          (id) => {
            state.inFlight = id
          }
        )
        stopIfCancelled(controller.signal)
        if (!live()) return
        tokensIn += answer.usage.inputTokens
        tokensOut += answer.usage.outputTokens
        costUsd += answer.costUsd
        model = answer.model
        const slice = prep.slices[request.slice]
        const items = slice?.items ?? []
        const single = new Set(items.map((item) => item.nodeId)).size === 1 ? items[0] : undefined
        const proposalInput = {
          feature: 'editFlow' as const,
          nodeId: single?.nodeId ?? null,
          promptVersion: prompt.version,
          model: answer.model,
          promptTokens: answer.usage.inputTokens,
          completionTokens: answer.usage.outputTokens,
          costUsd: answer.costUsd,
          cached: answer.cached,
          regeneratedFrom: null
        }
        if (request.family === 'notes') {
          const parsed = parseFlowNotes(answer.text)
          const edits = applyNoteWrites(notesRun, parsed.writes)
          dropped += parsed.dropped + (parsed.writes.length - edits.length)
          const proposal = createProposal(db, {
            ...proposalInput,
            content: JSON.stringify(edits.map((entry) => entry.edit)),
            flagged: false,
            violation: null
          })
          // Applied as they came, each with Undo (the notes rule of AI edits, 2026-10-15).
          if (edits.length > 0) settleProposal(db, proposal.id, 'accepted')
          db.transaction((tx) => {
            appendNoteEdits(tx, runId, edits)
            updatePass(tx, runId, { tokensIn, tokensOut, costUsd, dropped, model })
            setFlowDone(tx, runId, index + 1)
          })
        } else {
          const family: Exclude<EditFlowFamily, 'notes'> = request.family
          const parsed = parseFlowIssues(answer.text, {
            family,
            checks,
            items,
            scenes: sceneNorm,
            keep,
            taken
          })
          dropped += parsed.dropped
          const scored = parsed.issues.map((issue) => ({
            issue,
            score: issue.replacement === null || issue.replacement === '' ? null : scoreFix(issue.replacement, profile)
          }))
          const flaggedOne = scored.find((entry) => entry.score?.flagged === true)
          const proposal = createProposal(db, {
            ...proposalInput,
            content: JSON.stringify(parsed.issues),
            flagged: flaggedOne !== undefined,
            violation: flaggedOne?.score?.violation ?? null
          })
          const rows: IssueInput[] = scored.map(({ issue, score }) => ({
            passId: runId,
            nodeId: issue.nodeId,
            kind: issue.replacement === null ? 'note' : 'change',
            position: issue.at,
            original: issue.original,
            replacement: issue.replacement,
            rationale: issue.rationale,
            category: null,
            flagged: score?.flagged ?? false,
            violation: score?.violation ?? null,
            proposalId: proposal.id,
            flowCategory: issue.category
          }))
          const overview =
            parsed.overview === null
              ? null
              : prep.slices.length > 1
                ? `${slice?.label ?? ''}: ${parsed.overview}`
                : parsed.overview
          db.transaction((tx) => {
            insertIssues(tx, rows)
            if (overview !== null) appendOverview(tx, runId, overview)
            updatePass(tx, runId, { tokensIn, tokensOut, costUsd, dropped, model })
            setFlowDone(tx, runId, index + 1)
          })
        }
        emit(db, runId)
      }
      if (!live()) return
      updatePass(db, runId, { status: 'done', error: null, finishedAt: now() })
    } catch (err) {
      if (!live()) return
      if (err instanceof AiCancelledError || controller.signal.aborted) {
        updatePass(db, runId, { status: 'cancelled', error: null, finishedAt: now() })
      } else if (err instanceof AiProviderError) {
        updatePass(db, runId, {
          status: 'failed',
          error: `${err.message} ${AI_NEXT_STEP[err.code]}`.trim(),
          finishedAt: now()
        })
      } else {
        updatePass(db, runId, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'The run stopped unexpectedly.',
          finishedAt: now()
        })
      }
    }
    emit(db, runId)
  }

  const refuseWhileRunning = (): void => {
    if (active !== null) {
      throw new AppError('VALIDATION', 'An edit run is already going. Stop it or wait for it to finish.')
    }
  }

  return {
    async plan(spec) {
      const { db, folder } = requireProject()
      return countFlow(await prepareFlow(db, folder, spec))
    },
    async start(spec, options) {
      const { db, folder } = requireProject()
      refuseWhileRunning()
      assertFeatureAllowed(getAiSettings(db), 'editFlow')
      const prep = await prepareFlow(db, folder, spec)
      // Checked again: another start may have begun while the project was read.
      refuseWhileRunning()
      const row = createFlowRun(db, {
        spec,
        scopeTitle: prep.scopeTitle,
        nodeIds: prep.scenes.map((scene) => scene.nodeId),
        total: prep.requests.length,
        automatic: options?.automatic ?? false,
        now: now()
      })
      const controller = new AbortController()
      const state = {
        runId: row.id,
        controller,
        inFlight: null as string | null,
        db,
        loop: Promise.resolve()
      }
      active = state
      controller.signal.addEventListener(
        'abort',
        () => {
          if (state.inFlight !== null) cancelInflight(state.inFlight)
        },
        { once: true }
      )
      // Every window hears of the run as it starts (an automatic one is not started by a window).
      const started = flowRunOf(db, row)
      deps.onChange(started)
      state.loop = run(state, prep).finally(() => {
        if (active === state) active = null
      })
      return started
    },
    cancel(runId) {
      if (active?.runId === runId) active.controller.abort()
    },
    running() {
      return active?.runId ?? null
    },
    clear() {
      if (active === null) return
      const state = active
      active = null
      state.controller.abort()
    },
    async idle() {
      await active?.loop
    }
  }
}
