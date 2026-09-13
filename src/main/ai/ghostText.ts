import { GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS } from '@shared/ai'
import { docToText } from '@shared/docText'
import { resolvePreset } from '@shared/presets'
import { getNotes } from '../document/notesStore'
import { getSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { getAiSettings, getWritingPresets } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { assertFeatureAllowed } from './dial'
import { buildGhostTextPrompt } from './prompts/ghostText.v1'
import type { CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

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
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

/**
 * The ghost-text use case (F-5.3): checks the AI dial first (nothing is read or sent below
 * Suggest or with the feature toggled off), gathers the scene's notes and metadata as the
 * context the data-sharing panel lists, builds `ghostText.v1` with the active writing preset
 * (F-5.2), runs it through the one request path (`fast` tier, the preset's temperature, at
 * most 60 tokens), and post-processes the answer into a one-or-two-sentence continuation.
 * The voice profile slot is empty until F-14.1; the fidelity check (F-14.7) is not built yet.
 *
 * The context hash covers everything that shaped the messages: the caret window, the notes,
 * the metadata, and the preset, so a change to any of them misses the cache. A caret window
 * over the shared bounds is VALIDATION (the contract refuses it first; this is the backstop).
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

  const prompt = buildGhostTextPrompt({
    before: input.before,
    after: input.after,
    notes,
    meta,
    voice: null,
    preset
  })
  const contextHash = sha256(
    JSON.stringify({ before: input.before, after: input.after, notes, meta, preset })
  )

  const result = await runAiRequest(deps, {
    feature: 'ghostText',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    temperature: prompt.temperature,
    contextHash,
    promptVersion: prompt.version
  })

  return {
    text: postProcessGhostText(result.text, input.before, input.after),
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
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
