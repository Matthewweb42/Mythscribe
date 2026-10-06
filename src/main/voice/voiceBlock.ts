import { estimateTokens } from '@shared/ai'
import { renderAuthorRulesBlock } from '@shared/authorRules'
import type { VoiceProfile } from '@shared/ipc/contract'
import { classifyKind } from '@shared/stylometry'
import { VOICE_BLOCK_TOKEN_BUDGET, VOICE_NOTES_TOKEN_BUDGET } from '@shared/voice'
import { normalizePov } from './profile'

/** At most this many exemplars are folded into one prompt. */
export const VOICE_BLOCK_MAX_EXEMPLARS = 3
/** A truncated first exemplar shorter than this says nothing; the block goes out without one. */
const TRUNCATED_MIN_CHARS = 40

export interface VoiceSituation {
  /** The passage the model is about to continue (the text before the caret); its kind picks the exemplars. */
  text: string
  /** The scene's POV, or null; an exemplar from the same POV ranks higher. */
  pov: string | null
}

/** The heading of the learned style notes inside the voice block (F-14.14). */
export const VOICE_NOTES_HEADING = 'Style notes learned from the manuscript:'

/**
 * The voice block a prompt carries (F-14.1), pure: the stylometric rules as a list, then the
 * learned style notes (F-14.14) as their own list, as many as fit `VOICE_NOTES_TOKEN_BUDGET`,
 * then the author's rules (F-14.2) as their own paragraph, then up to three exemplars chosen
 * for the situation (same kind as the passage first, then same POV, then hand-marked before
 * automatic, then the profile's order), whole,
 * while the rules and exemplars stay under `VOICE_BLOCK_TOKEN_BUDGET` estimated tokens. The
 * author block is budgeted separately (`AUTHOR_RULES_TOKEN_BUDGET`): they are hard constraints,
 * so an exemplar never crowds them out and they never cost an exemplar its place. When even the
 * first exemplar would blow the budget it is cut at a word boundary so at least one example
 * goes out; a later one that does not fit is dropped, never cut. Null only when there is
 * nothing at all to send; a fresh project still has the seeded banned phrases, so its block is
 * the author's rules alone, without the "Match the author's voice" heading.
 */
export function voiceBlock(profile: VoiceProfile, situation: VoiceSituation): string | null {
  const author = renderAuthorRulesBlock(profile.authorRules)
  if (profile.rules.length === 0 && profile.exemplars.length === 0 && profile.notes.length === 0) {
    return author
  }
  let rules = ["Match the author's voice:", ...profile.rules.map((rule) => `- ${rule}`)].join('\n')
  const notes = notesBlock(profile.notes)
  if (notes !== null) rules += `\n\n${notes}`
  let block = rules
  const kind = classifyKind(situation.text)
  const pov = normalizePov(situation.pov)
  const ranked = profile.exemplars
    .map((exemplar, index) => ({
      exemplar,
      index,
      score:
        (exemplar.kind === kind ? 2 : 0) +
        (pov.length > 0 && normalizePov(exemplar.pov) === pov ? 1 : 0)
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        sourceRank(a.exemplar.source) - sourceRank(b.exemplar.source) ||
        a.index - b.index
    )

  let appended = 0
  for (const { exemplar } of ranked) {
    if (appended >= VOICE_BLOCK_MAX_EXEMPLARS) break
    const whole = example(exemplar.text)
    if (estimateTokens(block + whole) <= VOICE_BLOCK_TOKEN_BUDGET) {
      block += whole
      appended += 1
      continue
    }
    if (appended === 0) {
      const overhead = estimateTokens(block + example('…'))
      const room = (VOICE_BLOCK_TOKEN_BUDGET - overhead) * 4
      if (room >= TRUNCATED_MIN_CHARS) block += example(`${cutAtWord(exemplar.text, room)}…`)
    }
    break
  }
  const examples = block.slice(rules.length)
  return author === null ? block : `${rules}\n\n${author}${examples}`
}

/** Hand-marked exemplars (F-14.1) rank ahead of the voice job's picks (F-14.14) on a tie. */
function sourceRank(source: 'author' | 'auto'): number {
  return source === 'author' ? 0 : 1
}

/** The learned notes as a list, in order, while it stays within `VOICE_NOTES_TOKEN_BUDGET`; null for none. */
function notesBlock(notes: readonly string[]): string | null {
  let block = VOICE_NOTES_HEADING
  let kept = 0
  for (const note of notes) {
    const next = `${block}\n- ${note}`
    if (estimateTokens(next) > VOICE_NOTES_TOKEN_BUDGET) break
    block = next
    kept += 1
  }
  return kept === 0 ? null : block
}

function example(text: string): string {
  return `\n\nExample in this voice:\n"""\n${text}\n"""`
}

/** The longest prefix of `text` within `max` characters that ends at a word boundary. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const boundary = slice.search(/\s\S*$/)
  return (boundary > 0 ? slice.slice(0, boundary) : slice).trimEnd()
}
