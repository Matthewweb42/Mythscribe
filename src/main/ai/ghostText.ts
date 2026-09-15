import { GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS } from '@shared/ai'
import { docToText } from '@shared/docText'
import { resolvePreset } from '@shared/presets'
import { checkGhostTextFidelity } from '@shared/voiceFidelity'
import { getNotes } from '../document/notesStore'
import { getSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { getAiSettings, getWritingPresets } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, voiceProfileVersion } from '../voice/profile'
import { voiceBlock } from '../voice/voiceBlock'
import { assertFeatureAllowed } from './dial'
import { buildGhostTextPrompt } from './prompts/ghostText.v1'
import { buildGhostTextRegenPrompt } from './prompts/ghostTextRegen.v1'
import type { CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps, type AiRequestResult } from './request'

export interface GhostTextInput {
  nodeId: string
  /** The manuscript text right before the caret, at most `GHOST_BEFORE_CHARS`. */
  before: string
  /** The text right after the caret, at most `GHOST_AFTER_CHARS`; '' at the end of the document. */
  after: string
}

export interface GhostTextResult {
  /** The continuation to show at the caret; '' when post-processing left nothing (no suggestion). */
  text: string
  /** Both calls' tokens when the answer was regenerated (F-14.7). */
  usage: CompletionUsage
  /** Both calls' cost when the answer was regenerated. */
  costUsd: number
  /** Whether the call that produced `text` was answered from the cache. */
  cached: boolean
  /** The model of the call that produced `text`. */
  model: string
  /** The prompt version of the call that produced `text`. */
  promptVersion: string
  /** True when `text` still fails the fidelity check after the one regenerate (F-14.7). */
  flagged: boolean
  /** The first violation's message when flagged, for the warning badge; null otherwise. */
  violation: string | null
}

/**
 * The ghost-text use case (F-5.3): checks the AI dial first (nothing is read or sent below
 * Suggest or with the feature toggled off), gathers the scene's notes and metadata as the
 * context the data-sharing panel lists, builds the voice block (F-14.1: the locally computed
 * profile for the scene's POV, with the exemplars closest to the passage at the caret), builds
 * `ghostText.v1` with the active writing preset (F-5.2), runs it through the one request path
 * (`fast` tier, the preset's temperature, at most 60 tokens), and post-processes the answer
 * into a one-or-two-sentence continuation. Then the fidelity check (F-14.7): the answer is
 * scored locally against the profile's stylometrics; an off-voice answer is regenerated once
 * through `ghostTextRegen.v1` with the first violation named, re-scored, and shown flagged
 * when it still fails. A regenerate that fails for any reason (provider, budget, cap) falls
 * back to the first answer, flagged: the author always gets the suggestion that exists. A
 * project with neither rules nor exemplars (the same gate `voiceBlock` uses) skips the check,
 * so a fresh project never warns.
 *
 * The context hash covers everything that shaped the messages: the caret window, the notes,
 * the metadata, the preset, and the voice profile's version (the version stands in for the
 * block: it moves on every save and exemplar write, so a changed profile misses the cache
 * while an unchanged one keeps hitting it). A caret window over the shared bounds is
 * VALIDATION (the contract refuses it first; this is the backstop).
 */
export async function generateGhostText(
  db: TreeDb,
  deps: AiRequestDeps,
  input: GhostTextInput
): Promise<GhostTextResult> {
  if (input.before.length > GHOST_BEFORE_CHARS || input.after.length > GHOST_AFTER_CHARS) {
    throw new AppError('VALIDATION', 'The caret window is over the ghost-text limit', {
      before: input.before.length,
      after: input.after.length
    })
  }
  assertFeatureAllowed(getAiSettings(db), 'ghostText')

  const notesDoc = getNotes(db, input.nodeId).notes
  const notesText = notesDoc ? docToText(notesDoc).trim() : ''
  const notes = notesText ? notesText : null
  const { meta: sceneMeta } = getSceneMeta(db, input.nodeId)
  const meta = sceneMeta.location || sceneMeta.pov || sceneMeta.timeline ? sceneMeta : null
  const preset = resolvePreset(getWritingPresets(db))
  const pov = sceneMeta.pov.trim()
  const profile = buildVoiceProfile(db, { pov: pov || undefined })
  const voice = voiceBlock(profile, { text: input.before, pov: pov || null })

  const promptInput = { before: input.before, after: input.after, notes, meta, voice, preset }
  const prompt = buildGhostTextPrompt(promptInput)
  const context = {
    before: input.before,
    after: input.after,
    notes,
    meta,
    preset,
    voiceVersion: voiceProfileVersion()
  }

  const first = await runAiRequest(deps, {
    feature: 'ghostText',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    temperature: prompt.temperature,
    contextHash: sha256(JSON.stringify(context)),
    promptVersion: prompt.version
  })
  const firstText = postProcessGhostText(first.text, input.before, input.after)
  const shown = (call: AiRequestResult, text: string, version: string): GhostTextResult => ({
    text,
    usage: call.usage,
    costUsd: call.costUsd,
    cached: call.cached,
    model: call.model,
    promptVersion: version,
    flagged: false,
    violation: null
  })

  // The fidelity check (F-14.7): skipped for a fresh project (no voice block) or no suggestion.
  if (voice === null || !firstText) return shown(first, firstText, prompt.version)
  const violation = checkGhostTextFidelity(profile.stats, firstText).violations[0]
  if (violation === undefined) return shown(first, firstText, prompt.version)

  const regen = buildGhostTextRegenPrompt({ ...promptInput, violation: violation.message })
  const flaggedFirst: GhostTextResult = {
    ...shown(first, firstText, prompt.version),
    flagged: true,
    violation: violation.message
  }
  let second: AiRequestResult
  try {
    second = await runAiRequest(deps, {
      feature: 'ghostText',
      tier: 'fast',
      messages: regen.messages,
      maxTokens: regen.maxTokens,
      temperature: regen.temperature,
      contextHash: sha256(JSON.stringify({ ...context, violation: violation.code })),
      promptVersion: regen.version
    })
  } catch {
    return flaggedFirst
  }
  const combined = {
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens
    },
    costUsd: first.costUsd + second.costUsd
  }
  const secondText = postProcessGhostText(second.text, input.before, input.after)
  if (!secondText) return { ...flaggedFirst, ...combined }
  const recheck = checkGhostTextFidelity(profile.stats, secondText)
  return {
    ...shown(second, secondText, regen.version),
    ...combined,
    flagged: !recheck.ok,
    violation: recheck.violations[0]?.message ?? null
  }
}

/** Matching quote pairs an answer may be wrapped in; stripped only when the pair encloses the whole answer. */
const QUOTE_PAIRS: readonly [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’']
]

/** How many trailing characters of `before` a leading repeat is checked against. */
const REPEAT_TAIL_CHARS = 40
/** A shorter tail is too likely to match by coincidence ("the", "and "). */
const REPEAT_TAIL_MIN = 10

/**
 * The model's raw answer as the text to show at the caret (F-5.3), in order: trim; strip one
 * pair of quotation marks wrapping the whole answer (the rules forbid them, models add them
 * anyway; a pair around genuine dialogue is kept, since the inner text then holds more of the
 * same quote); drop a leading repeat of the passage's tail (heuristic: the longest suffix of
 * the last 40 characters of `before`, at least 10 long, case-insensitive); cut to the first two sentences, dropping an incomplete
 * trailing fragment when at least one sentence is complete; then fix the join with the text
 * around the caret, since the model answers without leading whitespace: a space is added
 * after sentence punctuation or before a capital that follows a word character, never
 * mid-word, and one after the answer when the text after the caret runs straight on. An
 * answer that ends up empty means "no suggestion".
 */
export function postProcessGhostText(raw: string, before: string, after: string): string {
  let text = raw.trim()
  text = stripWrappingQuotes(text)
  text = dropLeadingRepeat(text, before)
  text = cutToTwoSentences(text).trim()
  if (!text) return ''
  return joinAtCaret(text, before, after)
}

function stripWrappingQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, -close.length)
      if (!inner.includes(open) && !inner.includes(close)) return inner.trim()
    }
  }
  return text
}

function dropLeadingRepeat(text: string, before: string): string {
  const tail = before.trimEnd().slice(-REPEAT_TAIL_CHARS).toLowerCase()
  const lower = text.toLowerCase()
  // The longest suffix of the tail (at least REPEAT_TAIL_MIN long) that the answer opens with.
  for (let len = tail.length; len >= REPEAT_TAIL_MIN; len--) {
    if (lower.startsWith(tail.slice(tail.length - len))) return text.slice(len).trimStart()
  }
  return text
}

/** A sentence end: terminal punctuation, optional closing quotes or brackets, then whitespace or the end. */
const SENTENCE_END = /[.!?…]+["”’')\]]*(?=\s|$)/g

function cutToTwoSentences(text: string): string {
  const ends = [...text.matchAll(SENTENCE_END)].map((m) => m.index + m[0].length)
  if (ends.length === 0) return text
  const cut = ends[1] ?? ends[0]
  return cut === undefined ? text : text.slice(0, cut)
}

const ENDS_SENTENCE = /[.!?…,;:)\]"”’']$/
const WORD_CHAR = /[\p{L}\p{N}]/u
const STARTS_WORDISH = /^[\p{L}\p{N}"“‘(]/u
const STARTS_UPPER = /^\p{Lu}/u

function joinAtCaret(text: string, before: string, after: string): string {
  let joined = text
  const last = before.at(-1)
  if (last !== undefined && !/\s/.test(last)) {
    if (ENDS_SENTENCE.test(last) && STARTS_WORDISH.test(joined)) joined = ` ${joined}`
    else if (WORD_CHAR.test(last) && STARTS_UPPER.test(joined)) joined = ` ${joined}`
  }
  const next = after.at(0)
  if (next !== undefined && STARTS_WORDISH.test(next) && !/\s$/.test(joined)) joined = `${joined} `
  return joined
}
