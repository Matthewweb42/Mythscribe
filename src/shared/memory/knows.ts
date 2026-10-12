import { z } from 'zod'
import type { ClaimMode, ClaimVoice } from './claims'
import type { RecordKind } from './records'

/**
 * Who knows what (F-16.22; design §2.5, answer 12): the vocabulary of a knows claim and the
 * rules that say whether one counts as knowing. A knows claim's record is the knower (a character
 * or a group), its object the secret, its value and `how` one of `KNOWS_HOWS`, and its `from`
 * the person they had it from (only for told, overheard and read, P2b-D6). Pure: the reader, the
 * pipeline, the views and P3's navigator all read these.
 */

/** How a knower came to know (the test book's spelling). */
export const KNOWS_HOWS = [
  'saw',
  'told',
  'overheard',
  'read',
  'deduced',
  'suspects',
  'believesFalse',
  'knewBefore',
  'tells',
  'refers'
] as const
export const KnowsHow = z.enum(KNOWS_HOWS)
export type KnowsHow = z.infer<typeof KnowsHow>

/** Learning it in the story: saw, told, overheard, read, deduced. */
export const LEARNS: readonly KnowsHow[] = ['saw', 'told', 'overheard', 'read', 'deduced']
/** Holding it already: knew before, tells someone, refers to it. */
export const HOLDS: readonly KnowsHow[] = ['knewBefore', 'tells', 'refers']
/** Half-knowing: suspects, believes otherwise. Shown as such; never counts as knowing (P2b-D7). */
export const PARTIAL: readonly KnowsHow[] = ['suspects', 'believesFalse']
/** The only hows that keep a `from` (P2b-D6): the person it was told, overheard or read from. */
export const FROM_HOWS: readonly KnowsHow[] = ['told', 'overheard', 'read']

/** How a line names a how ("overheard", "believes otherwise", "knew before"). */
export const HOW_LABEL: Readonly<Record<KnowsHow, string>> = {
  saw: 'saw',
  told: 'told',
  overheard: 'overheard',
  read: 'read',
  deduced: 'deduced',
  suspects: 'suspects',
  believesFalse: 'believes otherwise',
  knewBefore: 'knew before',
  tells: 'tells',
  refers: 'refers to it'
}

const SPELLINGS: Readonly<Record<string, KnowsHow>> = Object.fromEntries(
  KNOWS_HOWS.map((how) => [how.toLowerCase(), how])
)

/**
 * The how a reader or checker wrote, read leniently: case, spaces, hyphens and underscores do not
 * matter ("believes-false", "knew before"); anything else is null (no verdict on it).
 */
export function parseHow(text: string | null | undefined): KnowsHow | null {
  if (typeof text !== 'string') return null
  return SPELLINGS[text.toLowerCase().replace(/[\s_-]+/g, '')] ?? null
}

/** Whether the how keeps a `from` (told, overheard, read). */
export const keepsFrom = (how: KnowsHow): boolean => FROM_HOWS.includes(how)

/** A knows line as the rules read it. */
export interface KnowsLineInput {
  how: string | null
  voice: ClaimVoice
  mode: ClaimMode
  /** The knower. */
  recordId: string | null
  /** The speaker of a dialogue line. */
  speakerId: string | null
  fromId: string | null
}

/**
 * What a knows line is (P2b-D7):
 * - `counts`: it shows the knower knowing. Mode `now` or `memory`; the narration, or the knower's
 *   own thought (a thought keeps its thinker as `speakerId`: "Orrin knew, Mara thought" is Mara's
 *   belief about Orrin, not Orrin knowing; a thought with no thinker stored reads as the
 *   knower's), or dialogue the knower speaks while holding it (tells, refers, knew before), or
 *   dialogue spoken by the `from` of a told, overheard or read line (the learner heard it);
 * - `partial`: the same, with a how of `PARTIAL` (suspects, believes otherwise; in dialogue, the
 *   knower's own words): shown as such, never counted as knowing;
 * - `other`: never counted: a rumour, a hypothetical, a dream, dialogue or a thought by anyone
 *   else, or a how the rules do not know.
 */
export function knowsLine(line: KnowsLineInput): 'counts' | 'partial' | 'other' {
  const how = parseHow(line.how)
  if (how === null || line.recordId === null) return 'other'
  if (line.mode !== 'now' && line.mode !== 'memory') return 'other'
  let shows = false
  switch (line.voice) {
    case 'narration':
      shows = true
      break
    case 'thought':
      shows = line.speakerId === null || line.speakerId === line.recordId
      break
    case 'dialogue':
      shows =
        line.speakerId !== null &&
        ((line.speakerId === line.recordId && (HOLDS.includes(how) || PARTIAL.includes(how))) ||
          (line.speakerId === line.fromId && FROM_HOWS.includes(how)))
      break
    case 'rumour':
      shows = false
      break
  }
  if (!shows) return 'other'
  return PARTIAL.includes(how) ? 'partial' : 'counts'
}

/** Whether a knows line counts as knowing (`knowsLine` is `counts`). */
export const knowsCounts = (line: KnowsLineInput): boolean => knowsLine(line) === 'counts'

/**
 * Whether a learner may know a secret in this scene (P2b-D8): a character must be Here (the POV,
 * on the page, or *+ also here*); a group is exempt (the caller checks that the quote names it);
 * nothing else is a knower.
 */
export function learnerHere(
  recordId: string,
  here: ReadonlySet<string>,
  kind: RecordKind | null | undefined
): boolean {
  if (kind === 'group') return true
  return kind === 'character' && here.has(recordId)
}

/** The kinds a knower may be. */
export const KNOWER_KINDS: readonly RecordKind[] = ['character', 'group']

/**
 * The slot a knows line's *Not right* key uses (P2b-D6): `knows:<secretId>` with its how as the
 * value, under the learner; *Same as…* of either record re-keys it.
 */
export const knowsNotRightSlot = (secretId: string): string => `knows:${secretId}`
