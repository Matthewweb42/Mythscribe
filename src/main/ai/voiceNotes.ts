import { z } from 'zod'
import { estimateTokens, inputBudget } from '@shared/ai'
import {
  VOICE_NOTE_MAX_CHARS,
  VOICE_NOTES_MAX,
  VOICE_NOTES_MIN_WORDS,
  VOICE_NOTES_REFRESH_WORDS,
  VOICE_NOTES_SAMPLE_CHARS,
  type VoiceNotes
} from '@shared/voice'
import { AppError } from '../ipc/errors'
import { getAiSettings, getVoiceNotes, setVoiceNotes } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptPassages } from '../voice/autoExemplars'
import { manuscriptDocuments } from '../voice/profile'
import { bumpVoiceVersion } from '../voice/versionCache'
import { assertFeatureAllowed } from './dial'
import { buildVoiceNotesPrompt } from './prompts/voiceNotes.v1'
import { AiFallbackError, type AiMessage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/**
 * Learned style notes, the AI half of automatic voice learning (F-14.14, decided by Claude,
 * unconfirmed). Derived index data (`PLAN.md` §2.6): the author never accepts them, they are
 * stored in their own settings row apart from the author's rules, shown in the Voice section
 * as AI-made with Clear, costed in the ledger, and never in the manuscript.
 */

/**
 * Whether a refresh is due for a manuscript of `words` words: the first one once the manuscript
 * holds `VOICE_NOTES_MIN_WORDS`, then one per `VOICE_NOTES_REFRESH_WORDS` words of change
 * since the last write (a Clear counts as one, so cleared notes come back only after that much
 * more writing).
 */
export function voiceNotesDue(
  stored: Pick<VoiceNotes, 'basedOnWords'> | null,
  words: number
): boolean {
  if (stored === null) return words >= VOICE_NOTES_MIN_WORDS
  return Math.abs(words - stored.basedOnWords) >= VOICE_NOTES_REFRESH_WORDS
}

/**
 * The passages the prompt reads, pure: the newest passage first, then every `stride`-th one
 * walking back to the start, so the sample spans the book and leans on what was written last,
 * while the total stays within `maxChars`; answered in reading order. A passage that does not
 * fit is skipped, not cut.
 */
export function sampleVoicePassages(passages: readonly string[], maxChars: number): string[] {
  if (passages.length === 0) return []
  const average = passages.reduce((sum, p) => sum + p.length, 0) / passages.length
  const wanted = Math.max(1, Math.floor(maxChars / Math.max(average, 1)))
  const stride = Math.max(1, Math.floor(passages.length / wanted))
  const picked: number[] = []
  let used = 0
  for (let i = passages.length - 1; i >= 0; i -= stride) {
    const text = passages[i] ?? ''
    const cost = text.length + (picked.length > 0 ? 2 : 0)
    if (used + cost > maxChars) continue
    picked.push(i)
    used += cost
  }
  return picked.sort((a, b) => a - b).map((i) => passages[i] ?? '')
}

const ModelAnswer = z.object({ notes: z.array(z.unknown()) })

const BAD_FORMAT = 'The model did not answer in the expected format.'

/**
 * The model's `{ notes: [...] }`: PROVIDER when the answer is not JSON or not that shape, and
 * lenient note by note otherwise — a leading list marker is stripped, the note trimmed and cut
 * to `VOICE_NOTE_MAX_CHARS` at a word boundary; a non-string, a blank, a repeat, or anything
 * past the `VOICE_NOTES_MAX`th kept note is dropped.
 */
export function parseVoiceNotesAnswer(text: string): string[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)
  const notes: string[] = []
  for (const entry of answer.data.notes) {
    if (notes.length >= VOICE_NOTES_MAX) break
    if (typeof entry !== 'string') continue
    const note = cutNote(entry.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    if (note !== '' && !notes.includes(note)) notes.push(note)
  }
  return notes
}

function cutNote(note: string): string {
  if (note.length <= VOICE_NOTE_MAX_CHARS) return note
  const slice = note.slice(0, VOICE_NOTE_MAX_CHARS)
  const boundary = slice.search(/\s\S*$/)
  return (boundary > 0 ? slice.slice(0, boundary) : slice).trimEnd()
}

export interface VoiceNotesRun {
  notes: VoiceNotes
  /** Whether the answer came from the local cache (nothing was sent). */
  cached: boolean
  costUsd: number
}

/**
 * Refreshes the learned style notes: the gate first (`voiceNotes` allowed), then a sample of the
 * author's own passages (`manuscriptPassages`: no AI-origin text) within
 * `VOICE_NOTES_SAMPLE_CHARS`, dropped from the front while the prompt is over
 * `inputBudget('voiceNotes')` (token rule 8), with the stored notes, to the fast tier as JSON.
 * VALIDATION when the manuscript has no passage of the author's to read. The answer replaces
 * the stored notes and moves the voice profile's version, so every later prompt carries them.
 */
export async function refreshVoiceNotes(
  db: TreeDb,
  deps: AiRequestDeps,
  input: { requestId?: string } = {}
): Promise<VoiceNotesRun> {
  assertFeatureAllowed(getAiSettings(db), 'voiceNotes')
  const rows = manuscriptDocuments(db)
  const words = rows.reduce((sum, row) => sum + row.wordCount, 0)
  let passages = sampleVoicePassages(
    manuscriptPassages(db, rows).map((p) => p.text),
    VOICE_NOTES_SAMPLE_CHARS
  )
  if (passages.length === 0) {
    throw new AppError('VALIDATION', 'There is not enough of your own prose to learn from yet', {
      words
    })
  }
  const previous = getVoiceNotes(db)?.notes ?? []
  const build = (sample: string[]): ReturnType<typeof buildVoiceNotesPrompt> =>
    buildVoiceNotesPrompt({ passages: sample, previous })
  while (
    passages.length > 1 &&
    promptTokens(build(passages).messages) > inputBudget('voiceNotes')
  ) {
    passages = passages.slice(1)
  }
  const prompt = build(passages)
  const result = await runAiRequest(deps, {
    feature: 'voiceNotes',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(JSON.stringify({ passages, previous })),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })
  const notes = setVoiceNotes(db, {
    notes: parseVoiceNotesAnswer(result.text),
    basedOnWords: words,
    model: result.model,
    updated: deps.now().toISOString()
  })
  bumpVoiceVersion()
  return { notes, cached: result.cached, costUsd: result.costUsd }
}

/**
 * Clears the learned notes (the Voice section's Clear): the list empties and the word count is
 * remembered, so the background job learns again only after `VOICE_NOTES_REFRESH_WORDS` more
 * words. Answers what is stored, or null when nothing ever was.
 */
export function clearVoiceNotes(db: TreeDb, now: Date): VoiceNotes | null {
  if (getVoiceNotes(db) === null) return null
  const words = manuscriptDocuments(db).reduce((sum, row) => sum + row.wordCount, 0)
  const stored = setVoiceNotes(db, {
    notes: [],
    basedOnWords: words,
    model: null,
    updated: now.toISOString()
  })
  bumpVoiceVersion()
  return stored
}

function promptTokens(messages: AiMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join('\n'))
}
