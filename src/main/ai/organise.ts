import { z } from 'zod'
import { categoryOf } from '@shared/categories'
import {
  ORGANISE_MAX_OPS,
  OrganiseOp,
  scopesOf,
  type OrganiseCandidates,
  type OrganisePlan,
  type OrganiseRequest
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
  buildOrganisePrompt,
  organiseChunks,
  organiseIndex,
  ORGANISE_PROMPT_VERSION,
  type OrganiseListing
} from './prompts/organise.v1'
import { createProposal } from './proposalStore'
import { AiCancelledError, AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps, type AiRequestResult } from './request'

/**
 * Organise (F-9.10): the AI's plan for the tags, the story bible, the notes, and the binder. The
 * project is listed once (`organiseListing`), split into chunks, and each chunk is one request on
 * the strong tier in JSON mode; an answer cut off by its cap or not one JSON object is asked once
 * more with a larger cap and a nudge to be brief (the agent's retry), and a chunk that still fails
 * fails the run with its next step. Every answer's operations are resolved against the project as
 * they arrive (`OrganiseResolver`), so a later chunk cannot undo an earlier one. Nothing is
 * written: the renderer applies the changes the author keeps. The run is one proposal (F-14.5).
 */

export interface OrganiseInput extends OrganiseRequest {
  /** The renderer's id for `ai:cancel`; chunk `n` goes out as `<id>:<n>` and its retry as `<id>:<n>r`. */
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

/** The local findings in the run's refs, for the first request; '' for none. */
export function findingsLine(project: OrganiseProject, found: OrganiseCandidates): string {
  const refOf = (of: 'tag' | 'sheet', id: string): string =>
    (of === 'tag' ? project.tagRef.get(id) : project.sheetRef.get(id)) ?? '?'
  const parts: string[] = []
  if (found.duplicates.length > 0) {
    parts.push(
      `Likely duplicates: ${found.duplicates.map((d) => d.ids.map((id) => refOf(d.of, id)).join(' + ')).join('; ')}.`
    )
  }
  if (found.unusedTags.length > 0) {
    parts.push(`Unused tags: ${found.unusedTags.map((t) => refOf('tag', t.id)).join(', ')}.`)
  }
  if (found.emptySheets.length > 0) {
    parts.push(`Empty sheets: ${found.emptySheets.map((s) => refOf('sheet', s.id)).join(', ')}.`)
  }
  return parts.length === 0 ? '' : `Found locally (check them): ${parts.join(' ')}`
}

/** The project in the run's refs, as the prompt lists it. */
export function organiseListing(project: OrganiseProject): OrganiseListing {
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
    findings: findingsLine(project, organiseCandidates(project))
  }
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
  const index = organiseIndex(listing)
  const chunks = organiseChunks(listing, scopes)
  const resolver = new OrganiseResolver(project)
  const usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd = 0
  let cached = true
  let model = ''
  const replies: string[] = []
  let current: string | null = null
  const onAbort = (): void => {
    if (current !== null) cancelInflight(current)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  const send = async (part: number, retry: boolean): Promise<AiRequestResult> => {
    if (input.signal?.aborted === true) throw new AiCancelledError('The request was stopped.')
    const prompt = buildOrganisePrompt({
      index,
      chunk: chunks[part - 1] ?? '',
      part,
      parts: chunks.length,
      scopes,
      instruction: input.instruction,
      findings: listing.findings,
      retry
    })
    current = `${input.requestId}:${part}${retry ? 'r' : ''}`
    const reply = await runAiRequest(deps, {
      feature: 'organise',
      tier: 'strong',
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
      json: true,
      contextHash: sha256(JSON.stringify(prompt.messages)),
      promptVersion: prompt.version,
      requestId: current
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
    for (let part = 1; part <= chunks.length; part++) {
      let reply = await send(part, false)
      let parsed = reply.finishReason === 'length' ? null : parseOrganiseAnswer(reply.text)
      if (parsed === null) {
        reply = await send(part, true)
        parsed = reply.finishReason === 'length' ? null : parseOrganiseAnswer(reply.text)
      }
      if (parsed === null) {
        throw new AiFallbackError(
          'The plan was cut off or unreadable, even when asked again. Try a narrower instruction (for example "merge duplicate tags"), or switch Thinking off for the strong model in Settings › AI.'
        )
      }
      resolver.add(parsed.ops)
      if (parsed.dropped > 0) {
        resolver.skipped.push(
          `${parsed.dropped} operation${parsed.dropped === 1 ? '' : 's'} could not be read`
        )
      }
      if (parsed.reply !== '') replies.push(parsed.reply)
    }
    const plan: OrganisePlan = {
      reply: replies.join(' '),
      changes: resolver.changes,
      skipped: resolver.skipped,
      chunks: chunks.length
    }
    const proposal = createProposal(db, {
      feature: 'organise',
      nodeId: null,
      promptVersion: ORGANISE_PROMPT_VERSION,
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
