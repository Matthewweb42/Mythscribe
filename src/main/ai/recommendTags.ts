import { z } from 'zod'
import { TAGS_MIN_CHARS } from '@shared/ai'
import { docToText } from '@shared/docText'
import type { Tag } from '@shared/ipc/contract'
import { normalizeProposalNote } from '@shared/proposal'
import { toTagName } from '@shared/tags'
import { getDocumentContent } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import { listDocumentTags } from '../tag/documentTagStore'
import { listTags, type TagDb } from '../tag/tagStore'
import { assertFeatureAllowed } from './dial'
import { buildTagsPrompt } from './prompts/tags.v1'
import { buildTagsRegenPrompt } from './prompts/tagsRegen.v1'
import { AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/** The most suggestions one request may return, whatever the model sends. */
export const TAGS_MAX_SUGGESTIONS = 8

export interface RecommendTagsResult {
  /** Bank tags the model picked that are not yet linked to the document, at most 8. */
  suggestions: Tag[]
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

const ModelAnswer = z.object({ tags: z.array(z.string()) })

/**
 * A regenerate (F-14.5): the proposal being replaced and the author's note, either may be
 * missing; and the caller's `requestId` for `ai:cancel` (F-5.10), without which the request
 * cannot be stopped. Tags have no fidelity regenerate, so the one id is the whole request.
 */
export interface RecommendTagsOptions {
  note?: string | null
  regeneratedFrom?: string | null
  requestId?: string
}

/**
 * The tag-recommendation use case (F-4.7): reads a document's text, checks the 50-character
 * gate and the AI dial, sends the text and the bank's names through the one request path
 * (`fast` tier, JSON mode, `tags.v1`), and maps the model's names back to bank tags. Nothing
 * is linked here: the author accepts each suggestion in the tag bar.
 *
 * A regenerate (F-14.5: a note, a predecessor proposal, or both) goes through `tagsRegen.v1`
 * instead, and the note and the predecessor join the context hash so asking again never
 * answers from the cache with the set the author just turned down.
 *
 * Refusals: NOT_FOUND / VALIDATION (`AppError`) for an unknown id, a folder, or too little
 * text; `AiDisabledError` below the dial; the request path's own errors; and an answer that
 * is not `{ tags: string[] }` as `AiFallbackError` (PROVIDER). The request path caches every
 * provider answer before it returns, so a malformed one is cached too until the cache row
 * ages out; a validation hook on the path is a later feature.
 */
export async function recommendTags(
  db: TagDb,
  deps: AiRequestDeps,
  nodeId: string,
  options: RecommendTagsOptions = {}
): Promise<RecommendTagsResult> {
  const { content } = getDocumentContent(db, nodeId)
  const text = content ? docToText(content) : ''
  if (text.length < TAGS_MIN_CHARS) {
    throw new AppError(
      'VALIDATION',
      `Add at least ${TAGS_MIN_CHARS} characters of text before asking for tag suggestions`,
      { nodeId, length: text.length }
    )
  }
  assertFeatureAllowed(getAiSettings(db), 'tags')

  const bank = listTags(db)
  const linkedIds = new Set(listDocumentTags(db, nodeId).map((tag) => tag.id))
  const tagNames = bank.map((tag) => tag.name)
  const note = normalizeProposalNote(options.note)
  const regeneratedFrom = options.regeneratedFrom ?? null
  const isRegenerate = note !== null || regeneratedFrom !== null
  const prompt = isRegenerate
    ? buildTagsRegenPrompt({ text, tagNames, note })
    : buildTagsPrompt({ text, tagNames })
  const context = `${text}|${[...tagNames].sort().join(',')}`
  const contextHash = sha256(
    isRegenerate ? `${context}|regenerate:${regeneratedFrom ?? ''}|${note ?? ''}` : context
  )

  const result = await runAiRequest(deps, {
    feature: 'tags',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash,
    promptVersion: prompt.version,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId })
  })

  const names = parseAnswer(result.text)
  const byName = new Map(bank.map((tag) => [toTagName(tag.name), tag]))
  const seen = new Set<string>()
  const suggestions: Tag[] = []
  for (const name of names) {
    const tag = byName.get(toTagName(name))
    if (!tag || linkedIds.has(tag.id) || seen.has(tag.id)) continue
    seen.add(tag.id)
    suggestions.push(tag)
    if (suggestions.length === TAGS_MAX_SUGGESTIONS) break
  }

  return {
    suggestions,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
  }
}

/** The model's `{ tags: string[] }`, or PROVIDER when the answer is not JSON or not that shape. */
function parseAnswer(text: string): string[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const parsed = ModelAnswer.safeParse(json)
  if (!parsed.success) throw new AiFallbackError(BAD_FORMAT, parsed.error)
  return parsed.data.tags
}

const BAD_FORMAT = 'The model did not answer in the expected format.'
