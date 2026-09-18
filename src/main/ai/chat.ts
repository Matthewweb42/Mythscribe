import { estimateTokens, inputBudget } from '@shared/ai'
import { STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import { AI_DATA_SHARING, AI_DIAL_LABEL } from '@shared/aiSettings'
import type { ChatMode } from '@shared/chat'
import { resolvePreset } from '@shared/presets'
import { computeStylometrics, type Stylometrics } from '@shared/stylometry'
import {
  checkBannedPhrases,
  checkGhostTextFidelity,
  scoreDocumentDrift,
  type FidelityViolation
} from '@shared/voiceFidelity'
import { getAiSettings, getWritingPresets } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, voiceProfileVersion } from '../voice/profile'
import { voiceBlock } from '../voice/voiceBlock'
import { buildChatContext } from './context/chatContext'
import { buildStoryBible } from './context/storyBible'
import { assertFeatureAllowed } from './dial'
import { stripWrappingQuotes } from './ghostText'
import { regenRequestId } from './inflight'
import type { ChatTurn } from './prompts/chat.v1'
import { buildChatPromptV3, type BuildChatPromptV3Input } from './prompts/chat.v3'
import { buildChatRegenPromptV3 } from './prompts/chatRegen.v3'
import { AiCancelledError, AiDisabledError, type CompletionUsage } from './providers/types'
import {
  runAiRequest,
  runAiStream,
  sha256,
  type AiRequestDeps,
  type AiRequestResult
} from './request'

export interface ChatInput {
  /** The active document whose text rides along, or null with no document open. */
  nodeId: string | null
  mode: ChatMode
  paragraphs: number
  message: string
  /** The recent turns the renderer keeps, oldest first. */
  history: ChatTurn[]
  /**
   * The caller's id for `ai:cancel` (F-5.10): the first call registers under it, an Agent
   * regenerate under `regenRequestId(id)`. Optional so the eval harness can run without one.
   */
  requestId?: string
}

export interface ChatResult {
  /** Plan mode: the whole answer (already streamed). Agent mode: the post-processed draft. */
  text: string
  /** Both calls' tokens when the draft was regenerated (F-14.7). */
  usage: CompletionUsage
  /** Both calls' cost when the draft was regenerated. */
  costUsd: number
  /** Whether the call that produced `text` was answered from the cache. */
  cached: boolean
  /** The model of the call that produced `text`. */
  model: string
  /** The prompt version of the call that produced `text`. */
  promptVersion: string
  /** Agent mode only: true when `text` still fails the fidelity check after the one regenerate. */
  flagged: boolean
  /** The first violation's message when flagged; null otherwise and always in Plan mode. */
  violation: string | null
}

/** Below this many words a draft is scored as a fragment (`checkGhostTextFidelity`), above as a document. */
export const CHAT_FRAGMENT_MAX_WORDS = 200

/**
 * The assistant use case (F-5.4). The gate first: `chat` must be allowed (Ask), and Agent mode
 * additionally needs the dial at the ghost-text level (Suggest), since its draft renders
 * through ghost text; the toggle for ghost text itself does not apply, so the level is checked
 * directly. Then the context (`buildChatContext`: the scene's text, metadata, and brief
 * (F-14.3, Agent mode only), the notes behind the message's `#name` references), and, in Agent mode, the voice block (F-14.1) and
 * the active preset (F-5.2). The prompt is `chat.v3`; when its estimate is over the chat
 * input budget, the oldest history turns are dropped first (CLAUDE.md, token rule 8) before
 * the request path makes its own check. Plan mode streams through `runAiStream` and hands
 * every delta to `onDelta`; Agent mode completes as a whole, is post-processed (trim, strip
 * wrapping quotes), and runs the fidelity check (F-14.7): a fragment under
 * `CHAT_FRAGMENT_MAX_WORDS` words through `checkGhostTextFidelity`, a longer draft through
 * `scoreDocumentDrift`; an off-voice draft is regenerated once through `chatRegen.v3` with
 * the violation named, re-scored, and shown flagged when it still fails; a regenerate that
 * fails for any reason falls back to the first draft, flagged, except a cancel (F-5.10),
 * which propagates as CANCELLED from either call. Plan answers are never flagged. Both tiers
 * are `fast`.
 *
 * The context hash covers everything that shaped the messages: the scene text, the metadata,
 * the brief, the references, the (trimmed) history, the message, the mode, the paragraph count, the
 * preset, and the voice profile's version (which the author's rules bump too); the regenerate
 * adds the violation's message, which names the banned phrase, so two phrases never share a
 * cached regenerate.
 */
export async function runChat(
  db: TreeDb,
  deps: AiRequestDeps,
  input: ChatInput,
  onDelta: (delta: string) => void
): Promise<ChatResult> {
  const settings = getAiSettings(db)
  assertFeatureAllowed(settings, 'chat')
  const agent = input.mode === 'agent'
  if (agent) {
    const { minDial } = AI_DATA_SHARING.ghostText
    if (settings.dial < minDial) {
      throw new AiDisabledError(
        `Author mode needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (it is at ${AI_DIAL_LABEL[settings.dial]}).`
      )
    }
  }

  const context = buildChatContext(db, { nodeId: input.nodeId, message: input.message })
  const preset = agent ? resolvePreset(getWritingPresets(db)) : null
  const pov = context.sceneMeta?.pov.trim() ?? ''
  const profile = agent ? buildVoiceProfile(db, { pov: pov || undefined }) : null
  const voice = profile ? voiceBlock(profile, { text: context.sceneText, pov: pov || null }) : null
  const bible = buildStoryBible(db, { nodeId: input.nodeId, maxTokens: STORY_BIBLE_TOKEN_BUDGET })

  const base: Omit<BuildChatPromptV3Input, 'history'> = {
    mode: input.mode,
    paragraphs: input.paragraphs,
    sceneText: context.sceneText,
    sceneMeta: context.sceneMeta,
    brief: context.brief,
    refs: context.refs,
    message: input.message,
    voice,
    bible,
    preset
  }
  let history = input.history
  let prompt = buildChatPromptV3({ ...base, history })
  while (history.length > 0 && estimate(prompt.messages) > inputBudget('chat')) {
    history = history.slice(1)
    prompt = buildChatPromptV3({ ...base, history })
  }
  const promptInput: BuildChatPromptV3Input = { ...base, history }
  const hashed = {
    sceneText: context.sceneText,
    sceneMeta: context.sceneMeta,
    brief: context.brief,
    refs: context.refs,
    bible,
    history,
    message: input.message,
    mode: input.mode,
    paragraphs: input.paragraphs,
    preset,
    voiceVersion: agent ? voiceProfileVersion() : null
  }
  const request = {
    feature: 'chat' as const,
    tier: 'fast' as const,
    maxTokens: prompt.maxTokens,
    ...(prompt.temperature === undefined ? {} : { temperature: prompt.temperature })
  }
  const requestId = input.requestId === undefined ? {} : { requestId: input.requestId }
  const regenId =
    input.requestId === undefined ? {} : { requestId: regenRequestId(input.requestId) }

  if (!agent) {
    const answer = await runAiStream(
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
    return shown(answer, answer.text, prompt.version)
  }

  const first = await runAiRequest(deps, {
    ...request,
    ...requestId,
    messages: prompt.messages,
    contextHash: sha256(JSON.stringify(hashed)),
    promptVersion: prompt.version
  })
  const firstText = postProcessChatText(first.text)
  // The fidelity check (F-14.7): skipped with nothing to check against (no voice block at all)
  // or an empty draft; the banned phrases (F-14.2) alone make the block non-null.
  if (profile === null || voice === null || !firstText) {
    return shown(first, firstText, prompt.version)
  }
  const banned = profile.authorRules.bannedPhrases
  const violation = checkChatFidelity(profile.stats, firstText, banned)[0]
  if (violation === undefined) return shown(first, firstText, prompt.version)

  const regen = buildChatRegenPromptV3({ ...promptInput, violation: violation.message })
  const flaggedFirst: ChatResult = {
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

/**
 * The model's raw Agent-mode draft as the text the editor shows: trimmed, one pair of
 * quotation marks wrapping the whole draft stripped (the rules forbid them, models add them
 * anyway). Paragraph breaks are kept: the ghost widget renders them and the accept splits on
 * them. An empty result means "nothing to place".
 */
export function postProcessChatText(raw: string): string {
  return stripWrappingQuotes(raw.trim()).trim()
}

/**
 * The fidelity check for a draft of any length (F-14.7): a fragment is scored like ghost
 * text, a longer draft like a document in the consistency report. The author's banned phrases
 * (F-14.2) are checked at either length and come first, since they are hard constraints rather
 * than a stylometric signal. Shared with the rewrite use case (F-14.10) and the eval harness so
 * every prose feature and the live run score the same way.
 */
export function checkChatFidelity(
  profile: Stylometrics,
  text: string,
  banned: readonly string[] = []
): FidelityViolation[] {
  const words = text.split(/\s+/).filter(Boolean).length
  return words < CHAT_FRAGMENT_MAX_WORDS
    ? checkGhostTextFidelity(profile, text, banned).violations
    : [
        ...checkBannedPhrases(banned, text),
        ...scoreDocumentDrift(profile, computeStylometrics(text)).violations
      ]
}

function estimate(messages: { content: string }[]): number {
  return estimateTokens(messages.map((m) => m.content).join('\n'))
}

function shown(call: AiRequestResult, text: string, version: string): ChatResult {
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
