import { z } from 'zod'
import type { ContextReview } from '@shared/contextLibrary'
import { REVIEW_CHAT_MAX_OPS, ReviewOp, type ReviewChatTurn } from '@shared/reviewChat'
import type { LibraryDb } from '../library/libraryStore'
import { getAiSettings } from '../project/settingsStore'
import { assertFeatureAllowed } from './dial'
import { cancelInflight } from './inflight'
import { buildReviewChatPromptV2, REVIEW_CHAT_PROMPT_V2_VERSION } from './prompts/reviewChat.v2'
import { createProposal } from './proposalStore'
import { AiCancelledError, AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps, type AiRequestResult } from './request'

/**
 * The review chat (F-9.9): the author's instruction about a pending upload review (F-9.8) turned
 * into operations on it. One request on the strong tier in JSON mode; an answer that was cut off
 * by its cap or does not parse is asked once more with a larger cap and a nudge to be brief (the
 * agent's retry, 2026-10-07), and then fails as PROVIDER. The answer is one proposal (F-14.5),
 * which the renderer adds to the review so it is settled with it at Apply or Cancel. Nothing is
 * written here and the review is not changed: the renderer applies the operations
 * (`applyReviewOps`) to the review as it then stands.
 */

export interface ReviewChatInput {
  review: ContextReview
  history: readonly ReviewChatTurn[]
  message: string
  /** The renderer's id for `ai:cancel`; the request and its retry go out as `<id>:a` and `<id>:b`. */
  requestId: string
  signal?: AbortSignal
}

export interface ReviewChatAnswer {
  ops: ReviewOp[]
  reply: string
  dropped: number
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  proposalId: string
}

/** The answer read leniently: an operation that does not parse is dropped and counted. */
const ModelAnswer = z.object({
  reply: z.string().nullish(),
  ops: z.array(z.unknown()).nullish()
})

const unfence = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

/** The operations and reply of an answer, or null when it is not the JSON object asked for. */
export function parseReviewChatAnswer(
  text: string
): { ops: ReviewOp[]; reply: string; dropped: number } | null {
  let json: unknown
  try {
    json = JSON.parse(unfence(text))
  } catch {
    return null
  }
  const parsed = ModelAnswer.safeParse(json)
  if (!parsed.success) return null
  const ops: ReviewOp[] = []
  let dropped = 0
  for (const raw of parsed.data.ops ?? []) {
    const op = ReviewOp.safeParse(raw)
    if (op.success && ops.length < REVIEW_CHAT_MAX_OPS) ops.push(op.data)
    else dropped += 1
  }
  return { ops, reply: (parsed.data.reply ?? '').trim(), dropped }
}

export async function runReviewChat(
  db: LibraryDb,
  deps: AiRequestDeps,
  input: ReviewChatInput
): Promise<ReviewChatAnswer> {
  assertFeatureAllowed(getAiSettings(db), 'reviewChat')
  const usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd = 0
  let cached = true
  let current: string | null = null
  const onAbort = (): void => {
    if (current !== null) cancelInflight(current)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  const send = async (retry: boolean): Promise<AiRequestResult> => {
    if (input.signal?.aborted === true) throw new AiCancelledError('The request was stopped.')
    const prompt = buildReviewChatPromptV2({
      review: input.review,
      history: input.history,
      message: input.message,
      retry
    })
    current = `${input.requestId}:${retry ? 'b' : 'a'}`
    const reply = await runAiRequest(deps, {
      feature: 'reviewChat',
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
    return reply
  }

  try {
    let reply = await send(false)
    let parsed = reply.finishReason === 'length' ? null : parseReviewChatAnswer(reply.text)
    if (parsed === null) {
      reply = await send(true)
      parsed = reply.finishReason === 'length' ? null : parseReviewChatAnswer(reply.text)
    }
    if (parsed === null) {
      throw new AiFallbackError(
        'The answer was cut off or unreadable, even when asked again. Try a shorter instruction, or switch Thinking off for the strong model in Settings › AI.'
      )
    }
    const proposal = createProposal(db, {
      feature: 'reviewChat',
      nodeId: null,
      promptVersion: REVIEW_CHAT_PROMPT_V2_VERSION,
      model: reply.model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      costUsd,
      cached,
      content: reply.text,
      flagged: null,
      violation: null
    })
    return { ...parsed, usage, costUsd, cached, model: reply.model, proposalId: proposal.id }
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
}
