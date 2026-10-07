import { z } from 'zod'
import { AI_NEXT_STEP, estimateTokens, inputBudget } from '@shared/ai'
import { findQuote, normalizeForMatch } from '@shared/critique'
import { docToText } from '@shared/docText'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  chunkText,
  DEVELOPMENTAL_CATEGORIES,
  EDIT_PASS_CHUNK_CHARS,
  EDIT_PASS_MAX_ITEMS,
  EDIT_PASS_NOTE_MAX,
  EDIT_PASS_QUOTE_MAX,
  EDIT_PASS_RATIONALE_MAX,
  EDIT_PASS_REPLACEMENT_MAX,
  EDIT_PASS_TEXT_MIN,
  EDIT_PASS_TIER,
  passChangesText,
  type DevelopmentalCategory,
  type EditPassSummary,
  type EditPassType
} from '@shared/editPass'
import { JOB_BACKOFF_MS } from '@shared/jobs'
import { getDocumentContent } from '../document/documentStore'
import { getSceneMeta } from '../document/sceneMetaStore'
import {
  createPass,
  doneNodeIds,
  getPassRow,
  insertChanges,
  passNodeIds,
  requirePass,
  toSummary,
  updatePass,
  type ChangeInput
} from '../editPass/editPassStore'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import { projectNameWords, projectSpellingWords } from '../spellcheck/projectWords'
import { getNode, type TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, voiceProfileVersion } from '../voice/profile'
import { voiceBlock } from '../voice/voiceBlock'
import { headTruncate } from './context/chatContext'
import { continuityRefs } from './continuity'
import { scoreFix } from './critique'
import { assertFeatureAllowed } from './dial'
import { cancelInflight } from './inflight'
import { isCorrection, keepList } from './proofread'
import { continuityRefLine } from './prompts/continuity.v1'
import { buildEditPassPrompt, EDIT_PASS_PROMPT_VERSION } from './prompts/editPass.v1'
import { createProposal } from './proposalStore'
import {
  AiCancelledError,
  AiFallbackError,
  AiProviderError,
  type AiMessage,
  type CompletionUsage
} from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/**
 * Edit passes (F-14.15), main side. A pass is a list of scenes the runner reads one at a time,
 * in reading order, each split at paragraph breaks into pieces of `EDIT_PASS_CHUNK_CHARS`; every
 * piece is one request through the request path (ledger row, cache, caps) on the pass's tier as
 * JSON. What survives `parseEditChanges` / `parseEditNotes` is written as `edit_change` rows the
 * moment a scene is finished, with one proposal (F-14.5) per scene, so a cancel or a crash keeps
 * every finished scene and Resume picks up the rest. Nothing here touches the manuscript: the
 * renderer applies a change when the author accepts it.
 *
 * Not the F-5.13 index queue: a pass is one foreground job the author started, watched, and can
 * stop, with its own progress and its own failure (no silent retries for hours); like the import
 * structure pass (F-12.3) it is a dedicated serial loop.
 */

/** A change as main kept it, before it is scored. */
interface ParsedChange {
  original: string
  replacement: string
  rationale: string
  /** Where the quote starts in the normalized scene, for order and overlap. */
  at: number
}

/** A developmental note as main kept it. */
interface ParsedNote {
  original: string
  rationale: string
  category: DevelopmentalCategory
  at: number
}

const ChangeAnswer = z.object({ changes: z.array(z.unknown()) })
const ChangeItem = z.object({
  quote: z.string(),
  replacement: z.string(),
  why: z.string().nullish()
})
const NoteAnswer = z.object({ notes: z.array(z.unknown()) })
const NoteItem = z.object({
  category: z.string().nullish(),
  quote: z.string(),
  note: z.string()
})

const BAD_FORMAT = 'The model did not answer in the expected format.'

/** A line break inside a quote or a replacement: changes stay inside one paragraph. */
const LINE_BREAK = '\n'

function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new AiFallbackError(BAD_FORMAT, parsed.error)
  return parsed.data
}

/** Where a quote occurs in the normalized scene, or -1 unless it occurs exactly once. */
function onlyOccurrence(scene: string, quote: string): number {
  const needle = normalizeForMatch(quote)
  if (needle === '') return -1
  const at = scene.indexOf(needle)
  if (at < 0 || scene.includes(needle, at + 1)) return -1
  return at
}

/**
 * The model's `{ changes: [...] }` against the piece that was sent and the saved scene: PROVIDER
 * when the answer is not that shape at all, lenient item by item otherwise. Dropped and counted:
 * a replacement equal to the quote; a quote not in the piece sent; a quote not exactly once in
 * the scene (so the editor finds the right passage); a quote or replacement spanning a paragraph
 * break or over its cap; an overlap with a change kept before it (`taken`, shared across the
 * scene's pieces). A proofread also drops anything larger than a correction or that only
 * "corrects" a keep word (`isCorrection`, F-14.12's rule).
 */
export function parseEditChanges(
  answer: string,
  sentText: string,
  scene: string,
  options: { type: EditPassType; keep: ReadonlySet<string>; taken: { at: number; end: number }[] }
): { changes: ParsedChange[]; dropped: number } {
  const data = parseJson(answer, ChangeAnswer)
  const changes: ParsedChange[] = []
  let dropped = 0
  for (const entry of data.changes.slice(0, EDIT_PASS_MAX_ITEMS * 2)) {
    const item = ChangeItem.safeParse(entry)
    if (!item.success) continue
    const original = item.data.quote.trim()
    const replacement = item.data.replacement.trim()
    const rationale = (item.data.why ?? '').trim().slice(0, EDIT_PASS_RATIONALE_MAX)
    if (!original) continue
    const at = onlyOccurrence(scene, original)
    const end = at + normalizeForMatch(original).length
    const valid =
      original.length <= EDIT_PASS_QUOTE_MAX &&
      replacement.length <= EDIT_PASS_REPLACEMENT_MAX &&
      !original.includes(LINE_BREAK) &&
      !replacement.includes(LINE_BREAK) &&
      normalizeForMatch(replacement) !== normalizeForMatch(original) &&
      findQuote(sentText, original) &&
      at >= 0 &&
      (options.type !== 'proofread' || isCorrection(original, replacement, options.keep)) &&
      !options.taken.some((other) => at < other.end && other.at < end)
    if (!valid || changes.length >= EDIT_PASS_MAX_ITEMS) {
      dropped += 1
      continue
    }
    options.taken.push({ at, end })
    changes.push({ original, replacement, rationale, at })
  }
  return { changes, dropped }
}

/**
 * The model's `{ notes: [...] }`: each note must cite a passage of the piece sent (and of the
 * scene), inside one paragraph and under the cap; an uncited note is dropped and counted (AI
 * rule 4: no uncited claim reaches the author). An unknown category reads as `other`.
 */
export function parseEditNotes(
  answer: string,
  sentText: string,
  scene: string
): { notes: ParsedNote[]; dropped: number } {
  const data = parseJson(answer, NoteAnswer)
  const notes: ParsedNote[] = []
  let dropped = 0
  for (const entry of data.notes) {
    const item = NoteItem.safeParse(entry)
    if (!item.success) continue
    const original = item.data.quote.trim()
    const rationale = item.data.note.trim().slice(0, EDIT_PASS_NOTE_MAX)
    if (!original || !rationale) continue
    const at = scene.indexOf(normalizeForMatch(original))
    if (
      at < 0 ||
      original.length > EDIT_PASS_QUOTE_MAX ||
      original.includes(LINE_BREAK) ||
      !findQuote(sentText, original) ||
      notes.length >= EDIT_PASS_MAX_ITEMS
    ) {
      dropped += 1
      continue
    }
    const category = DEVELOPMENTAL_CATEGORIES.find((c) => c === item.data.category) ?? 'other'
    notes.push({ original, rationale, category, at })
  }
  return { notes, dropped }
}

export interface EditSceneInput {
  passId: string
  type: EditPassType
  instruction: string | null
  nodeId: string
  /** Prefix for the requests' ids (`ai:cancel` reaches each through the in-flight registry). */
  requestPrefix: string
  signal: AbortSignal
}

export interface EditSceneResult {
  changes: ChangeInput[]
  dropped: number
  usage: CompletionUsage
  costUsd: number
  model: string
  /** Requests sent (0 for a scene too short, or a continuity pass with nothing to check against). */
  requests: number
}

/** Whether the pass type sends the voice block (it writes prose the author keeps). */
const SENDS_VOICE: Record<EditPassType, boolean> = {
  developmental: false,
  line: true,
  copy: true,
  proofread: true,
  continuity: false,
  custom: true
}
/** Whether the pass type sends the keep list (names and dictionary words are its style sheet). */
const SENDS_KEEP: Record<EditPassType, boolean> = {
  developmental: false,
  line: false,
  copy: true,
  proofread: true,
  continuity: false,
  custom: false
}

function promptTokens(messages: AiMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join('\n'))
}

/**
 * Pieces of the scene that each fit the input budget with everything else the prompt carries
 * (token rule 8): the scene is cut at `EDIT_PASS_CHUNK_CHARS`, and a piece whose prompt is still
 * over the budget is cut again at half the size, down to 1,000 characters.
 */
function fitPieces(text: string, build: (piece: string) => AiMessage[]): string[] {
  const budget = inputBudget('editPass')
  const out: string[] = []
  const queue = chunkText(text, EDIT_PASS_CHUNK_CHARS).map((piece) => ({
    piece,
    max: EDIT_PASS_CHUNK_CHARS
  }))
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    if (promptTokens(build(next.piece)) <= budget || next.max <= 1_000) {
      out.push(next.piece)
      continue
    }
    const max = Math.max(1_000, Math.floor(next.max / 2))
    queue.unshift(...chunkText(next.piece, max).map((piece) => ({ piece, max })))
  }
  return out
}

/** One request, retried after a transient failure (rate limit, network, provider) with the queue's backoff. */
async function requestWithRetry(
  deps: AiRequestDeps,
  build: (attempt: number) => Parameters<typeof runAiRequest>[1],
  signal: AbortSignal,
  setInFlight: (id: string | null) => void
): Promise<Awaited<ReturnType<typeof runAiRequest>>> {
  for (let attempt = 0; ; attempt++) {
    const input = build(attempt)
    setInFlight(input.requestId ?? null)
    try {
      return await runAiRequest(deps, input)
    } catch (err) {
      const transient =
        err instanceof AiProviderError &&
        (err.code === 'RATE_LIMIT' || err.code === 'NETWORK' || err.code === 'PROVIDER') &&
        !(err instanceof AiFallbackError)
      const wait = JOB_BACKOFF_MS[attempt]
      if (!transient || wait === undefined || signal.aborted) throw err
      setInFlight(null)
      await delay(wait, signal)
    } finally {
      setInFlight(null)
    }
  }
}

/** Waits `ms` (unref'd, so it never holds the app open), or until the pass is stopped. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** A document's text with a blank line between its paragraphs (empty ones left out). */
export function sceneTextOf(content: TiptapNodeT | null): string {
  if (content === null) return ''
  return docToText(content)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n\n')
}

function stopIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AiCancelledError('The edit pass was stopped.')
}

/**
 * One scene of a pass: read the saved text, cut it into pieces, ask for each, keep what
 * survives the parser, score each replacement with the fidelity check (F-14.7) when the voice
 * block went out, and create the scene's proposal. A scene too short to edit, and a continuity
 * scene with nothing in the story bible to check against, cost nothing and produce nothing.
 */
export async function editScene(
  db: TreeDb,
  deps: AiRequestDeps,
  input: EditSceneInput,
  setInFlight: (id: string | null) => void = () => undefined
): Promise<EditSceneResult> {
  const empty: EditSceneResult = {
    changes: [],
    dropped: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    model: '',
    requests: 0
  }
  const { content } = getDocumentContent(db, input.nodeId)
  // One paragraph per block, a blank line between them: the pieces are cut at those lines.
  const sceneText = sceneTextOf(content)
  if (sceneText.length < EDIT_PASS_TEXT_MIN) return empty
  const scene = normalizeForMatch(sceneText)
  const title = getNode(db, input.nodeId)?.title ?? 'Untitled'

  const pov = getSceneMeta(db, input.nodeId).meta.pov.trim()
  const profile = SENDS_VOICE[input.type] ? buildVoiceProfile(db, { pov: pov || undefined }) : null
  const voice =
    profile === null
      ? null
      : voiceBlock(profile, { text: headTruncate(sceneText, 20_000), pov: pov || null })
  const allKeep = SENDS_KEEP[input.type] ? projectSpellingWords(db) : []
  const keepWords = SENDS_KEEP[input.type] ? keepList([...projectNameWords(db), ...allKeep]) : []
  const keep = new Set(allKeep.map((word) => word.toLocaleLowerCase()))
  const references =
    input.type === 'continuity'
      ? continuityRefs(db, input.nodeId, sceneText).refs.map((ref, at) =>
          continuityRefLine(ref, at + 1)
        )
      : []
  if (input.type === 'continuity' && references.length === 0) return empty

  const build = (piece: string, part: { index: number; count: number }): AiMessage[] =>
    buildEditPassPrompt({
      type: input.type,
      text: piece,
      title,
      part,
      voice,
      keepWords,
      references,
      instruction: input.instruction
    }).messages
  const pieces = fitPieces(sceneText, (piece) => build(piece, { index: 0, count: 2 }))

  const result: EditSceneResult = { ...empty, usage: { inputTokens: 0, outputTokens: 0 } }
  const taken: { at: number; end: number }[] = []
  const kept: (ParsedChange | ParsedNote)[] = []
  const tier = EDIT_PASS_TIER[input.type]
  for (const [index, piece] of pieces.entries()) {
    stopIfCancelled(input.signal)
    const part = { index, count: pieces.length }
    const prompt = buildEditPassPrompt({
      type: input.type,
      text: piece,
      title,
      part,
      voice,
      keepWords,
      references,
      instruction: input.instruction
    })
    const answer = await requestWithRetry(
      deps,
      (attempt) => ({
        feature: 'editPass',
        tier,
        messages: prompt.messages,
        maxTokens: prompt.maxTokens,
        json: true,
        contextHash: sha256(
          JSON.stringify({
            type: input.type,
            instruction: input.instruction,
            piece,
            title,
            part,
            keepWords,
            references,
            voiceVersion: voice === null ? null : voiceProfileVersion()
          })
        ),
        promptVersion: prompt.version,
        requestId: `${input.requestPrefix}:${index}:${attempt}`
      }),
      input.signal,
      setInFlight
    )
    stopIfCancelled(input.signal)
    result.requests += 1
    result.usage.inputTokens += answer.usage.inputTokens
    result.usage.outputTokens += answer.usage.outputTokens
    result.costUsd += answer.costUsd
    result.model = answer.model
    if (input.type === 'developmental') {
      const parsed = parseEditNotes(answer.text, piece, scene)
      kept.push(...parsed.notes)
      result.dropped += parsed.dropped
    } else {
      const parsed = parseEditChanges(answer.text, piece, scene, { type: input.type, keep, taken })
      kept.push(...parsed.changes)
      result.dropped += parsed.dropped
    }
  }
  kept.sort((a, b) => a.at - b.at)

  const scored = voice === null ? null : profile
  const items = kept.map((item, position) => {
    const replacement = 'replacement' in item ? item.replacement : null
    const score = replacement === null || replacement === '' ? null : scoreFix(replacement, scored)
    return {
      passId: input.passId,
      nodeId: input.nodeId,
      kind: passChangesText(input.type) ? ('change' as const) : ('note' as const),
      position,
      original: item.original,
      replacement,
      rationale: item.rationale,
      category: 'category' in item ? item.category : null,
      flagged: score?.flagged ?? false,
      violation: score?.violation ?? null
    }
  })
  const flaggedItem = items.find((item) => item.flagged)
  const proposalId =
    result.requests === 0
      ? null
      : createProposal(db, {
          feature: 'editPass',
          nodeId: input.nodeId,
          promptVersion: EDIT_PASS_PROMPT_VERSION,
          model: result.model,
          promptTokens: result.usage.inputTokens,
          completionTokens: result.usage.outputTokens,
          costUsd: result.costUsd,
          cached: false,
          content: JSON.stringify(items),
          flagged: flaggedItem !== undefined,
          violation: flaggedItem?.violation ?? null,
          regeneratedFrom: null
        }).id
  result.changes = items.map((item) => ({ ...item, proposalId }))
  return result
}

export interface StartEditPassInput {
  type: EditPassType
  instruction: string | null
  nodeIds: readonly string[]
}

export interface EditPassRunnerDeps {
  /** The open project's database, or null while none is open. */
  db: () => TreeDb | null
  /** The request path for that database. */
  requestDeps: (db: TreeDb) => AiRequestDeps
  /** Every change of a pass's state: started, a scene finished, stopped, failed, done. */
  onChange: (summary: EditPassSummary) => void
  now?: () => string
}

export interface EditPassRunner {
  /** Creates and starts a pass; gated like every AI feature, one pass at a time. */
  start: (input: StartEditPassInput) => EditPassSummary
  /** Runs the scenes a stopped or failed pass has not finished. */
  resume: (passId: string) => EditPassSummary
  /** Stops the running pass; its finished scenes stay. */
  cancel: (passId: string) => void
  /** The running pass's id and the scene it is reading, or null. */
  running: () => { passId: string; nodeId: string | null } | null
  /** Forgets the running pass without writing (the project closed under it). */
  clear: () => void
  /** Resolves when the running loop (if any) has finished; for tests. */
  idle: () => Promise<void>
}

/**
 * The one pass runner of the session. The loop reads the project through `db()` at every scene,
 * so a project closed mid-pass stops it without writing into the next one (the pass stays
 * `running` in the closed project and reads as interrupted when it opens again).
 */
export function createEditPassRunner(deps: EditPassRunnerDeps): EditPassRunner {
  const now = deps.now ?? (() => new Date().toISOString())
  let active: {
    passId: string
    nodeId: string | null
    controller: AbortController
    inFlight: string | null
    db: TreeDb
    loop: Promise<void>
  } | null = null

  const emit = (db: TreeDb, passId: string): void => {
    const row = getPassRow(db, passId)
    if (row) deps.onChange(toSummary(db, row, active?.passId === passId ? active.nodeId : null))
  }

  const begin = (db: TreeDb, passId: string): void => {
    const controller = new AbortController()
    const state = {
      passId,
      nodeId: null as string | null,
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
    state.loop = run(state).finally(() => {
      if (active === state) active = null
    })
  }

  const run = async (state: {
    passId: string
    nodeId: string | null
    controller: AbortController
    inFlight: string | null
    db: TreeDb
  }): Promise<void> => {
    const { db, passId, controller } = state
    const live = (): boolean => deps.db() === db && active?.passId === passId
    const row = requirePass(db, passId)
    const done = new Set(doneNodeIds(row))
    let { tokensIn, tokensOut, costUsd, dropped, model } = row
    try {
      for (const [index, nodeId] of passNodeIds(row).entries()) {
        if (done.has(nodeId)) continue
        stopIfCancelled(controller.signal)
        if (!live()) return
        // The author can lower the switch or turn the feature off mid-pass: it stops there.
        assertFeatureAllowed(getAiSettings(db), 'editPass')
        state.nodeId = nodeId
        emit(db, passId)
        let scene: EditSceneResult
        try {
          scene = await editScene(
            db,
            deps.requestDeps(db),
            {
              passId,
              type: row.type,
              instruction: row.instruction,
              nodeId,
              requestPrefix: `edit-${passId}:${index}`,
              signal: controller.signal
            },
            (id) => {
              state.inFlight = id
            }
          )
        } catch (err) {
          // A scene deleted or turned into a folder since the pass started is skipped.
          if (!(err instanceof AppError)) throw err
          scene = {
            changes: [],
            dropped: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            costUsd: 0,
            model: '',
            requests: 0
          }
        }
        if (!live()) return
        done.add(nodeId)
        tokensIn += scene.usage.inputTokens
        tokensOut += scene.usage.outputTokens
        costUsd += scene.costUsd
        dropped += scene.dropped
        if (scene.model) model = scene.model
        db.transaction((tx) => {
          insertChanges(tx, scene.changes)
          updatePass(tx, passId, {
            doneNodeIds: [...done],
            tokensIn,
            tokensOut,
            costUsd,
            dropped,
            model
          })
        })
        emit(db, passId)
      }
      if (!live()) return
      state.nodeId = null
      updatePass(db, passId, { status: 'done', error: null, finishedAt: now() })
    } catch (err) {
      if (!live()) return
      state.nodeId = null
      if (err instanceof AiCancelledError || controller.signal.aborted) {
        updatePass(db, passId, { status: 'cancelled', error: null, finishedAt: now() })
      } else if (err instanceof AiProviderError) {
        updatePass(db, passId, {
          status: 'failed',
          error: `${err.message} ${AI_NEXT_STEP[err.code]}`.trim(),
          finishedAt: now()
        })
      } else {
        updatePass(db, passId, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'The pass stopped unexpectedly.',
          finishedAt: now()
        })
      }
    }
    emit(db, passId)
  }

  const requireDb = (): TreeDb => {
    const db = deps.db()
    if (db === null) throw new AppError('NO_PROJECT', 'No project is open')
    return db
  }

  const refuseWhileRunning = (): void => {
    if (active !== null) {
      throw new AppError(
        'VALIDATION',
        'An edit pass is already running. Stop it or wait for it to finish.'
      )
    }
  }

  return {
    start(input) {
      const db = requireDb()
      refuseWhileRunning()
      assertFeatureAllowed(getAiSettings(db), 'editPass')
      const row = createPass(db, { ...input, now: now() })
      begin(db, row.id)
      return toSummary(db, row, null)
    },
    resume(passId) {
      const db = requireDb()
      refuseWhileRunning()
      assertFeatureAllowed(getAiSettings(db), 'editPass')
      const row = requirePass(db, passId)
      if (row.status === 'done') {
        throw new AppError('VALIDATION', 'That pass has already finished', { passId })
      }
      updatePass(db, passId, { status: 'running', error: null, finishedAt: null })
      begin(db, passId)
      return toSummary(db, requirePass(db, passId), null)
    },
    cancel(passId) {
      if (active?.passId === passId) active.controller.abort()
    },
    running() {
      return active === null ? null : { passId: active.passId, nodeId: active.nodeId }
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
