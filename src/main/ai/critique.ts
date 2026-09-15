import { z } from 'zod'
import { estimateTokens, inputBudget } from '@shared/ai'
import {
  CRITIQUE_CATEGORIES,
  CRITIQUE_FIX_MAX,
  CRITIQUE_MAX_NOTES,
  CRITIQUE_NOTES_CHAR_CAP,
  CRITIQUE_QUOTE_MAX,
  CRITIQUE_SCENE_CHAR_BUDGET,
  CRITIQUE_TEXT_MIN,
  CRITIQUE_WHY_MAX,
  findQuote,
  normalizeForMatch,
  type CritiqueNote
} from '@shared/critique'
import { docToText } from '@shared/docText'
import { normalizeProposalNote } from '@shared/proposal'
import { checkGhostTextFidelity } from '@shared/voiceFidelity'
import { getDocumentContent } from '../document/documentStore'
import { getNotes } from '../document/notesStore'
import { getSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, voiceProfileVersion, type VoiceProfile } from '../voice/profile'
import { voiceBlock } from '../voice/voiceBlock'
import { headTruncate } from './context/chatContext'
import { assertFeatureAllowed } from './dial'
import {
  buildCritiquePrompt,
  type BuildCritiquePromptInput,
  type BuiltCritiquePrompt
} from './prompts/critique.v1'
import { buildCritiqueRegenPrompt, type BuiltCritiqueRegenPrompt } from './prompts/critiqueRegen.v1'
import { AiFallbackError, type AiMessage, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/** How much scene text one shrink step drops when the prompt is over the input budget. */
export const CRITIQUE_SHRINK_CHARS = 2_000

export interface CritiqueInput {
  /** The scene to read; its notes, metadata, and POV ride along. */
  nodeId: string
  /** The author's note from Ask again… (F-14.5); blank or absent is none. */
  note?: string | null
  /** The proposal these notes replace (F-14.5), when the author asked again. */
  regeneratedFrom?: string | null
  /**
   * The caller's id for `ai:cancel` (F-5.10). Optional so the eval harness can run without
   * one; then the request cannot be stopped.
   */
  requestId?: string
}

export interface CritiqueResult {
  /** The notes the author is shown: each one cites a passage that is in the scene text sent. */
  notes: CritiqueNote[]
  /** Whether the scene was cut before it was sent (head-truncated, or shrunk to fit the budget). */
  truncated: boolean
  /** How many notes were dropped because their quote was not in the text sent. */
  dropped: number
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

/** A note as the model sends it, before the quote is located and the fix is scored. */
type ParsedNote = Omit<CritiqueNote, 'flagged' | 'violation'>

const ModelAnswer = z.object({ notes: z.array(z.unknown()) })
const ModelNote = z.object({
  kind: z.enum(['issue', 'praise']),
  category: z.enum(CRITIQUE_CATEGORIES),
  quote: z.string(),
  why: z.string(),
  fix: z.string().nullish()
})

const BAD_FORMAT = 'The model did not answer in the expected format.'

/**
 * The editor's-notes use case (F-14.8). The gate first (`critique` must be allowed: nothing is
 * read or sent below Ask or with the feature toggled off), then the node must be a document
 * holding at least `CRITIQUE_TEXT_MIN` characters (NOT_FOUND / VALIDATION as everywhere
 * else), then exactly the context the data-sharing panel lists: the scene's text
 * head-truncated to `CRITIQUE_SCENE_CHAR_BUDGET`, its notes (the brief stand-in until F-14.3)
 * cut to `CRITIQUE_NOTES_CHAR_CAP`, its metadata, and, through the scene's POV, the voice
 * profile block (F-14.1). The honesty setting picks the prompt's tone line. If the prompt is
 * still over `inputBudget('critique')` — a long voice block and long notes on a long scene —
 * the scene text is shrunk `CRITIQUE_SHRINK_CHARS` at a time until it fits (CLAUDE.md, token
 * efficiency rule 8) rather than failing or overspending; either cut sets `truncated`.
 *
 * The answer is JSON (strong tier: critique is one of the three features token rule 1 allows
 * there) and is not streamed: the notes are only useful whole. Every note must cite a passage
 * that is in the text that was sent, matched through `normalizeForMatch`, so the author never
 * sees a claim — or a compliment — about words that are not in the scene; the ones that do not
 * match are dropped and counted in `dropped`. Each fix is scored with the fidelity check
 * (F-14.7) when the project has a voice block, and a failing one is shown flagged: there is no
 * regenerate, since a retry would redo the whole critique.
 *
 * A regenerate (F-14.5: a note, a predecessor proposal, or both) goes through
 * `critiqueRegen.v1`, and the note and the predecessor join the context hash, so asking again
 * never answers from the cache with the notes the author just turned down. The hash otherwise
 * covers everything that shaped the messages: the scene text as sent, the notes, the metadata,
 * the honesty setting, and the voice profile's version.
 */
export async function runCritique(
  db: TreeDb,
  deps: AiRequestDeps,
  input: CritiqueInput
): Promise<CritiqueResult> {
  const settings = getAiSettings(db)
  assertFeatureAllowed(settings, 'critique')

  const { content } = getDocumentContent(db, input.nodeId)
  const fullText = content ? docToText(content).trim() : ''
  if (fullText.length < CRITIQUE_TEXT_MIN) {
    throw new AppError(
      'VALIDATION',
      `Write at least ${CRITIQUE_TEXT_MIN} characters in this scene before asking for editor's notes`,
      { nodeId: input.nodeId, length: fullText.length }
    )
  }

  const notesDoc = getNotes(db, input.nodeId).notes
  const notesText = notesDoc ? docToText(notesDoc).trim() : ''
  const notes = notesText ? headTruncate(notesText, CRITIQUE_NOTES_CHAR_CAP) : null
  const { meta: sceneMeta } = getSceneMeta(db, input.nodeId)
  const meta = sceneMeta.location || sceneMeta.pov || sceneMeta.timeline ? sceneMeta : null
  const pov = sceneMeta.pov.trim()
  const honesty = settings.critique.honesty

  const profile = buildVoiceProfile(db, { pov: pov || undefined })
  // Chosen once, from the scene as first cut: shrinking the text afterwards never changes
  // which exemplars suit the scene, and the block is part of the estimate the fit measures.
  const voice = voiceBlock(profile, {
    text: headTruncate(fullText, CRITIQUE_SCENE_CHAR_BUDGET),
    pov: pov || null
  })

  const note = normalizeProposalNote(input.note)
  const regeneratedFrom = input.regeneratedFrom ?? null
  const isRegenerate = note !== null || regeneratedFrom !== null
  const build = (text: string): BuiltCritiquePrompt | BuiltCritiqueRegenPrompt => {
    const base: BuildCritiquePromptInput = { sceneText: text, notes, meta, voice, honesty }
    return isRegenerate ? buildCritiqueRegenPrompt({ ...base, note }) : buildCritiquePrompt(base)
  }

  // Token rule 8: count before sending, and trim the scene rather than overspend or fail.
  const { sceneText, truncated } = fitSceneToBudget(
    fullText,
    inputBudget('critique'),
    (text) => build(text).messages
  )
  const prompt = build(sceneText)

  const result = await runAiRequest(deps, {
    feature: 'critique',
    tier: 'strong',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(
      JSON.stringify({
        sceneText,
        notes,
        meta,
        honesty,
        note,
        regeneratedFrom: isRegenerate ? regeneratedFrom : null,
        voiceVersion: voiceProfileVersion()
      })
    ),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })

  const { notes: parsed, dropped } = parseCritiqueAnswer(result.text, sceneText)
  return {
    notes: parsed.map((entry) => score(entry, voice === null ? null : profile)),
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
 * The head of the scene that fits the feature's input budget (CLAUDE.md, token efficiency rule
 * 8): `CRITIQUE_SCENE_CHAR_BUDGET` first, then `CRITIQUE_SHRINK_CHARS` less at a time while the
 * built prompt is still over, down to `CRITIQUE_TEXT_MIN` (below that there is nothing worth
 * reading, and the request path's own budget refusal takes over). Measured exactly as
 * `runAiRequest` measures. `truncated` is true whenever anything was cut, either way.
 */
export function fitSceneToBudget(
  fullText: string,
  budget: number,
  build: (sceneText: string) => AiMessage[]
): { sceneText: string; truncated: boolean } {
  let chars = Math.min(fullText.length, CRITIQUE_SCENE_CHAR_BUDGET)
  let sceneText = headTruncate(fullText, chars)
  while (promptTokens(build(sceneText)) > budget && chars > CRITIQUE_TEXT_MIN) {
    chars = Math.max(CRITIQUE_TEXT_MIN, chars - CRITIQUE_SHRINK_CHARS)
    sceneText = headTruncate(fullText, chars)
  }
  return { sceneText, truncated: fullText.length > chars }
}

/** The request path's own estimate, so the fit measures what the budget check measures. */
function promptTokens(messages: AiMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join('\n'))
}

/**
 * The fidelity check (F-14.7) on a fix, skipped with no voice block or no fix. The author's
 * banned phrases (F-14.2) are checked first, so a fix that uses one is flagged by name even
 * on a project whose profile is too thin for a stylometric signal.
 */
function score(note: ParsedNote, profile: VoiceProfile | null): CritiqueNote {
  if (profile === null || note.fix === null) return { ...note, flagged: false, violation: null }
  const banned = profile.authorRules.bannedPhrases
  const violation = checkGhostTextFidelity(profile.stats, note.fix, banned).violations[0]
  return {
    ...note,
    flagged: violation !== undefined,
    violation: violation?.message ?? null
  }
}

/**
 * The model's `{ notes: [...] }` against the text that was sent: PROVIDER when the answer is
 * not JSON or not that shape at all, and lenient note by note otherwise — a note with an
 * unknown category or kind, a blank quote, or a blank reason is dropped, the strings are
 * trimmed and capped, a blank fix, a fix identical to the quote, or a fix on praise becomes
 * none (praise never diffs). Then the
 * citation rule: a quote that is not in the scene text sent (normalized on both sides) is
 * dropped and counted, praise included, so no uncited claim ever reaches the author.
 * Duplicates by quote collapse and the list is capped at `CRITIQUE_MAX_NOTES`.
 */
export function parseCritiqueAnswer(
  text: string,
  sceneText: string
): { notes: ParsedNote[]; dropped: number } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)

  const notes: ParsedNote[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of answer.data.notes) {
    const parsed = ModelNote.safeParse(entry)
    if (!parsed.success) continue
    const quote = parsed.data.quote.trim().slice(0, CRITIQUE_QUOTE_MAX).trim()
    const why = parsed.data.why.trim().slice(0, CRITIQUE_WHY_MAX).trim()
    if (!quote || !why) continue
    if (!findQuote(sceneText, quote)) {
      dropped += 1
      continue
    }
    const key = normalizeForMatch(quote)
    if (seen.has(key)) continue
    const rawFix = (parsed.data.fix ?? '').trim().slice(0, CRITIQUE_FIX_MAX).trim()
    const fix =
      parsed.data.kind === 'issue' && rawFix && normalizeForMatch(rawFix) !== key ? rawFix : null
    seen.add(key)
    notes.push({ kind: parsed.data.kind, category: parsed.data.category, quote, why, fix })
    if (notes.length === CRITIQUE_MAX_NOTES) break
  }
  return { notes, dropped }
}
