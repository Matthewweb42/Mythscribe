import { z } from 'zod'
import { editDistance } from '../storyNames'
import { foldTitles, gateWords } from './names'

/**
 * The twin gate (F-16.4, design §2.2 identity rule 5): the check every new record and every new
 * name goes through before it exists, so the story never grows a second Liesel spelled "Liesl".
 * Pure and local. The rules, in order:
 *
 * 1. `alias`: the name equals a known name or alias once case, diacritics, full stops, a
 *    possessive and the spelling of titles are folded ("Mrs Harrow" is "Mrs. Harrow"), or, failing
 *    that, once the titles are taken out of both ("Captain Brand" against "Brand").
 * 2. `subset`: with titles taken out, its words are a subset of a known name's words, or a known
 *    name's words a subset of its ("Callum" and "Callum Varrow").
 * 3. `prefix`: it is a prefix (at least 2 letters) of a word of a known name that has 4 letters
 *    or more ("Ash" and "Ashby").
 * 4. `edit`: it is 1 edit from a known name of 5–7 letters, or 2 from one of 8 or more ("Liesl"
 *    and "Liesel"); a one-word name is also compared with each word of a longer name.
 * 5. `dismissed`: it is on the Dismissed list (blocked silently: nothing is asked).
 *
 * An app-made name that the gate blocks is never created (it becomes a nickname question, or
 * nothing at all when dismissed). The author's own new record is warned about, never blocked
 * (decision P1-D4): `record:create` with `force`.
 */

export const TWIN_RULES = ['alias', 'subset', 'prefix', 'edit', 'dismissed'] as const
export const TwinRule = z.enum(TWIN_RULES)
export type TwinRule = z.infer<typeof TwinRule>

/** The gate's answer over IPC (`record:gate`, a blocked `record:create`). */
export const TwinGateBlocked = z.object({
  outcome: z.literal('blocked'),
  rule: TwinRule,
  /** The record the name points to; null for a dismissed name. */
  recordId: z.string().nullable(),
  /** The known name (or dismissed name) it matched. */
  matched: z.string()
})
export const TwinGateVerdict = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('clear') }),
  TwinGateBlocked
])

/** A name word shorter than this is never matched by the prefix rule as the longer side. */
export const TWIN_PREFIX_NAME_MIN = 4
/** The shortest name the prefix rule tests as a prefix. */
export const TWIN_PREFIX_MIN = 2
/** Known names of this many letters or more allow one edit… */
export const TWIN_EDIT_ONE_FROM = 5
/** …and from this many, two. */
export const TWIN_EDIT_TWO_FROM = 8

/** One record as the gate sees it: its id and every name it answers to, the main name first. */
export interface TwinRosterRecord {
  id: string
  names: readonly string[]
}

export type TwinGateResult = z.infer<typeof TwinGateVerdict>

interface FoldedName {
  recordId: string
  name: string
  /** `gateWords` joined: titles kept, in their one spelling. */
  titled: string
  /** `foldTitles(gateWords)`: titles out. */
  bare: string[]
}

function folded(roster: readonly TwinRosterRecord[]): FoldedName[] {
  return roster.flatMap((record) =>
    record.names.map((name) => {
      const words = gateWords(name)
      return { recordId: record.id, name, titled: words.join(' '), bare: foldTitles(words) }
    })
  )
}

/** How many edits a known name of `letters` letters allows; 0 when it is too short for the rule. */
function editsAllowed(letters: number): number {
  if (letters >= TWIN_EDIT_TWO_FROM) return 2
  if (letters >= TWIN_EDIT_ONE_FROM) return 1
  return 0
}

const isSubset = (a: readonly string[], b: readonly string[]): boolean =>
  a.length > 0 && a.every((word) => b.includes(word))

/**
 * Runs the gate for `candidate` against `roster` and the dismissed names (as the author or the
 * app saw them; compared by the gate's own folding). The first rule that blocks wins, and within
 * a rule the first record in roster order.
 */
export function twinGate(
  candidate: string,
  roster: readonly TwinRosterRecord[],
  dismissedNames: readonly string[] = []
): TwinGateResult {
  const words = gateWords(candidate)
  if (words.length === 0) return { outcome: 'clear' }
  const titled = words.join(' ')
  const bare = foldTitles(words)
  const joined = bare.join('')
  const names = folded(roster)
  const blocked = (rule: TwinRule, hit: FoldedName): TwinGateResult => ({
    outcome: 'blocked',
    rule,
    recordId: hit.recordId,
    matched: hit.name
  })

  // 1. alias: the same name once folded; titles kept first, so "Mrs Harrow" finds Mrs. Harrow
  // before the shared "Harrow" of her husband.
  const sameTitled = names.find((name) => name.titled === titled)
  if (sameTitled) return blocked('alias', sameTitled)
  if (bare.length > 0) {
    const sameBare = names.find((name) => name.bare.join(' ') === bare.join(' '))
    if (sameBare) return blocked('alias', sameBare)
  }

  // 2. subset, either way, titles out.
  const subset = names.find((name) => isSubset(bare, name.bare) || isSubset(name.bare, bare))
  if (subset) return blocked('subset', subset)

  // 3. prefix of a longer name word.
  if (bare.length === 1 && joined.length >= TWIN_PREFIX_MIN) {
    const prefix = names.find((name) =>
      name.bare.some(
        (word) => word.length >= TWIN_PREFIX_NAME_MIN && word !== joined && word.startsWith(joined)
      )
    )
    if (prefix) return blocked('prefix', prefix)
  }

  // 4. edit distance by the known name's length (letters, spaces left out).
  if (joined.length > 0) {
    const edit = names.find((name) => {
      const targets = [name.bare.join(''), ...(bare.length === 1 ? name.bare : [])]
      return targets.some((target) => {
        const max = editsAllowed(target.length)
        if (max === 0 || target === joined) return false
        return editDistance(joined, target, max) <= max
      })
    })
    if (edit) return blocked('edit', edit)
  }

  // 5. dismissed, silently.
  const dismissed = dismissedNames.find((name) => gateWords(name).join(' ') === titled)
  if (dismissed !== undefined) {
    return { outcome: 'blocked', rule: 'dismissed', recordId: null, matched: dismissed }
  }
  return { outcome: 'clear' }
}

/** Two existing records the gate would have kept apart, for the switch-over's merge list. */
export interface TwinPair {
  /** The record whose name was tested. */
  a: string
  /** The record it ran into. */
  b: string
  rule: Exclude<TwinRule, 'dismissed'>
  /** `a`'s name that was tested, and `b`'s name it matched. */
  name: string
  matched: string
}

/**
 * The pairs of existing records the gate blocks between them (each name of every record tested
 * against the others), one pair per two records, in roster order. A shared alias (identity rule
 * 4) is two records on purpose, so names marked shared are left out of the test by the caller.
 */
export function twinPairs(roster: readonly TwinRosterRecord[]): TwinPair[] {
  const pairs: TwinPair[] = []
  const seen = new Set<string>()
  for (const record of roster) {
    const others = roster.filter((other) => other.id !== record.id)
    for (const name of record.names) {
      const result = twinGate(name, others)
      if (result.outcome !== 'blocked' || result.recordId === null) continue
      if (result.rule === 'dismissed') continue
      const key = [record.id, result.recordId].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({
        a: record.id,
        b: result.recordId,
        rule: result.rule,
        name,
        matched: result.matched
      })
    }
  }
  return pairs
}
