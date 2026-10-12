import { promptSceneMeta } from '@shared/sceneMeta'
import { REWRITE_CONTEXT_CHARS, REWRITE_TEXT_MAX, REWRITE_TEXT_MIN } from '@shared/rewrite'
import { normalizeProposalNote } from '@shared/proposal'
import { STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { requireDocument } from '../document/documentStore'
import { getSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { buildStoryNotes, typedSceneMeta } from '../memory/storyNotes'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, voiceProfileVersion } from '../voice/profile'
import { voiceBlock } from '../voice/voiceBlock'
import { checkChatFidelity, postProcessChatText, type ChatResult } from './chat'
import { assertFeatureAllowed } from './dial'
import { regenRequestId } from './inflight'
import { buildSceneMood } from './context/sceneMood'
import { buildSceneSteer } from './context/sceneSteer'
import { buildStoryBible } from './context/storyBible'
import { buildRewritePromptV4, type BuildRewritePromptV4Input } from './prompts/rewrite.v4'
import { buildRewriteRegenPromptV4 } from './prompts/rewriteRegen.v4'
import { buildRewritePromptV5, type BuildRewritePromptV5Input } from './prompts/rewrite.v5'
import { buildRewriteRegenPromptV5 } from './prompts/rewriteRegen.v5'
import { AiCancelledError } from './providers/types'
import {
  runAiRequest,
  runAiStream,
  sha256,
  type AiRequestDeps,
  type AiRequestResult
} from './request'

export interface RewriteInput {
  /** The document the selection sits in; its scene metadata and POV ride along. */
  nodeId: string
  /** The selected passage as plain text, `REWRITE_TEXT_MIN`–`REWRITE_TEXT_MAX` characters. */
  text: string
  /** Up to `REWRITE_CONTEXT_CHARS` of manuscript text before the selection; '' at the start. */
  before: string
  /** Up to `REWRITE_CONTEXT_CHARS` after it; '' at the end. */
  after: string
  /** The author's note from Regenerate… (F-14.5); blank or absent is none. */
  note?: string | null
  /** The proposal this rewrite replaces (F-14.5), when the author asked again. */
  regeneratedFrom?: string | null
  /**
   * The caller's id for `ai:cancel` (F-5.10): the streamed draft registers under it, the
   * fidelity regenerate under `regenRequestId(id)`. Optional so the eval harness can run
   * without one; then the request cannot be stopped.
   */
  requestId?: string
  /**
   * F-16.4: the open project's story memory. v1 sends `rewrite.v4`/`rewriteRegen.v4` (the story
   * bible and the steer); v2 sends `rewrite.v5`/`rewriteRegen.v5` (the Story notes block, F-16.14)
   * with the scene line read from the typed details.
   */
  memory: StoryMemoryVersion
}

/** The same shape a chat answer has, so the renderer's handling of the two is shared. */
export type RewriteResult = ChatResult

/**
 * The rewrite-in-my-voice use case (F-14.10). The gate first (`rewrite` must be allowed:
 * nothing is read or sent at Off or with the feature toggled off), then the node must
 * be a document (NOT_FOUND / VALIDATION as everywhere else), then the context the
 * data-sharing panel lists: the scene's metadata and, through the scene's POV, the voice
 * profile block (F-14.1) with the exemplars closest to the passage. No preset: a rewrite is
 * about the author's voice, not the preset's style.
 *
 * The first draft streams (F-5.10) through `runAiStream`, so the panel can show it arriving,
 * and every delta goes to `onDelta`. Then, before the author is offered anything to accept
 * (author-control rule 2), the draft is post-processed (`postProcessChatText`: trim, strip
 * wrapping quotes) and scored with `checkChatFidelity` (F-14.7), the author's banned phrases
 * (F-14.2) first — skipped only when there is no voice block at all, the same gate
 * `voiceBlock` uses, so a fresh project warns about a banned phrase and nothing else. An off-voice draft is regenerated once through `rewriteRegen.v4` with the violation
 * named, not streamed (the panel is already past its drafting state), re-scored, and shown
 * flagged when it still fails; a regenerate that fails for any reason falls back to the first
 * draft, flagged, except a cancel, which propagates as CANCELLED from either call.
 *
 * An author regenerate (F-14.5: a note, a predecessor proposal, or both) sends
 * `rewriteRegen.v4` from the start, with the note clause and, if the fidelity check fires on
 * that attempt, the violation clause too. The note and the predecessor join the context hash,
 * so asking again never answers from the cache with the rewrite the author just turned down.
 * The hash otherwise covers everything that shaped the messages: the passage, both context
 * windows, the metadata, the story bible, the scene steer (F-14.13), the scene mood (F-5.6), and the voice profile's version (it moves on every save and exemplar
 * write, so a changed profile misses the cache while an unchanged one keeps hitting it).
 */
export async function runRewrite(
  db: TreeDb,
  deps: AiRequestDeps,
  input: RewriteInput,
  onDelta: (delta: string) => void
): Promise<RewriteResult> {
  if (input.text.length < REWRITE_TEXT_MIN || input.text.length > REWRITE_TEXT_MAX) {
    throw new AppError('VALIDATION', 'The selected passage is outside the rewrite limits', {
      length: input.text.length,
      min: REWRITE_TEXT_MIN,
      max: REWRITE_TEXT_MAX
    })
  }
  if (input.before.length > REWRITE_CONTEXT_CHARS || input.after.length > REWRITE_CONTEXT_CHARS) {
    throw new AppError('VALIDATION', 'The rewrite context window is over the limit', {
      before: input.before.length,
      after: input.after.length
    })
  }
  assertFeatureAllowed(getAiSettings(db), 'rewrite')
  requireDocument(db, input.nodeId)

  const { meta: sceneMeta } = getSceneMeta(db, input.nodeId)
  const v2 = input.memory === 'v2'
  const meta = v2 ? typedSceneMeta(db, input.nodeId, sceneMeta) : promptSceneMeta(sceneMeta)
  // F-16.11: in v2 the voice's POV is the typed POV record's (the scene line's), as in chat.
  const pov = v2 ? (meta?.pov ?? '') : sceneMeta.pov.trim()
  const profile = buildVoiceProfile(db, { pov: pov || undefined })
  const voice = voiceBlock(profile, { text: input.text, pov: pov || null })
  // F-16.14: v2 carries the Story notes block in the bible's slot and no separate steer.
  const storyNotes = v2
    ? buildStoryNotes(db, {
        nodeId: input.nodeId,
        maxTokens: STORY_BIBLE_TOKEN_BUDGET,
        mood: false
      })
    : null
  const bible = v2
    ? null
    : buildStoryBible(db, { nodeId: input.nodeId, maxTokens: STORY_BIBLE_TOKEN_BUDGET })
  const steer = v2 ? null : buildSceneSteer(db, input.nodeId)
  // F-5.6: the scene's mood and theme from its last reading, so the rewrite stays in line with them
  // (F-16.20: in v2 the card's, and the Story notes block leaves its own Mood line out).
  const mood = buildSceneMood(db, input.nodeId, input.memory)

  const base: BuildRewritePromptV4Input = {
    text: input.text,
    before: input.before,
    after: input.after,
    meta,
    voice,
    bible,
    steer,
    mood
  }
  const baseV5: BuildRewritePromptV5Input = {
    text: input.text,
    before: input.before,
    after: input.after,
    meta,
    voice,
    storyNotes,
    mood
  }
  const note = normalizeProposalNote(input.note)
  const regeneratedFrom = input.regeneratedFrom ?? null
  const authorRegenerate = note !== null || regeneratedFrom !== null
  const prompt = v2
    ? authorRegenerate
      ? buildRewriteRegenPromptV5({ ...baseV5, note, violation: null })
      : buildRewritePromptV5(baseV5)
    : authorRegenerate
      ? buildRewriteRegenPromptV4({ ...base, note, violation: null })
      : buildRewritePromptV4(base)
  const hashed = {
    text: input.text,
    before: input.before,
    after: input.after,
    meta,
    bible,
    steer,
    ...(v2 ? { storyNotes } : {}),
    mood,
    note,
    regeneratedFrom: authorRegenerate ? regeneratedFrom : null,
    voiceVersion: voiceProfileVersion()
  }
  const request = {
    feature: 'rewrite' as const,
    tier: 'strong' as const,
    maxTokens: prompt.maxTokens
  }
  const requestId = input.requestId === undefined ? {} : { requestId: input.requestId }
  const regenId =
    input.requestId === undefined ? {} : { requestId: regenRequestId(input.requestId) }

  const first = await runAiStream(
    deps,
    {
      ...request,
      ...requestId,
      messages: prompt.messages,
      contextHash: sha256(JSON.stringify(hashed)),
      promptVersion: prompt.version
    },
    onDelta
  )
  const firstText = postProcessChatText(first.text)
  // The fidelity check (F-14.7): skipped with nothing to check against (no voice block at all)
  // or an empty draft; the banned phrases (F-14.2) alone make the block non-null.
  if (voice === null || !firstText) return shown(first, firstText, prompt.version)
  const banned = profile.authorRules.bannedPhrases
  const violation = checkChatFidelity(profile.stats, firstText, banned)[0]
  if (violation === undefined) return shown(first, firstText, prompt.version)

  const regen = v2
    ? buildRewriteRegenPromptV5({ ...baseV5, note, violation: violation.message })
    : buildRewriteRegenPromptV4({ ...base, note, violation: violation.message })
  const flaggedFirst: RewriteResult = {
    ...shown(first, firstText, prompt.version),
    flagged: true,
    violation: violation.message
  }
  let second: AiRequestResult
  try {
    second = await runAiRequest(deps, {
      ...request,
      ...regenId,
      messages: regen.messages,
      contextHash: sha256(JSON.stringify({ ...hashed, violation: violation.message })),
      promptVersion: regen.version
    })
  } catch (err) {
    if (err instanceof AiCancelledError) throw err
    return flaggedFirst
  }
  const combined = {
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens
    },
    costUsd: first.costUsd + second.costUsd
  }
  const secondText = postProcessChatText(second.text)
  if (!secondText) return { ...flaggedFirst, ...combined }
  const recheck = checkChatFidelity(profile.stats, secondText, banned)
  return {
    ...shown(second, secondText, regen.version),
    ...combined,
    flagged: recheck.length > 0,
    violation: recheck[0]?.message ?? null
  }
}

function shown(call: AiRequestResult, text: string, version: string): RewriteResult {
  return {
    text,
    usage: call.usage,
    costUsd: call.costUsd,
    cached: call.cached,
    model: call.model,
    promptVersion: version,
    flagged: false,
    violation: null
  }
}
