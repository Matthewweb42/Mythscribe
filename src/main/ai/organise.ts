import { z } from 'zod'
import { categoryOf } from '@shared/categories'
import {
  ORGANISE_MAX_OPS,
  ORGANISE_SPLIT_DEPTH,
  OrganiseOp,
  scopesOf,
  type OrganiseCandidates,
  type OrganisePlan,
  type OrganiseRequest,
  type OrganiseScope
} from '@shared/organise'
import { notesText } from './context/scenePanel'
import { getAiSettings } from '../project/settingsStore'
import {
  loadOrganiseProject,
  organiseCandidates,
  type OrganiseProject
} from '../organise/organiseProject'
import { OrganiseResolver } from '../organise/resolveOps'
import type { TreeDb } from '../tree/treeStore'
import { assertFeatureAllowed } from './dial'
import { cancelInflight } from './inflight'
import {
  buildOrganisePromptV2,
  describeOrganiseChunk,
  findingsFor,
  halveOrganiseChunk,
  organiseChunksV2,
  organiseIndexV2,
  ORGANISE_PROMPT_V2_VERSION,
  type OrganiseChunk,
  type OrganiseFinding,
  type OrganiseListingV2
} from './prompts/organise.v2'
import { createProposal } from './proposalStore'
import { AiCancelledError, AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps, type AiRequestResult } from './request'

/**
 * Organise (F-9.10): the AI's plan for the tags, the story bible, the notes, and the binder. The
 * project is listed once (`organiseListing`), split into chunks, and each chunk is one request on
 * the strong tier in JSON mode with reasoning off, carrying only the local findings about what it
 * lists. An answer cut off by its cap or not one JSON object is not asked again: its chunk is
 * halved at an entry boundary and each half sent, at most `ORGANISE_SPLIT_DEPTH` times
 * (2026-10-08, "Organise at scale"); a piece that still fails is named in the plan's skipped notes
 * and the run goes on, and so is whatever the chunk cap or the index left out. The run fails only
 * when no piece came back readable. Every answer's operations are resolved against the project as
 * they arrive (`OrganiseResolver`), so a later chunk cannot undo an earlier one. Nothing is
 * written: the renderer applies the changes the author keeps. The run is one proposal (F-14.5).
 */

export interface OrganiseInput extends OrganiseRequest {
  /** The renderer's id for `ai:cancel`; chunk `n` goes out as `<id>:<n>`, its halves as `<id>:<n>a` and `<id>:<n>b`. */
  requestId: string
  signal?: AbortSignal
}

export interface OrganiseAnswer {
  plan: OrganisePlan
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  proposalId: string
}

/** The answer read leniently: an operation that does not parse is skipped with its reason. */
const ModelAnswer = z.object({
  reply: z.string().nullish(),
  ops: z.array(z.unknown()).nullish()
})

const unfence = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

/** The operations of an answer, or null when it is not the JSON object asked for. */
export function parseOrganiseAnswer(
  text: string
): { ops: OrganiseOp[]; reply: string; dropped: number } | null {
  let json: unknown
  try {
    json = JSON.parse(unfence(text))
  } catch {
    return null
  }
  const parsed = ModelAnswer.safeParse(json)
  if (!parsed.success) return null
  const ops: OrganiseOp[] = []
  let dropped = 0
  for (const raw of parsed.data.ops ?? []) {
    const op = OrganiseOp.safeParse(raw)
    if (op.success && ops.length < ORGANISE_MAX_OPS) ops.push(op.data)
    else dropped += 1
  }
  return { ops, reply: (parsed.data.reply ?? '').trim(), dropped }
}

/** The local findings in the run's refs, each sent with the chunk that lists its first ref. */
export function organiseFindings(
  project: OrganiseProject,
  found: OrganiseCandidates
): OrganiseFinding[] {
  const refOf = (of: 'tag' | 'sheet', id: string): string =>
    (of === 'tag' ? project.tagRef.get(id) : project.sheetRef.get(id)) ?? '?'
  return [
    ...found.duplicates.map((d) => ({
      kind: 'duplicate' as const,
      refs: d.ids.map((id) => refOf(d.of, id))
    })),
    ...found.unusedTags.map((t) => ({ kind: 'unusedTag' as const, refs: [refOf('tag', t.id)] })),
    ...found.emptySheets.map((s) => ({ kind: 'emptySheet' as const, refs: [refOf('sheet', s.id)] }))
  ]
}

/** The project in the run's refs, as the prompt lists it. */
export function organiseListing(project: OrganiseProject): OrganiseListingV2 {
  const { agent } = project
  const tagRef = (id: string | null): string | null =>
    id === null ? null : (project.tagRef.get(id) ?? null)
  const depth = new Map<string, number>()
  const outline = agent.rows.flatMap((row) => {
    const level = row.parentId === null ? 0 : (depth.get(row.parentId) ?? 0) + 1
    depth.set(row.id, level)
    return [
      {
        ref: agent.refOf.get(row.id) ?? '?',
        depth: level,
        title: row.title,
        level: row.sectionType !== null ? 'section' : (row.hierarchyLevel ?? row.kind),
        words: row.kind === 'document' ? row.wordCount : null
      }
    ]
  })
  return {
    categories: project.categories
      .filter((category) => !category.builtIn)
      .map(({ id, name }) => ({ id, name })),
    tags: project.tags.map((tag) => ({
      ref: project.tagRef.get(tag.id) ?? '?',
      name: tag.name,
      category: tag.category,
      parent: tagRef(tag.parentId),
      aliases: tag.aliases,
      docs: tag.usageCount,
      mentions: project.mentions.get(tag.id) ?? 0,
      sheet: project.sheetRef.get(project.sheets.find((s) => s.tagId === tag.id)?.id ?? '') ?? null
    })),
    sheets: project.sheets.map((sheet) => {
      const category = categoryOf(sheet.kind, project.categories)
      return {
        ref: project.sheetRef.get(sheet.id) ?? '?',
        kind: sheet.kind,
        name: sheet.name,
        aliases: sheet.aliases,
        fields: category.fields
          .filter((f) => (sheet.fields[f.id] ?? '').trim() !== '')
          .map((f) => ({ label: f.label, value: sheet.fields[f.id] ?? '' })),
        empty: category.fields
          .filter((f) => (sheet.fields[f.id] ?? '').trim() === '')
          .map((f) => f.label),
        page: sheet.body ?? '',
        facts: (project.facts.get(sheet.id) ?? []).map((fact) => `${fact.attribute}: ${fact.value}`)
      }
    }),
    notes: agent.rows.flatMap((row) => {
      if (row.kind !== 'document' || row.parentId === null) return []
      const notes = notesText(row.notes, row.id)
      if (notes === '') return []
      return [
        { ref: agent.refOf.get(row.id) ?? '?', title: agent.titleOf(row.id) || row.title, notes }
      ]
    }),
    outline,
    findings: organiseFindings(project, organiseCandidates(project))
  }
}

/** The note for a piece that failed even halved, or for what a cap left out. */
const couldNotPlan = (chunk: OrganiseChunk): string =>
  `Could not plan for ${describeOrganiseChunk(chunk)}: the answer was cut off or unreadable, even in smaller pieces. Run Organise again on that section.`

/** Notes for what the run could not cover, so nothing is dropped without the author being told. */
export function leftOffNotes(
  leftOff: OrganiseChunk,
  index: { tags: number; sheets: number },
  scopes: readonly OrganiseScope[]
): string[] {
  const notes: string[] = []
  const entries = leftOff.reduce((n, section) => n + section.entries.length, 0)
  if (entries > 0) {
    notes.push(
      `${entries} more entr${entries === 1 ? 'y was' : 'ies were'} not looked at (${describeOrganiseChunk(leftOff)}): the project is larger than one run covers. Run Organise again on that section.`
    )
  }
  const names = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  const missed = [
    scopes.includes('tags') && index.tags > 0 ? names(index.tags, 'tag') : '',
    scopes.includes('sheets') && index.sheets > 0 ? names(index.sheets, 'sheet') : ''
  ].filter((part) => part !== '')
  if (missed.length > 0) {
    notes.push(
      `The name index had no room for ${missed.join(' and ')}, so duplicates across parts of the project may be missed.`
    )
  }
  return notes
}

export async function runOrganise(
  db: TreeDb,
  deps: AiRequestDeps,
  input: OrganiseInput
): Promise<OrganiseAnswer> {
  assertFeatureAllowed(getAiSettings(db), 'organise')
  const project = loadOrganiseProject(db)
  const listing = organiseListing(project)
  const scopes = scopesOf(input)
  const index = organiseIndexV2(listing)
  const { chunks, leftOff } = organiseChunksV2(listing, scopes)
  const resolver = new OrganiseResolver(project)
  const usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd = 0
  let cached = true
  let model = ''
  let readable = 0
  const replies: string[] = []
  const failed: string[] = []
  let current: string | null = null
  const onAbort = (): void => {
    if (current !== null) cancelInflight(current)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  const send = async (part: number, chunk: OrganiseChunk, id: string): Promise<AiRequestResult> => {
    if (input.signal?.aborted === true) throw new AiCancelledError('The request was stopped.')
    const prompt = buildOrganisePromptV2({
      index: index.text,
      chunk,
      part,
      parts: chunks.length,
      scopes,
      instruction: input.instruction,
      findings: findingsFor(listing.findings, chunk)
    })
    current = id
    const reply = await runAiRequest(deps, {
      feature: 'organise',
      tier: 'strong',
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
      json: true,
      contextHash: sha256(JSON.stringify(prompt.messages)),
      promptVersion: prompt.version,
      requestId: id
    })
    current = null
    usage.inputTokens += reply.usage.inputTokens
    usage.outputTokens += reply.usage.outputTokens
    costUsd += reply.costUsd
    cached &&= reply.cached
    model = reply.model
    return reply
  }

  try {
    for (const [i, chunk] of chunks.entries()) {
      const part = i + 1
      // Depth first, so the halves of one chunk are resolved in listing order.
      const queue: { piece: OrganiseChunk; depth: number; id: string }[] = [
        { piece: chunk, depth: 0, id: `${input.requestId}:${part}` }
      ]
      while (queue.length > 0) {
        const next = queue.shift()
        if (next === undefined) break
        const { piece, depth, id } = next
        const reply = await send(part, piece, id)
        const parsed = reply.finishReason === 'length' ? null : parseOrganiseAnswer(reply.text)
        if (parsed === null) {
          const halves = depth < ORGANISE_SPLIT_DEPTH ? halveOrganiseChunk(piece) : null
          if (halves === null) failed.push(couldNotPlan(piece))
          else {
            queue.unshift(
              { piece: halves[0], depth: depth + 1, id: `${id}a` },
              { piece: halves[1], depth: depth + 1, id: `${id}b` }
            )
          }
          continue
        }
        readable += 1
        resolver.add(parsed.ops)
        if (parsed.dropped > 0) {
          resolver.skipped.push(
            `${parsed.dropped} operation${parsed.dropped === 1 ? '' : 's'} could not be read`
          )
        }
        if (parsed.reply !== '') replies.push(parsed.reply)
      }
    }
    if (readable === 0) {
      throw new AiFallbackError(
        'Organise could not read a plan from the model for any part of the project, even in smaller pieces. Try again; if it keeps failing, choose another strong model in Settings › AI.'
      )
    }
    const plan: OrganisePlan = {
      reply: replies.join(' '),
      changes: resolver.changes,
      skipped: [...resolver.skipped, ...failed, ...leftOffNotes(leftOff, index.leftOff, scopes)],
      chunks: chunks.length
    }
    const proposal = createProposal(db, {
      feature: 'organise',
      nodeId: null,
      promptVersion: ORGANISE_PROMPT_V2_VERSION,
      model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      costUsd,
      cached,
      content: JSON.stringify({ replies, changes: plan.changes }),
      flagged: null,
      violation: null
    })
    return { plan, usage, costUsd, cached, model, proposalId: proposal.id }
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
}
