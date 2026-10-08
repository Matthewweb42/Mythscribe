import { z } from 'zod'
import { estimateTokens, inputBudget, type Tier } from '@shared/ai'
import { isFeatureAllowed } from '@shared/aiSettings'
import {
  CONTINUITY_FIX_MAX,
  CONTINUITY_MAX_FINDINGS,
  CONTINUITY_QUOTE_MAX,
  CONTINUITY_REF_VALUE_MAX,
  CONTINUITY_REFS_TOKEN_BUDGET,
  CONTINUITY_SCENE_CHAR_BUDGET,
  CONTINUITY_TEXT_MIN,
  CONTINUITY_WHY_MAX,
  continuityDedupeKey,
  type ContinuityFinding,
  type ContinuityOrigin,
  type ContinuityRef
} from '@shared/continuity'
import { findQuote, normalizeForMatch } from '@shared/critique'
import { ENTITY_FIELDS } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import {
  factKey,
  groupFacts,
  observedAttributeLabel,
  type ObservedFact
} from '@shared/observedFacts'
import type { SettledStatus } from '@shared/proposal'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { ageAt, characterBirthYear } from '@shared/timeline'
import type { NodeRow } from '../db/schema'
import { sceneBriefBlock } from '../document/sceneNeighbours'
import { getDocumentContent } from '../document/documentStore'
import { listEntities } from '../entity/entityStore'
import { factsForEntities, factsForNode } from '../entity/observedFactStore'
import { AppError } from '../ipc/errors'
import { getAiSettings, getProjectTimeline } from '../project/settingsStore'
import { listDocumentTags } from '../tag/documentTagStore'
import type { TreeDb } from '../tree/treeStore'
import {
  buildVoiceProfile,
  documentText,
  manuscriptDocuments,
  voiceProfileVersion,
  type VoiceProfile
} from '../voice/profile'
import { voiceBlock } from '../voice/voiceBlock'
import { headTruncate } from './context/chatContext'
import {
  deleteFindings,
  dismissedKeys,
  insertFindings,
  openFindingsForNode,
  proposalFindingStatuses,
  settleFinding,
  type FindingInput
} from './continuityFindingStore'
import { fitSceneToBudget, scoreFix } from './critique'
import { assertFeatureAllowed } from './dial'
import { entitiesNamedIn } from './observedFacts'
import {
  buildContinuityPromptV2,
  CONTINUITY_PROMPT_V2_VERSION,
  continuityRefLineV2,
  type BuiltContinuityPromptV2
} from './prompts/continuity.v2'
import { createProposal, settleProposal } from './proposalStore'
import { AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/**
 * The consistency checker (F-13.4): what a scene states against the story bible. Two paths over
 * one prompt (`continuity.v1`):
 *
 * - **On demand** (`runContinuity`, `Check consistency`): the gate first, then the scene
 *   head-truncated to `CONTINUITY_SCENE_CHAR_BUDGET` and shrunk to fit the input budget, against
 *   every reference, on the `strong` tier (false contradictions cost trust).
 * - **In the background** (`runBackgroundContinuity`, after the summary job stored a scene's
 *   facts): a free local pass first (`localCandidates`): a fact of this scene whose entity and
 *   attribute carry a different value on the sheet or in another scene. No candidate, no
 *   request. With candidates, one `fast` request carrying only the paragraphs that hold a
 *   candidate's passage and only the references it differs from, so most scenes cost nothing and
 *   typing elsewhere in the scene re-sends nothing. It never throws for the dial, a toggle, or
 *   an unreadable answer: a background check that cannot run is simply not run.
 *
 * Never sent: other scenes' text (CLAUDE.md, token rule 2). The other side of a finding is a
 * reference main built itself (`continuityRefs`) and numbered in the prompt, so the model cites
 * it by number and cannot invent it; the scene's side is a quote `findQuote` must locate in the
 * text that was sent. A finding failing either is dropped and counted: no contradiction without
 * two citations. A reference the author dismissed for the scene ("changed in the story") is not
 * sent again, by either path.
 *
 * Findings are derived data (author-control rule 1): stored in `continuity_finding`, never in
 * the manuscript. A fix reaches the text only through the run's proposal (F-14.5), scored by the
 * fidelity check first (F-14.7, locally: the prompt carries no voice profile).
 */

const BAD_FORMAT = 'The model did not answer in the expected format.'

/** The references a scene is checked against, numbered from 1 in this order. */
export interface ContinuityRefs {
  refs: ContinuityRef[]
  /** Whether the token budget left references out. */
  truncated: boolean
  /** This scene's timeline, when the previous scene's is one of the references; else null. */
  timeline: string | null
  /**
   * The computed age at this scene (F-11.2b) per entity id, for the characters whose `age`
   * reference is computed from their birth year and the scene's event year.
   */
  ages: ReadonlyMap<string, number>
}

/** A reference value as sent and stored: one line, cut to `CONTINUITY_REF_VALUE_MAX` with "…". */
function clip(value: string): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return flat.length <= CONTINUITY_REF_VALUE_MAX
    ? flat
    : `${flat.slice(0, CONTINUITY_REF_VALUE_MAX - 1).trimEnd()}…`
}

/**
 * The `age` reference's value when it is computed (F-11.2b): the age, or "not born yet", at the
 * scene, with the birth year and the scene's year it comes from.
 */
export function computedAgeValue(born: number, year: number): string {
  const age = ageAt(born, year)
  return `${age < 0 ? 'not born yet' : String(age)} at this scene (born ${born}, scene year ${year})`
}

/**
 * The author's own statements about one entity: its filled sheet fields, or a blank page as
 * `Notes`. With `age` (a character's computed age at the scene, F-11.2b), the `age` reference
 * carries it in place of the sheet's static age, which cannot be right at every point of the
 * story, or is added where the sheet has none.
 */
function sheetRefs(entity: Entity, age: { born: number; year: number } | null): ContinuityRef[] {
  const base = {
    kind: 'sheet' as const,
    entityId: entity.id,
    entityName: entity.name,
    entityKind: entity.kind,
    nodeId: null,
    quote: null
  }
  if (entity.template === 'blank') {
    const page = clip(entity.body ?? '')
    return page ? [{ ...base, attribute: 'notes', label: 'Notes', value: page }] : []
  }
  return ENTITY_FIELDS[entity.kind].flatMap((field) => {
    const value =
      field.id === 'age' && age !== null
        ? computedAgeValue(age.born, age.year)
        : clip(entity.fields[field.id] ?? '')
    return value ? [{ ...base, attribute: field.id, label: field.label, value }] : []
  })
}

/**
 * What the story bible says about the entities of one scene, in the order the author's word
 * outranks the AI's:
 *
 * 1. `sheet`: every filled field of the entity's own sheet (a blank page as one `Notes` entry).
 * 2. `fact`: every `groupFacts` row read from **other** scenes, with the passage of its earliest
 *    scene; hidden facts never appear, and an attribute the sheet fills is left out, because the
 *    author's sheet wins every conflict (F-14.9).
 * 3. `timeline`: the previous scene's timeline metadata, when both scenes have one.
 *
 * A character with a birth year (`born`) in a scene whose linked event has a year gets its age
 * at the scene as the `age` sheet reference (`computedAgeValue`, F-11.2b); the year comes from
 * the scene's `eventId` on the stored timeline, never from the free-text timeline field.
 *
 * The entities are the ones the scene names (`entitiesNamedIn`), the ones linked to its tags,
 * and the ones it has observed facts about (F-5.16 resolves "Dr Vell" to the sheet's "Dr.
 * Vell"), in story-bible order. A reference whose dedupe key the author dismissed for this scene
 * is left out before anything is counted. The rest is capped at `CONTINUITY_REFS_TOKEN_BUDGET`,
 * measured on the lines the prompt prints, dropping facts first, then the timeline, then sheets
 * (CLAUDE.md, token rule 8). A node outside the manuscript has no references.
 */
export function continuityRefs(db: TreeDb, nodeId: string, sceneText: string): ContinuityRefs {
  const documents = manuscriptDocuments(db)
  const at = documents.findIndex((row) => row.id === nodeId)
  const current = documents[at]
  if (current === undefined) return { refs: [], truncated: false, timeline: null, ages: new Map() }
  const meta = parseStoredSceneMeta(current.sceneMeta)
  const year =
    meta.eventId === undefined
      ? null
      : (getProjectTimeline(db).events.find((event) => event.id === meta.eventId)?.year ?? null)

  const all = listEntities(db)
  const named = new Set(entitiesNamedIn(all, sceneText).map((entity) => entity.id))
  const tagged = new Set(listDocumentTags(db, nodeId).map((tag) => tag.id))
  const stated = new Set(factsForNode(db, nodeId).map((fact) => fact.entityId))
  const entities = all.filter(
    (entity) =>
      named.has(entity.id) ||
      stated.has(entity.id) ||
      (entity.tagId !== null && tagged.has(entity.tagId))
  )

  const dismissed = dismissedKeys(db, nodeId)
  const live = (ref: ContinuityRef): boolean => !dismissed.has(continuityDedupeKey(nodeId, ref))

  const sheets: ContinuityRef[] = []
  const facts: ContinuityRef[] = []
  const ages = new Map<string, number>()
  const groups = groupFacts(
    factsForEntities(
      db,
      entities.map((entity) => entity.id)
    ).filter((fact) => fact.nodeId !== nodeId),
    documents.map((row) => row.id)
  )
  for (const entity of entities) {
    const born =
      entity.kind === 'character' && entity.template === 'structured'
        ? characterBirthYear(entity)
        : null
    const age = born === null || year === null ? null : { born, year }
    if (age !== null) ages.set(entity.id, ageAt(age.born, age.year))
    const sheet = sheetRefs(entity, age)
    // The sheet's own fields decide what the facts may add, dismissed or not.
    const filled = new Set(sheet.map((ref) => ref.attribute))
    sheets.push(...sheet.filter(live))
    for (const group of groups) {
      if (group.entityId !== entity.id || filled.has(group.attribute)) continue
      const source = group.sources[0]
      const ref: ContinuityRef = {
        kind: 'fact',
        entityId: entity.id,
        entityName: entity.name,
        entityKind: entity.kind,
        attribute: group.attribute,
        label: observedAttributeLabel(entity.kind, group.attribute),
        value: clip(group.value),
        nodeId: source?.nodeId ?? null,
        quote: source?.quote ?? null
      }
      if (live(ref)) facts.push(ref)
    }
  }

  const previous = at > 0 ? documents[at - 1] : undefined
  const own = meta.timeline.trim()
  const before = previous ? parseStoredSceneMeta(previous.sceneMeta).timeline.trim() : ''
  const timeline: ContinuityRef[] =
    previous !== undefined && own && before
      ? [
          {
            kind: 'timeline' as const,
            entityId: null,
            entityName: null,
            entityKind: null,
            attribute: null,
            label: 'Timeline',
            value: clip(before),
            nodeId: previous.id,
            quote: null
          }
        ].filter(live)
      : []

  // Token rule 8: count before sending. The number's width barely moves the estimate, so every
  // line is measured under a two-digit one.
  const later = new Set(documents.slice(at + 1).map((row) => row.id))
  const cost = (ref: ContinuityRef): number =>
    estimateTokens(`${continuityRefLineV2(ref, 10, later)}\n`)
  let total = [...sheets, ...facts, ...timeline].reduce((sum, ref) => sum + cost(ref), 0)
  let truncated = false
  const drop = (list: ContinuityRef[]): void => {
    while (total > CONTINUITY_REFS_TOKEN_BUDGET) {
      const last = list.pop()
      if (last === undefined) return
      total -= cost(last)
      truncated = true
    }
  }
  drop(facts)
  drop(timeline)
  drop(sheets)

  return {
    refs: [...sheets, ...facts, ...timeline],
    truncated,
    timeline: timeline.length > 0 ? own : null,
    ages
  }
}

/** One thing worth asking about: a passage of the scene and a reference it may contradict. */
export interface ContinuityCandidate {
  /** The passage the scene's fact was read from. */
  quote: string
  ref: ContinuityRef
}

/**
 * The background run's gate, local and free: every observed fact of the scene (`facts`) against
 * every sheet or fact reference about the same entity and attribute whose value is a different
 * statement (`factKey`: case, spacing, and closing punctuation do not count). It only decides
 * whether a request is worth making and which paragraphs it carries; whether "34" and
 * "thirty-four" really conflict is the model's call. What the fact extractor did not log
 * (dialogue tone, who knows what, the timeline) is never a candidate: `Check consistency` covers
 * those.
 *
 * A character's computed age (`ages`, from `continuityRefs`, F-11.2b) is compared as a number: an
 * `age` fact is a candidate when its first whole number differs from the age at this scene, or
 * when it has none ("about thirty" is the model's call); one stating that number is not.
 */
export function localCandidates(
  facts: readonly ObservedFact[],
  refs: readonly ContinuityRef[],
  ages: ReadonlyMap<string, number> = new Map()
): ContinuityCandidate[] {
  const candidates: ContinuityCandidate[] = []
  for (const fact of facts) {
    if (fact.hidden) continue
    for (const ref of refs) {
      if (ref.kind === 'timeline' || ref.entityId !== fact.entityId) continue
      if (ref.attribute !== fact.attribute) continue
      const age = fact.attribute === 'age' ? ages.get(fact.entityId) : undefined
      if (age !== undefined) {
        if (firstWholeNumber(fact.value) === age) continue
      } else if (factKey(fact.attribute, fact.value) === factKey(fact.attribute, ref.value))
        continue
      candidates.push({ quote: fact.quote, ref })
    }
  }
  return candidates
}

/** The first whole number written in digits in `text`, or null when it has none. */
function firstWholeNumber(text: string): number | null {
  const match = /\d+/u.exec(text)
  return match === null ? null : Number(match[0])
}

/**
 * What a background request carries: the paragraphs of the scene (in order, each once) that hold
 * a candidate's passage, and the references of those candidates in their numbered order. A
 * candidate whose passage is in no single paragraph (the text moved on since the fact was read)
 * is left out; with none left there is nothing to ask.
 */
export function candidateContext(
  sceneText: string,
  candidates: readonly ContinuityCandidate[],
  refs: readonly ContinuityRef[]
): { text: string; refs: ContinuityRef[] } {
  const paragraphs = sceneText.split('\n')
  const held = new Set<number>()
  const cited = new Set<ContinuityRef>()
  for (const candidate of candidates) {
    const at = paragraphs.findIndex((paragraph) => findQuote(paragraph, candidate.quote))
    if (at === -1) continue
    held.add(at)
    cited.add(candidate.ref)
  }
  return {
    text: paragraphs.filter((_, at) => held.has(at)).join('\n'),
    refs: refs.filter((ref) => cited.has(ref))
  }
}

/** A finding as parsed: both citations checked, the fix not yet scored. */
export type ParsedFinding = Pick<FindingInput, 'ref' | 'quote' | 'why' | 'fix'>

const ModelAnswer = z.object({ findings: z.array(z.unknown()) })
const ModelFinding = z.object({
  ref: z.union([z.number(), z.string()]),
  quote: z.string(),
  why: z.string(),
  fix: z.string().nullish()
})

/**
 * The model's `{ findings: [...] }` against what was sent: PROVIDER when the answer is not JSON
 * or not that shape at all, and lenient finding by finding otherwise — one that is not the four
 * fields, or has a blank quote or reason, is skipped, and the strings are trimmed and capped.
 * Then the two-citation rule, each failure dropped and counted: a `ref` that is not the number
 * of a reference that was sent, and a quote `findQuote` cannot locate in `sceneText` (the text
 * as sent). A finding against a reference dismissed for this scene (`dismissed`, the dedupe
 * keys) is dropped and counted too: it was "changed in the story" while the request was out. A
 * blank fix or one equal to the quote is none. Duplicates by reference and quote collapse and
 * the list is capped at `CONTINUITY_MAX_FINDINGS`.
 */
export function parseContinuityAnswer(
  text: string,
  sceneText: string,
  refs: readonly ContinuityRef[],
  skip: { nodeId: string; dismissed: ReadonlySet<string> }
): { findings: ParsedFinding[]; dropped: number } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)

  const findings: ParsedFinding[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of answer.data.findings) {
    const parsed = ModelFinding.safeParse(entry)
    if (!parsed.success) continue
    const quote = parsed.data.quote.trim().slice(0, CONTINUITY_QUOTE_MAX).trim()
    const why = parsed.data.why.trim().slice(0, CONTINUITY_WHY_MAX).trim()
    if (!quote || !why) continue
    const number = Number(parsed.data.ref)
    const ref = Number.isInteger(number) ? refs[number - 1] : undefined
    if (
      ref === undefined ||
      !findQuote(sceneText, quote) ||
      skip.dismissed.has(continuityDedupeKey(skip.nodeId, ref))
    ) {
      dropped += 1
      continue
    }
    const key = `${number}\u0000${normalizeForMatch(quote)}`
    if (seen.has(key)) continue
    seen.add(key)
    const rawFix = (parsed.data.fix ?? '').trim().slice(0, CONTINUITY_FIX_MAX).trim()
    const fix = rawFix && normalizeForMatch(rawFix) !== normalizeForMatch(quote) ? rawFix : null
    findings.push({ ref, quote, why, fix })
    if (findings.length === CONTINUITY_MAX_FINDINGS) break
  }
  return { findings, dropped }
}

/** What one check found, before anything is stored. */
export interface ContinuityRun {
  /** Every finding cites a passage of the text sent and a reference that was sent; fixes are scored. */
  findings: FindingInput[]
  /** Whether the scene or the references were cut before they were sent. */
  truncated: boolean
  /** Findings dropped for a missing citation or a dismissed reference. */
  dropped: number
  /** How many references the prompt carried; 0 means nothing was sent. */
  references: number
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  /** The model that answered; '' when no request was made. */
  model: string
  promptVersion: typeof CONTINUITY_PROMPT_V2_VERSION
  /** Whether a request went out (a local cache hit counts: it is a ledger row). */
  requested: boolean
  /** The scene's whole text when the check ran; a stored finding whose passage left it is stale. */
  fullText: string
}

/** A check that had nothing to ask: no request, no cost, no findings. */
function nothingToCheck(fullText: string, truncated: boolean): ContinuityRun {
  return {
    findings: [],
    truncated,
    dropped: 0,
    references: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    cached: false,
    model: '',
    promptVersion: CONTINUITY_PROMPT_V2_VERSION,
    requested: false,
    fullText
  }
}

interface Prepared {
  prompt: BuiltContinuityPromptV2
  sceneText: string
  truncated: boolean
  contextHash: string
  /** The profile a fix is scored against (F-14.7), or null when the project has no voice block. */
  profile: VoiceProfile | null
}

/**
 * The prompt for `text` and `refs`, the text shrunk until it fits the input budget (token rule
 * 8, `fitSceneToBudget`), and the hash of everything that shaped the messages. The tier joins
 * the hash, so a background answer on the fast tier never stands in for the author's own check.
 */
function prepare(
  db: TreeDb,
  row: NodeRow,
  tier: Tier,
  text: string,
  refs: readonly ContinuityRef[],
  timeline: string | null
): Prepared {
  // AI rule 2: a fix is prose, so the voice block and the brief ride along. The exemplars are
  // chosen once, from the text as first cut, as critique does.
  const pov = parseStoredSceneMeta(row.sceneMeta).pov.trim()
  const profile = buildVoiceProfile(db, { pov: pov || undefined })
  const voice = voiceBlock(profile, {
    text: headTruncate(text, CONTINUITY_SCENE_CHAR_BUDGET),
    pov: pov || null
  })
  const brief = sceneBriefBlock(db, row.id)
  // F-5.23: the scenes after this one, so a fact read from one is labelled as its future.
  const documents = manuscriptDocuments(db).map((document) => document.id)
  const later = new Set(documents.slice(documents.indexOf(row.id) + 1))
  const build = (sceneText: string): BuiltContinuityPromptV2 =>
    buildContinuityPromptV2({ sceneText, references: refs, timeline, voice, brief, later })
  const { sceneText, truncated } = fitSceneToBudget(
    text,
    inputBudget('continuity'),
    (cut) => build(cut).messages,
    { chars: CONTINUITY_SCENE_CHAR_BUDGET, min: CONTINUITY_TEXT_MIN }
  )
  return {
    prompt: build(sceneText),
    sceneText,
    truncated,
    contextHash: sha256(
      JSON.stringify({
        tier,
        sceneText,
        refs,
        later: refs.map((ref) => ref.nodeId !== null && later.has(ref.nodeId)),
        timeline,
        brief,
        voice: voice === null ? null : voiceProfileVersion()
      })
    ),
    profile: voice === null ? null : profile
  }
}

/** The request and its answer, parsed; a fix is scored only when the project has a voice block. */
async function send(
  db: TreeDb,
  deps: AiRequestDeps,
  row: NodeRow,
  tier: Tier,
  prepared: Prepared,
  refs: readonly ContinuityRef[],
  requestId: string | undefined
): Promise<Omit<ContinuityRun, 'truncated' | 'fullText'> & { unparsed: boolean }> {
  const result = await runAiRequest(deps, {
    feature: 'continuity',
    tier,
    messages: prepared.prompt.messages,
    maxTokens: prepared.prompt.maxTokens,
    json: true,
    contextHash: prepared.contextHash,
    promptVersion: prepared.prompt.version,
    ...(requestId === undefined ? {} : { requestId })
  })
  const base = {
    references: refs.length,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prepared.prompt.version,
    requested: true
  }

  let parsed: ReturnType<typeof parseContinuityAnswer>
  try {
    // Read again: a reference dismissed while the request was out must not come back.
    parsed = parseContinuityAnswer(result.text, prepared.sceneText, refs, {
      nodeId: row.id,
      dismissed: dismissedKeys(db, row.id)
    })
  } catch (err) {
    if (tier === 'fast' && err instanceof AiFallbackError) {
      return { ...base, findings: [], dropped: 0, unparsed: true }
    }
    throw err
  }

  let findings: FindingInput[] = parsed.findings.map((finding) => ({
    ...finding,
    flagged: false,
    violation: null
  }))
  if (findings.some((finding) => finding.fix !== null)) {
    findings = findings.map((finding) => ({
      ...finding,
      ...scoreFix(finding.fix, prepared.profile)
    }))
  }
  return { ...base, findings, dropped: parsed.dropped, unparsed: false }
}

export interface ContinuityInput {
  nodeId: string
  /** The caller's id for `ai:cancel` (F-5.10); without one the request cannot be stopped. */
  requestId?: string
}

/**
 * `Check consistency`, on demand (see the file note). DISABLED below Ask or with the toggle off,
 * before anything is read; NOT_FOUND for an unknown id; VALIDATION for a node that is not a
 * manuscript document or holds under `CONTINUITY_TEXT_MIN` characters. With no reference to
 * check against, no request is made and the run is empty at no cost.
 */
export async function runContinuity(
  db: TreeDb,
  deps: AiRequestDeps,
  input: ContinuityInput
): Promise<ContinuityRun> {
  assertFeatureAllowed(getAiSettings(db), 'continuity')

  getDocumentContent(db, input.nodeId)
  const row = manuscriptDocuments(db).find((document) => document.id === input.nodeId)
  if (row === undefined) {
    throw new AppError('VALIDATION', 'Only a scene in the manuscript can be checked', {
      nodeId: input.nodeId
    })
  }
  const fullText = documentText(row).trim()
  if (fullText.length < CONTINUITY_TEXT_MIN) {
    throw new AppError(
      'VALIDATION',
      `Write at least ${CONTINUITY_TEXT_MIN} characters in this scene before checking it`,
      { nodeId: input.nodeId, length: fullText.length }
    )
  }

  const { refs, truncated: refsCut, timeline } = continuityRefs(db, input.nodeId, fullText)
  if (refs.length === 0) return nothingToCheck(fullText, false)

  const prepared = prepare(db, row, 'strong', fullText, refs, timeline)
  const { unparsed: _unparsed, ...sent } = await send(
    db,
    deps,
    row,
    'strong',
    prepared,
    refs,
    input.requestId
  )
  return { ...sent, truncated: prepared.truncated || refsCut, fullText }
}

export interface BackgroundContinuityInput extends ContinuityInput {
  /**
   * The context hash of the last background check per node, kept by the caller for the session.
   * A scene whose candidate paragraphs and references are what they were at the last check is
   * not asked about again: no request, no ledger row, its findings left as they are.
   */
  memo: Map<string, string>
}

/**
 * The quiet check after a scene's facts were stored (see the file note). Null when nothing was
 * done and the stored findings must be left alone: the dial or the toggle forbids it, the node
 * is not a manuscript document, the same context was checked already this session, or the
 * answer could not be read (the request is in the ledger; the summary job is not failed for
 * it). A run with no candidate is answered without a request, so the caller clears what the
 * scene no longer states. Provider failures (rate limit, network, no key, the daily cap, a
 * cancel) are thrown; the summary job's runner drops all but a cancel, so the stored summary
 * never reads as failed because of the check.
 */
export async function runBackgroundContinuity(
  db: TreeDb,
  deps: AiRequestDeps,
  input: BackgroundContinuityInput
): Promise<ContinuityRun | null> {
  if (!isFeatureAllowed(getAiSettings(db), 'continuity')) return null
  const row = manuscriptDocuments(db).find((document) => document.id === input.nodeId)
  if (row === undefined) return null

  const fullText = documentText(row).trim()
  const all = continuityRefs(db, input.nodeId, fullText)
  const context = candidateContext(
    fullText,
    localCandidates(factsForNode(db, input.nodeId), all.refs, all.ages),
    all.refs
  )
  if (context.refs.length === 0) {
    input.memo.delete(input.nodeId)
    return nothingToCheck(fullText, false)
  }

  const prepared = prepare(db, row, 'fast', context.text, context.refs, null)
  if (input.memo.get(input.nodeId) === prepared.contextHash) return null
  const { unparsed, ...sent } = await send(
    db,
    deps,
    row,
    'fast',
    prepared,
    context.refs,
    input.requestId
  )
  input.memo.set(input.nodeId, prepared.contextHash)
  return unparsed ? null : { ...sent, truncated: prepared.truncated, fullText }
}

/** What storing a run left behind. */
export interface StoredContinuityRun {
  /** The scene's open findings as they now stand, oldest first. */
  findings: ContinuityFinding[]
  /** The proposal the new findings' fixes belong to (F-14.5); null when the run added none. */
  proposalId: string | null
  /** Whether any row was removed or added, for `continuity:changed`. */
  changed: boolean
}

/** What two findings are the same contradiction under: the reference and the passage. */
function findingKey(nodeId: string, finding: Pick<FindingInput, 'ref' | 'quote'>): string {
  return `${continuityDedupeKey(nodeId, finding.ref)}\u0000${normalizeForMatch(finding.quote)}`
}

/**
 * How a proposal whose findings are all settled or gone is settled itself (F-14.5), or null
 * while one is still open: `accepted` when every finding was applied, `acceptedPart` when some
 * were, `rejected` when none was, and `regenerated` when a later check replaced them all before
 * the author acted on any (`replaced`: the run removed open findings of this proposal).
 */
function settleFindingsProposal(
  db: TreeDb,
  proposalId: string,
  replaced: boolean
): SettledStatus | null {
  const statuses = proposalFindingStatuses(db, proposalId)
  if (statuses.includes('open')) return null
  const applied = statuses.filter((status) => status === 'applied').length
  const status: SettledStatus =
    applied === 0
      ? replaced && statuses.length === 0
        ? 'regenerated'
        : 'rejected'
      : applied === statuses.length && !replaced
        ? 'accepted'
        : 'acceptedPart'
  return settleProposal(db, proposalId, status) ? status : null
}

/**
 * Stores what a run found, in one transaction. `Check consistency` (`request`) read the whole
 * scene, so it replaces every open finding of the scene. A background run read only the
 * candidate paragraphs, so it replaces the open findings earlier background runs left and
 * removes any other whose passage is no longer in the scene, but keeps what the author's own
 * check found and does not store the same contradiction twice. Dismissed and applied rows are
 * never touched. A run that adds findings records one pending proposal holding them as JSON,
 * flagged when any fix failed the fidelity check, exactly as `ai:critique` does; a proposal
 * whose last open finding was replaced is settled.
 */
export function storeContinuityRun(
  db: TreeDb,
  nodeId: string,
  origin: ContinuityOrigin,
  run: ContinuityRun,
  now: Date
): StoredContinuityRun {
  return db.transaction((tx) => {
    const open = openFindingsForNode(tx, nodeId)
    const gone = open.filter(
      (finding) =>
        origin === 'request' ||
        finding.origin === 'background' ||
        !findQuote(run.fullText, finding.quote)
    )
    const kept = open.filter((finding) => !gone.includes(finding))
    deleteFindings(
      tx,
      gone.map((finding) => finding.id)
    )

    const held = new Set(kept.map((finding) => findingKey(nodeId, finding)))
    const fresh = run.findings.filter((finding) => !held.has(findingKey(nodeId, finding)))
    const flagged = fresh.find((finding) => finding.flagged)
    const proposalId =
      fresh.length === 0
        ? null
        : createProposal(tx, {
            feature: 'continuity',
            nodeId,
            promptVersion: run.promptVersion,
            model: run.model,
            promptTokens: run.usage.inputTokens,
            completionTokens: run.usage.outputTokens,
            costUsd: run.costUsd,
            cached: run.cached,
            content: JSON.stringify(fresh),
            flagged: flagged !== undefined,
            violation: flagged?.violation ?? null,
            createdAt: now.toISOString()
          }).id
    const stored = insertFindings(tx, nodeId, fresh, {
      origin,
      proposalId,
      createdAt: now.toISOString()
    })

    for (const id of new Set(gone.map((finding) => finding.proposalId))) {
      if (id !== null) settleFindingsProposal(tx, id, true)
    }
    return {
      findings: [...kept, ...stored],
      proposalId,
      changed: gone.length > 0 || stored.length > 0
    }
  })
}

/**
 * Settles one finding (`continuity:settle`): `dismissed` keeps it as the tombstone that stops
 * the same contradiction being raised again for the scene, `applied` records that its fix is in
 * the text. When that was the last open finding of its proposal, the proposal is settled too
 * and `proposal` names how, so the handler can count it. NOT_FOUND for an unknown id.
 */
export function settleContinuityFinding(
  db: TreeDb,
  id: string,
  status: 'dismissed' | 'applied'
): { finding: ContinuityFinding; proposal: SettledStatus | null } {
  return db.transaction((tx) => {
    const finding = settleFinding(tx, id, status)
    const proposal =
      finding.proposalId === null ? null : settleFindingsProposal(tx, finding.proposalId, false)
    return { finding, proposal }
  })
}
