import { z } from 'zod'
import { inputBudget } from '@shared/ai'
import { findQuote, normalizeForMatch } from '@shared/critique'
import { docToText } from '@shared/docText'
import {
  PROOFREAD_CHAR_BUDGET,
  PROOFREAD_FIX_MAX,
  PROOFREAD_KEEP_WORDS_MAX,
  PROOFREAD_KINDS,
  PROOFREAD_MAX_CHANGED_WORDS,
  PROOFREAD_MAX_FIXES,
  PROOFREAD_QUOTE_MAX,
  PROOFREAD_TEXT_MIN,
  type ProofreadFix,
  type ProofreadScope
} from '@shared/proofread'
import { diffWords } from '@shared/rewrite'
import { getDocumentContent } from '../document/documentStore'
import { getSceneMeta } from '../document/sceneMetaStore'
import { sceneBriefBlock } from '../document/sceneNeighbours'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import { projectNameWords, projectSpellingWords } from '../spellcheck/projectWords'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, voiceProfileVersion } from '../voice/profile'
import { voiceBlock } from '../voice/voiceBlock'
import { headTruncate } from './context/chatContext'
import { fitSceneToBudget, scoreFix } from './critique'
import { assertFeatureAllowed } from './dial'
import { buildProofreadPrompt } from './prompts/proofread.v1'
import { AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

export interface ProofreadInput {
  /** The scene to proofread, or the scene the selection is in. */
  nodeId: string
  /** The selection as plain text, to proofread only that; null, absent, or blank is the scene. */
  selection?: string | null
  /** The caller's id for `ai:cancel` (F-5.10); optional so tests and the eval can run without one. */
  requestId?: string
}

export interface ProofreadResult {
  /** The fixes in document order: small corrections of a passage occurring once in the scene. */
  fixes: ProofreadFix[]
  scope: ProofreadScope
  /** Whether the text was cut before it was sent (head-truncated, or shrunk to fit the budget). */
  truncated: boolean
  /** How many fixes the checks in `parseProofreadAnswer` threw away. */
  dropped: number
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

/** A fix as the model sends it and main kept it, before it is scored. */
type ParsedFix = Omit<ProofreadFix, 'flagged' | 'violation'>

const ModelAnswer = z.object({ fixes: z.array(z.unknown()) })
const ModelFix = z.object({
  kind: z.enum(PROOFREAD_KINDS),
  quote: z.string(),
  fix: z.string()
})

const BAD_FORMAT = 'The model did not answer in the expected format.'

/** A word as `diffWords` tokenizes one: letters, digits, and the apostrophes inside them. */
const WORD = /[\p{L}\p{N}'’]+/gu

const wordsOf = (text: string): string[] => text.match(WORD) ?? []

/**
 * Proofread (F-14.12). The gate first (`proofread` must be allowed: nothing is read or sent
 * below Ask or with the feature toggled off), then the node must be a document (NOT_FOUND /
 * VALIDATION as everywhere else). The text sent is the selection when the renderer sent one,
 * else the saved scene; either needs `PROOFREAD_TEXT_MIN` characters. Exactly the context the
 * data-sharing panel lists goes with it: the text head-truncated to `PROOFREAD_CHAR_BUDGET` (and
 * shrunk further if the prompt is still over `inputBudget('proofread')`, token rule 8), the
 * scene brief, the voice block through the scene's POV, and up to `PROOFREAD_KEEP_WORDS_MAX`
 * words to leave alone (the project dictionary and the story's names, `projectSpellingWords`).
 *
 * The answer is JSON from the fast tier (a mechanical pass, token rule 1), not streamed. Each
 * fix must survive `parseProofreadAnswer`'s checks, so what reaches the author is a correction
 * of a passage the renderer can find; and it is scored with the fidelity check (F-14.7) when a
 * voice block went out. The context hash covers everything that shaped the messages.
 */
export async function runProofread(
  db: TreeDb,
  deps: AiRequestDeps,
  input: ProofreadInput
): Promise<ProofreadResult> {
  const settings = getAiSettings(db)
  assertFeatureAllowed(settings, 'proofread')

  const { content } = getDocumentContent(db, input.nodeId)
  const sceneText = content ? docToText(content).trim() : ''
  const selection = input.selection?.trim() ?? ''
  const scope: ProofreadScope = selection ? 'selection' : 'scene'
  const fullText = scope === 'selection' ? selection : sceneText
  if (fullText.length < PROOFREAD_TEXT_MIN) {
    throw new AppError(
      'VALIDATION',
      scope === 'selection'
        ? `Select at least ${PROOFREAD_TEXT_MIN} characters to proofread, or clear the selection to proofread the scene`
        : `Write at least ${PROOFREAD_TEXT_MIN} characters in this scene before proofreading it`,
      { nodeId: input.nodeId, scope, length: fullText.length }
    )
  }

  const brief = sceneBriefBlock(db, input.nodeId)
  const pov = getSceneMeta(db, input.nodeId).meta.pov.trim()
  const profile = buildVoiceProfile(db, { pov: pov || undefined })
  // Chosen once, from the text as first cut, as critique chooses it.
  const voice = voiceBlock(profile, {
    text: headTruncate(fullText, PROOFREAD_CHAR_BUDGET),
    pov: pov || null
  })

  // Every accepted word guards the drop rule; the prompt carries the names first (the misspelled
  // names are what the list is for), then the dictionary, up to the cap.
  const allKeepWords = projectSpellingWords(db)
  const keepWords = keepList([...projectNameWords(db), ...allKeepWords])
  const build = (text: string): ReturnType<typeof buildProofreadPrompt> =>
    buildProofreadPrompt({ text, voice, brief, keepWords })

  const { sceneText: sentText, truncated } = fitSceneToBudget(
    fullText,
    inputBudget('proofread'),
    (text) => build(text).messages,
    { chars: PROOFREAD_CHAR_BUDGET, min: PROOFREAD_TEXT_MIN }
  )
  const prompt = build(sentText)

  const result = await runAiRequest(deps, {
    feature: 'proofread',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(
      JSON.stringify({
        text: sentText,
        scope,
        brief,
        keepWords,
        voiceVersion: voiceProfileVersion()
      })
    ),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })

  const { fixes, dropped } = parseProofreadAnswer(result.text, sentText, sceneText, allKeepWords)
  const scored = voice === null ? null : profile
  return {
    fixes: fixes.map((entry) => ({ ...entry, ...scoreFix(entry.fix, scored) })),
    scope,
    truncated,
    dropped,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
  }
}

/**
 * The model's `{ fixes: [...] }` against what was sent and what is saved: PROVIDER when the
 * answer is not JSON or not that shape at all, and lenient fix by fix otherwise — an unknown
 * kind or a blank quote or fix is skipped silently, the strings are trimmed and capped. Then
 * every fix that would mislead the author or misfire in the editor is dropped and counted:
 *
 * - the fix is the quote again (normalized as `normalizeForMatch` normalizes);
 * - the quote is not in the text sent;
 * - the quote does not occur exactly once in the saved scene, so the renderer's first-match
 *   `locateText` could land on the wrong passage;
 * - the edit is larger than a correction: more than `PROOFREAD_MAX_CHANGED_WORDS` words deleted
 *   plus inserted by `diffWords` ("never style");
 * - every deleted word is a keep word (a story name or a dictionary word, any case) and one of
 *   them is gone from the fix: the model "corrected" a name or an invented word. Removing a
 *   doubled name or changing only its capitals keeps the word, so it stands;
 * - the quote overlaps a fix kept before it, by position in the normalized scene.
 *
 * The kept fixes are sorted into document order and capped at `PROOFREAD_MAX_FIXES`.
 */
export function parseProofreadAnswer(
  text: string,
  sentText: string,
  sceneText: string,
  keepWords: readonly string[]
): { fixes: ParsedFix[]; dropped: number } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)

  const scene = normalizeForMatch(sceneText)
  const keep = new Set(keepWords.map((word) => word.toLocaleLowerCase()))
  const kept: { at: number; end: number; fix: ParsedFix }[] = []
  let dropped = 0
  for (const entry of answer.data.fixes) {
    const parsed = ModelFix.safeParse(entry)
    if (!parsed.success) continue
    const quote = parsed.data.quote.trim().slice(0, PROOFREAD_QUOTE_MAX).trim()
    const fix = parsed.data.fix.trim().slice(0, PROOFREAD_FIX_MAX).trim()
    if (!quote || !fix) continue
    const needle = normalizeForMatch(quote)
    const at = scene.indexOf(needle)
    const valid =
      normalizeForMatch(fix) !== needle &&
      findQuote(sentText, quote) &&
      at >= 0 &&
      !scene.includes(needle, at + 1) &&
      isCorrection(quote, fix, keep)
    const end = at + needle.length
    if (!valid || kept.some((other) => at < other.end && other.at < end)) {
      dropped += 1
      continue
    }
    kept.push({ at, end, fix: { kind: parsed.data.kind, quote, fix } })
  }
  const fixes = kept
    .sort((a, b) => a.at - b.at)
    .slice(0, PROOFREAD_MAX_FIXES)
    .map((entry) => entry.fix)
  return { fixes, dropped }
}

/**
 * The prompt's keep list: one entry per word whatever its case (a tag's "mara" beside the
 * entity's "Mara" costs tokens and says nothing), the author's capitals preferred, in first-seen
 * order, capped at `PROOFREAD_KEEP_WORDS_MAX`.
 */
export function keepList(words: readonly string[]): string[] {
  const byKey = new Map<string, string>()
  for (const word of words) {
    const key = word.toLocaleLowerCase()
    const seen = byKey.get(key)
    if (seen === undefined || (seen === key && word !== key)) byKey.set(key, word)
  }
  return [...byKey.values()].slice(0, PROOFREAD_KEEP_WORDS_MAX)
}

/** Whether `fix` is a small edit of `quote` that leaves the keep words alone (see `parseProofreadAnswer`). */
export function isCorrection(quote: string, fix: string, keep: ReadonlySet<string>): boolean {
  const segments = diffWords(quote, fix)
  const deleted = segments.filter((s) => s.kind === 'del').flatMap((s) => wordsOf(s.text))
  const inserted = segments.filter((s) => s.kind === 'ins').flatMap((s) => wordsOf(s.text))
  if (deleted.length + inserted.length > PROOFREAD_MAX_CHANGED_WORDS) return false
  const lower = deleted.map((word) => word.toLocaleLowerCase())
  if (lower.length === 0 || !lower.every((word) => keep.has(word))) return true
  const remaining = new Set(wordsOf(fix).map((word) => word.toLocaleLowerCase()))
  return lower.every((word) => remaining.has(word))
}
