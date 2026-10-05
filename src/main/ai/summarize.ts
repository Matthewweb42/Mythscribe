import { z } from 'zod'
import { findQuote } from '@shared/critique'
import { toEntityNameKey } from '@shared/entities'
import {
  ExtractedFact,
  factKey,
  isObservedAttribute,
  OBSERVED_FACT_QUOTE_MAX,
  OBSERVED_FACT_VALUE_MAX
} from '@shared/observedFacts'
import { parseStoredSceneMeta, promptSceneMeta, type PromptSceneMeta } from '@shared/sceneMeta'
import { toTagName } from '@shared/tags'
import {
  SUMMARY_CHARACTER_MAX,
  SUMMARY_CHARACTERS_MAX,
  SUMMARY_FACTS_MAX,
  SUMMARY_KEY_POINT_MAX,
  SUMMARY_KEY_POINTS_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_SCENE_CHAR_BUDGET,
  SUMMARY_TAGS_MAX,
  SUMMARY_TEXT_MIN,
  ExtractedTag,
  type SceneSummary,
  type StoredSceneSummary
} from '@shared/summary'
import { deleteSummary, getSummary, summariesFor, upsertSummary } from '../document/summaryStore'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { documentText, manuscriptDocuments } from '../voice/profile'
import { applyAutoTags, bankTagNames, type AutoTagsChange } from './autoTags'
import { headTruncate } from './context/chatContext'
import { assertFeatureAllowed } from './dial'
import {
  applyObservedFacts,
  knownNames,
  type KnownNames,
  type ObservedFactsChange
} from './observedFacts'
import { buildSummaryPromptV3, SUMMARY_PROMPT_V3_VERSION } from './prompts/summary.v3'
import { AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/**
 * The scene-summary use case (F-5.6). It runs in the background, so it is deliberately quiet
 * and cheap: the gate first (`summary` must be allowed), then the node must be a manuscript
 * document holding at least `SUMMARY_TEXT_MIN` characters, then exactly the context the
 * data-sharing panel lists — the scene head-truncated to `SUMMARY_SCENE_CHAR_BUDGET`, its
 * metadata line, and the story-bible names the scene contains so they are spelled the author's
 * way.
 *
 * Invalidation is by content hash, never by time (CLAUDE.md, token efficiency rule 4): a
 * stored row made from the same hash by the same prompt version is answered without a
 * request at all, so a save that changed nothing the summary saw costs nothing. The answer is
 * JSON on the `fast` tier (token rule 1) and is stored, not proposed: a summary is derived
 * index data, nothing enters the manuscript, and its cost lives in the usage ledger alone.
 *
 * F-5.16: the same request logs the automatic story bible. The answer's `facts` are checked one
 * by one (`parseSummaryAnswer`: an attribute outside its kind's list or a quote that is not in
 * the scene as sent is dropped and counted — no fact without a passage) and stored with the
 * summary in one transaction (`applyObservedFacts`), apart from the author's own sheets
 * (author-control rule 1). A scene that loses its summary loses its facts with it.
 *
 * F-4.13: and the same request tags the scene. The answer's `tags` are applied as `ai` links in
 * that transaction (`applyAutoTags`), apart from the author's own links, and go with the
 * summary too. The bank names the prompt lists are outside the content hash on purpose (see
 * `bankTagNames`).
 */

const BAD_FORMAT = 'The model did not answer in the expected format.'

/** What the request was built from; the handler reuses it to tell a stale row from a current one. */
export interface SummarySource {
  /** The scene text as it is sent: head-truncated to the budget. */
  sceneText: string
  /** The scene's full plain-text length, before the truncation. */
  length: number
  truncated: boolean
  /** The scene's metadata when any field is set, else null. */
  meta: PromptSceneMeta | null
  /** The story-bible names the scene contains, by kind, capped for the prompt (F-5.16). */
  known: KnownNames
  /** sha256 over everything that shapes the messages; a different hash means a stale row. */
  contentHash: string
}

/**
 * Everything a summary of `nodeId` would be made from, or null when the node is not a
 * manuscript document (front and end matter, folders, an unknown id): those never carry a
 * summary, so `summary:get` answers `UNAVAILABLE_SUMMARY` for them. One owner for the hash,
 * so the staleness check and the run can never disagree about what "unchanged" means. Of the
 * story bible the hash covers only the names the scene contains (`knownNames`), so an entity
 * created for one scene leaves every scene that does not name it current.
 */
export function summarySource(db: TreeDb, nodeId: string): SummarySource | null {
  const row = manuscriptDocuments(db).find((document) => document.id === nodeId)
  if (row === undefined) return null

  const fullText = documentText(row).trim()
  const sceneText = headTruncate(fullText, SUMMARY_SCENE_CHAR_BUDGET)
  const stored = parseStoredSceneMeta(row.sceneMeta)
  const meta = promptSceneMeta(stored)
  const known = knownNames(db, sceneText)

  return {
    sceneText,
    length: fullText.length,
    truncated: fullText.length > SUMMARY_SCENE_CHAR_BUDGET,
    meta,
    known,
    contentHash: sourceHash(sceneText, meta, known)
  }
}

/** The hash of what shapes the messages: the text as sent, the metadata line, and the known names. */
function sourceHash(sceneText: string, meta: PromptSceneMeta | null, known: KnownNames): string {
  return sha256(
    JSON.stringify({
      sceneText,
      // Only the three metadata fields the prompt renders: an edited brief must not cost a rerun.
      meta:
        meta === null ? null : { location: meta.location, pov: meta.pov, timeline: meta.timeline },
      known
    })
  )
}

/**
 * Every manuscript document that should have a summary and does not have a current one
 * (F-5.13, "Summarize all scenes"): long enough to be worth summarising, and either no stored
 * row, a row made from different text, or one from an older prompt version. In reading order,
 * so the queue works through the book from the front. The staleness test is `summarySource`'s
 * hash, the same one `summary:get` shows as "Out of date", so the button and the pane can
 * never disagree; a scene whose hash still matches is left alone and costs nothing.
 */
export function staleSummaryNodeIds(db: TreeDb): string[] {
  const rows = manuscriptDocuments(db)
  const stored = summariesFor(
    db,
    rows.map((row) => row.id)
  )
  const stale: string[] = []
  for (const row of rows) {
    const source = summarySource(db, row.id)
    if (source === null || source.length < SUMMARY_TEXT_MIN) continue
    const current = stored.get(row.id)
    if (
      current?.contentHash === source.contentHash &&
      current.promptVersion === SUMMARY_PROMPT_V3_VERSION
    ) {
      continue
    }
    stale.push(row.id)
  }
  return stale
}

export interface SummarizeSceneInput {
  nodeId: string
  /**
   * The caller's id for `ai:cancel` (F-5.10). A background job carries the queue's own
   * `job-<n>` (F-5.13), so Cancel can stop it too; `ai:summarize` passes the renderer's.
   */
  requestId?: string
  /**
   * Told what the run did to the story bible (F-5.16) whenever it changed anything — the facts
   * stored after a request, or the facts cleared with the summary of a scene cut back under the
   * minimum, which is answered by a throw and so cannot carry them — so the handler can tell
   * the windows. Not called for a run that touched nothing.
   */
  onFactsChanged?: (change: ObservedFactsChange) => void
  /** Told which tags the run linked, dropped, or created (F-4.13), under the same rule. */
  onTagsChanged?: (change: AutoTagsChange) => void
}

export interface SummarizeSceneResult {
  /** The row as it now stands, fresh or served from the content-hash match. */
  summary: StoredSceneSummary
  usage: CompletionUsage
  costUsd: number
  /** True for a stored row answered without a request, or a local response-cache hit. */
  cached: boolean
  model: string
  promptVersion: string
  /** Facts of the answer that were not stored (F-5.16): bad shape, unknown attribute, no passage, a dismissed name. */
  droppedFacts: number
}

export async function summarizeScene(
  db: TreeDb,
  deps: AiRequestDeps,
  input: SummarizeSceneInput
): Promise<SummarizeSceneResult> {
  assertFeatureAllowed(getAiSettings(db), 'summary')

  const source = summarySource(db, input.nodeId)
  if (source === null) {
    throw new AppError('VALIDATION', 'Only a scene in the manuscript can be summarised', {
      nodeId: input.nodeId
    })
  }
  if (source.length < SUMMARY_TEXT_MIN) {
    // A scene cut back below the gate keeps no summary: a stale one would state what is gone.
    // Its observed facts go with it for the same reason (hidden ones stay, as tombstones), and
    // so do the tags the job applied (F-4.13); the author's own links stay.
    const cleared = db.transaction((tx) => {
      deleteSummary(tx, input.nodeId)
      return {
        facts: applyObservedFacts(tx, input.nodeId, []),
        tags: applyAutoTags(tx, input.nodeId, [], '')
      }
    })
    if (cleared.facts.entityIds.length > 0) input.onFactsChanged?.(cleared.facts)
    if (cleared.tags.moved.length > 0) input.onTagsChanged?.(cleared.tags)
    throw new AppError(
      'VALIDATION',
      `Write at least ${SUMMARY_TEXT_MIN} characters in this scene before summarising it`,
      { nodeId: input.nodeId, length: source.length }
    )
  }

  const stored = getSummary(db, input.nodeId)
  if (
    stored !== null &&
    stored.contentHash === source.contentHash &&
    stored.promptVersion === SUMMARY_PROMPT_V3_VERSION
  ) {
    return {
      summary: stored,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      cached: true,
      model: stored.model,
      promptVersion: stored.promptVersion,
      droppedFacts: 0
    }
  }

  const prompt = buildSummaryPromptV3({
    sceneText: source.sceneText,
    meta: source.meta,
    known: source.known,
    bank: bankTagNames(db)
  })
  const result = await runAiRequest(deps, {
    feature: 'summary',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: source.contentHash,
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })

  const parsed = parseSummaryAnswer(result.text, source.sceneText)
  // The summary and the scene's facts land together or not at all. The facts go first because
  // they may create entities, and an entity made from this very answer is a name the scene
  // contains: the row is stamped with the hash of the text that was sent and the names as they
  // stand now, or the run would mark its own scene "Out of date" and pay for it twice. Only
  // when the names had not moved while the request was out: a name the author added meanwhile
  // was never sent, so the row keeps the hash of what was and reads as out of date.
  // The tags (F-4.13) follow the facts for the same reason: a name tag the job creates is a
  // known name of this scene from then on.
  const { summary, change, tagged } = db.transaction((tx) => {
    const unchanged =
      sourceHash(source.sceneText, source.meta, knownNames(tx, source.sceneText)) ===
      source.contentHash
    const applied = applyObservedFacts(tx, input.nodeId, parsed.facts)
    const tags = applyAutoTags(tx, input.nodeId, parsed.tags, source.sceneText)
    const row: StoredSceneSummary = {
      ...parsed.summary,
      nodeId: input.nodeId,
      contentHash:
        (applied.created.length === 0 && tags.created.length === 0) || !unchanged
          ? source.contentHash
          : sourceHash(source.sceneText, source.meta, knownNames(tx, source.sceneText)),
      promptVersion: prompt.version,
      model: result.model,
      truncated: source.truncated,
      createdAt: deps.now().toISOString()
    }
    upsertSummary(tx, row)
    return { summary: row, change: applied, tagged: tags }
  })
  if (change.entityIds.length > 0 || change.created.length > 0) input.onFactsChanged?.(change)
  if (tagged.moved.length > 0) input.onTagsChanged?.(tagged)

  return {
    summary,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version,
    droppedFacts: parsed.droppedFacts + change.skipped
  }
}

/** The shape the prompt asks for; every field is read as unknown so one bad list is not a failure. */
const ModelAnswer = z.object({
  summary: z.unknown().optional(),
  keyPoints: z.unknown().optional(),
  characters: z.unknown().optional(),
  facts: z.unknown().optional(),
  tags: z.unknown().optional()
})

/** One tag as the model may answer it, before the name is trimmed and the category checked. */
const ModelTag = z.object({ name: z.string(), category: z.string() })

/** One fact as the model may answer it: the five strings, before they are trimmed, cut, and checked. */
const ModelFact = z.object({
  entity: z.string(),
  kind: z.string(),
  attribute: z.string(),
  value: z.string(),
  quote: z.string()
})

/** What an answer yields: the summary to store, the facts that passed every check, and how many did not. */
export interface ParsedSummaryAnswer {
  summary: SceneSummary
  facts: ExtractedFact[]
  droppedFacts: number
  /** The tags to apply (F-4.13): shaped, deduped by tag name, and capped; resolved against the bank later. */
  tags: ExtractedTag[]
}

/**
 * The model's `{ summary, keyPoints, characters, facts }`: PROVIDER when the answer is not
 * JSON, not an object, or carries no summary — a row with nothing to say is worse than no row.
 * The two lists are lenient, because a dropped key point costs the author nothing: anything
 * that is not a string goes, each entry is trimmed and cut to its cap, blanks and
 * case-insensitive duplicates go, and the rest is capped in count.
 *
 * The facts (F-5.16) are lenient the same way, and strict about grounding: `sceneText` is the
 * scene as it was sent, and a fact whose quote `findQuote` cannot find in it is dropped — no
 * fact without a passage. Also dropped, and counted with it: an entry that is not the five
 * strings, a blank field, a kind that is not one of the three, an attribute outside its kind's
 * list (`isObservedAttribute`), and a name over the entity cap. The value and the quote are cut
 * to their caps first. A statement given twice (same kind, name, and `factKey`) is kept once,
 * uncounted, and the list is capped at `SUMMARY_FACTS_MAX`.
 *
 * The tags (F-4.13) are lenient too: an entry that is not a name and a known category, a name
 * that kebab-cases to nothing or runs over the tag cap, and a repeat of the same tag name are
 * dropped silently, and the list is capped at `SUMMARY_TAGS_MAX`.
 */
export function parseSummaryAnswer(text: string, sceneText: string): ParsedSummaryAnswer {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)

  const raw = answer.data.summary
  const summary = typeof raw === 'string' ? raw.trim().slice(0, SUMMARY_MAX_CHARS).trim() : ''
  if (summary.length === 0) throw new AiFallbackError(BAD_FORMAT)

  return {
    summary: {
      summary,
      keyPoints: cleanList(answer.data.keyPoints, SUMMARY_KEY_POINT_MAX, SUMMARY_KEY_POINTS_MAX),
      characters: cleanList(answer.data.characters, SUMMARY_CHARACTER_MAX, SUMMARY_CHARACTERS_MAX)
    },
    ...cleanFacts(answer.data.facts, sceneText),
    tags: cleanTags(answer.data.tags)
  }
}

function cleanTags(value: unknown): ExtractedTag[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tags: ExtractedTag[] = []
  for (const entry of value) {
    if (tags.length === SUMMARY_TAGS_MAX) break
    const shaped = ModelTag.safeParse(entry)
    if (!shaped.success) continue
    const tag = ExtractedTag.safeParse({
      name: shaped.data.name.trim(),
      category: shaped.data.category.trim()
    })
    if (!tag.success) continue
    const key = toTagName(tag.data.name)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    tags.push(tag.data)
  }
  return tags
}

function cleanFacts(
  value: unknown,
  sceneText: string
): Pick<ParsedSummaryAnswer, 'facts' | 'droppedFacts'> {
  if (!Array.isArray(value)) return { facts: [], droppedFacts: 0 }
  const seen = new Set<string>()
  const facts: ExtractedFact[] = []
  let droppedFacts = 0
  for (const entry of value) {
    if (facts.length === SUMMARY_FACTS_MAX) break
    const shaped = ModelFact.safeParse(entry)
    const fact = shaped.success
      ? ExtractedFact.safeParse({
          entity: shaped.data.entity,
          kind: shaped.data.kind.trim().toLowerCase(),
          attribute: shaped.data.attribute.trim().toLowerCase(),
          value: shaped.data.value.trim().slice(0, OBSERVED_FACT_VALUE_MAX),
          quote: shaped.data.quote.trim().slice(0, OBSERVED_FACT_QUOTE_MAX)
        })
      : null
    if (
      !fact?.success ||
      !isObservedAttribute(fact.data.kind, fact.data.attribute) ||
      !findQuote(sceneText, fact.data.quote)
    ) {
      droppedFacts += 1
      continue
    }
    const key = [
      fact.data.kind,
      toEntityNameKey(fact.data.entity),
      factKey(fact.data.attribute, fact.data.value)
    ].join('\u0000')
    if (seen.has(key)) continue
    seen.add(key)
    facts.push(fact.data)
  }
  return { facts, droppedFacts }
}

function cleanList(value: unknown, itemMax: number, countMax: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const kept: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const cleaned = entry.trim().slice(0, itemMax).trim()
    if (cleaned.length === 0) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(cleaned)
    if (kept.length === countMax) break
  }
  return kept
}
