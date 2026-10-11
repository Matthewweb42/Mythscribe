import { z } from 'zod'
import type { Paragraph } from '../mentions'
import { STOPLIST } from '../proposedTags'
import { dismissedKey } from './dismissed'
import { capitalisedSpans, caseForm, normName, SENTENCE_OPENERS, type SpanWord } from './names'
import type { CaseRule, RecordKind } from './records'

/**
 * The name scan (F-16.5, design §2.2 identity rules 1–4): where a scene names its records. Local
 * and pure: main feeds it the saved scene's paragraphs and the roster (`nameIndexer.ts`), and
 * nothing is sent anywhere. The rules:
 *
 * 1. A mention is a whole capitalised span (`capitalisedSpans`) equal to a known name or alias,
 *    so "Jem Falsire" is an unknown name, not Rynna Falsire's "Falsire". Possessives count. A
 *    span joined by a link word ("Mr. Varrow of Elsdale") that is no name as a whole is tried in
 *    its parts; a span that opens a sentence is also tried without its first word ("Then Mr.
 *    Pruett", "Dearest Jo"); a span after a lower-case "the" is tried with it ("the Captain").
 *    A plural ("the Harrows") points to a group, or stays ambiguous.
 * 2. Titles are never folded here: "Mr. Harrow" and "Mrs. Harrow" are different names.
 * 3. `exact` names, and `auto` names the scene also writes in lower case ("Will" beside "will",
 *    read from the scene itself: no word list ships, decision P1-D3), match only in their exact
 *    case, and at a sentence start only when the scene names the record elsewhere mid-sentence.
 *    `any` names (typed in lower case) match on word boundaries in any case.
 * 4. A shared alias ("Harrow") is resolved when its paragraph or a neighbour (±1) names exactly
 *    one of its owners by another name, or when one owner is the scene's typed POV. Otherwise
 *    every owner gets an `ambiguous` row of the same `spanKey`.
 *
 * A phrase the author marked *Not a mention* for a record (`notMention`, keyed by the span with
 * one word either side) is never a mention of that record.
 */

/** One name of the roster as the scan reads it. */
export interface ScanAlias {
  id: string
  recordId: string
  text: string
  norm: string
  caseRule: CaseRule
  shared: boolean
}

export interface ScanRecord {
  id: string
  kind: RecordKind
}

interface IndexedAlias extends ScanAlias {
  /** `any` for a name without a capital letter, whatever is stored: it can never be a span. */
  rule: CaseRule
  /** `caseForm(text)`, compared for `exact` names. */
  form: string
}

/** The roster, ready to look names up by their norm. */
export interface NameIndex {
  byNorm: ReadonlyMap<string, readonly IndexedAlias[]>
  /** The names matched by word boundaries in any case (rule 3). */
  anyCase: readonly IndexedAlias[]
  kinds: ReadonlyMap<string, RecordKind>
}

const HAS_CAPITAL = /[\p{Lu}\p{Lt}]/u

/** Builds the lookup once per roster; `scanNames` then runs per scene. */
export function buildNameIndex(
  records: readonly ScanRecord[],
  aliases: readonly ScanAlias[]
): NameIndex {
  const kinds = new Map(records.map((record) => [record.id, record.kind]))
  const byNorm = new Map<string, IndexedAlias[]>()
  const anyCase: IndexedAlias[] = []
  for (const alias of aliases) {
    if (!kinds.has(alias.recordId) || alias.norm.length === 0) continue
    const rule: CaseRule = HAS_CAPITAL.test(alias.text) ? alias.caseRule : 'any'
    const indexed: IndexedAlias = { ...alias, rule, form: caseForm(alias.text) }
    byNorm.set(alias.norm, [...(byNorm.get(alias.norm) ?? []), indexed])
    if (rule === 'any') anyCase.push(indexed)
  }
  return { byNorm, anyCase, kinds }
}

export interface NameScanContext {
  /** The scene's typed POV record (F-16.11), which settles a shared alias it owns. */
  povRecordId: string | null
  /** `dismissedKey({ kind: 'notMention', … })` of every Not a mention the author made. */
  notMention: ReadonlySet<string>
}

/** One row of `name_mention`: a record named at a ProseMirror range of the saved document. */
export interface NameMention {
  recordId: string
  /** The paragraph's index (`passageParagraphs`). */
  para: number
  from: number
  to: number
  /** The words as the scene writes them. */
  text: string
  /** One of several possible owners ("Rynna or Tomas?"); never counted as named. */
  ambiguous: boolean
  /** `para:from`: the rows of one ambiguous span share it. */
  spanKey: string
}

/** A stored mention as `names:forNode` answers it. */
export const NameMentionView = z.object({
  id: z.string(),
  recordId: z.string(),
  para: z.number().int(),
  from: z.number().int(),
  to: z.number().int(),
  text: z.string(),
  ambiguous: z.boolean(),
  spanKey: z.string()
})
export type NameMentionView = z.infer<typeof NameMentionView>

/** A match before the shared-alias and sentence-start rules: where, what, and who it may be. */
interface RawHit {
  para: number
  start: number
  end: number
  text: string
  /** Possible owners, in roster order, after the case rules and Not a mention. */
  recordIds: string[]
  plural: boolean
  /** An exact-case match at a sentence start: it counts only if the scene names the record mid-sentence too. */
  needsMid: boolean
  /** The span opened a sentence (so it says nothing about "mid-sentence"). */
  sentenceStart: boolean
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The pattern a name is found by in running text: its words with any spaces between, on word boundaries. */
function namePattern(text: string, flags: string): RegExp | null {
  const words = caseForm(text)
    .split(' ')
    .filter((word) => word.length > 0)
  if (words.length === 0) return null
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${words.map(escapeRegExp).join('\\.?\\s+')}(?![\\p{L}\\p{N}])`,
    flags
  )
}

/** Lower-cases a string's first character (a sentence start says nothing about case). */
function foldFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/**
 * The phrase a Not a mention is keyed by: the span with one word either side (as far as the
 * paragraph goes), so "Will you" is dismissed without "Will Harrow said".
 */
export function mentionPhrase(text: string, start: number, end: number): string {
  let from = start
  while (from > 0 && !LETTER_OR_DIGIT.test(text[from - 1] ?? '')) from -= 1
  while (from > 0 && LETTER_OR_DIGIT.test(text[from - 1] ?? '')) from -= 1
  let to = end
  while (to < text.length && !LETTER_OR_DIGIT.test(text[to] ?? '')) to += 1
  while (to < text.length && LETTER_OR_DIGIT.test(text[to] ?? '')) to += 1
  return text.slice(from, to).replace(/\s+/g, ' ').trim()
}

/**
 * Every mention of a known name in one scene, in document order (ambiguous spans give one row
 * per possible owner, in roster order). `paragraphs` are the saved document's
 * (`passageParagraphs`), so `from`/`to` are positions a jump can select.
 */
export function scanNames(
  paragraphs: readonly Paragraph[],
  index: NameIndex,
  ctx: NameScanContext
): NameMention[] {
  const sceneText = paragraphs.map((paragraph) => paragraph.text).join('\n')
  /** Rule 3: an `auto` name the scene also writes in lower case is matched in its exact case. */
  const lowerUse = new Map<string, boolean>()
  const writtenLower = (alias: IndexedAlias): boolean => {
    const known = lowerUse.get(alias.id)
    if (known !== undefined) return known
    const pattern = namePattern(alias.form.toLowerCase(), 'u')
    const found = pattern?.test(sceneText) ?? false
    lowerUse.set(alias.id, found)
    return found
  }
  const isExact = (alias: IndexedAlias): boolean =>
    alias.rule === 'exact' || (alias.rule === 'auto' && writtenLower(alias))
  /** The words the scene writes in lower case, so a sentence opener it also uses as a plain word is no name. */
  const lowerWords = new Set(sceneText.match(/(?<![\p{L}\p{M}])\p{Ll}[\p{L}\p{M}]*/gu) ?? [])
  const isOpener = (word: string): boolean => {
    const lower = word.toLowerCase()
    return SENTENCE_OPENERS.has(lower) || STOPLIST.has(lower) || lowerWords.has(lower)
  }

  /** The owners `text` may name, after the case rules; `needsMid` when one is an exact match at a sentence start. */
  const lookup = (
    text: string,
    sentenceStart: boolean
  ): { recordIds: string[]; needsMid: boolean } | null => {
    const entries = index.byNorm.get(normName(text))
    if (entries === undefined) return null
    let needsMid = false
    const recordIds: string[] = []
    const form = caseForm(text)
    for (const alias of entries) {
      if (alias.rule !== 'any' && isExact(alias)) {
        const same = sentenceStart ? foldFirst(form) === foldFirst(alias.form) : form === alias.form
        if (!same) continue
        if (sentenceStart) needsMid = true
      }
      if (!recordIds.includes(alias.recordId)) recordIds.push(alias.recordId)
    }
    return recordIds.length === 0 ? null : { recordIds, needsMid }
  }

  const raw: RawHit[] = []
  paragraphs.forEach((paragraph, para) => {
    const text = paragraph.text
    const hits: RawHit[] = []
    const hit = (
      words: readonly SpanWord[],
      sentenceStart: boolean,
      found: { recordIds: string[]; needsMid: boolean },
      plural: boolean,
      start: number
    ): RawHit => {
      const last = words[words.length - 1]
      const end = last?.end ?? start
      return {
        para,
        start,
        end,
        text: text.slice(start, end),
        recordIds: found.recordIds,
        plural,
        needsMid: found.needsMid,
        sentenceStart
      }
    }
    /** Rule 1 for one run of span words: whole first, then its parts, then without its opener, then as a plural. */
    const matchWords = (
      words: readonly SpanWord[],
      sentenceStart: boolean,
      allowThe: boolean
    ): RawHit[] => {
      const first = words[0]
      const last = words[words.length - 1]
      if (first === undefined || last === undefined) return []
      const whole = text.slice(first.start, last.end)
      // "the Captain": a lower-case "the" just before the span, standing as a word.
      const theStart = first.start - 4
      if (
        allowThe &&
        theStart >= 0 &&
        text.slice(theStart, first.start) === 'the ' &&
        !LETTER_OR_DIGIT.test(text[theStart - 1] ?? '')
      ) {
        const withThe = lookup(text.slice(theStart, last.end), false)
        if (withThe !== null) return [hit(words, false, withThe, false, theStart)]
      }
      const found = lookup(whole, sentenceStart)
      if (found !== null) return [hit(words, sentenceStart, found, false, first.start)]
      if (words.some((word) => word.link)) {
        const parts: SpanWord[][] = [[]]
        for (const word of words) {
          if (word.link) parts.push([])
          else parts[parts.length - 1]?.push(word)
        }
        return parts.flatMap((part, i) =>
          matchWords(part, sentenceStart && i === 0, allowThe && i === 0)
        )
      }
      if (sentenceStart && words.length >= 2 && isOpener(first.text)) {
        return matchWords(words.slice(1), false, false)
      }
      // A plural: "Harrows" → "Harrow", "Ashbys" → "Ashby", "Marches" → "March".
      for (const cut of [/es$/u, /s$/u]) {
        if (!cut.test(whole) || whole.length < 3) continue
        const singular = lookup(whole.replace(cut, ''), sentenceStart)
        if (singular !== null) return [hit(words, sentenceStart, singular, true, first.start)]
      }
      return []
    }
    for (const span of capitalisedSpans(text)) {
      hits.push(...matchWords(span.words, span.sentenceStart, true))
    }
    // Rule 3, `any` names: anywhere on word boundaries, where no span already matched.
    for (const alias of index.anyCase) {
      const pattern = namePattern(alias.form, 'giu')
      if (pattern === null) continue
      for (const match of text.matchAll(pattern)) {
        const start = match.index
        const end = start + match[0].length
        if (hits.some((other) => start < other.end && other.start < end)) continue
        const owners = (index.byNorm.get(alias.norm) ?? [])
          .filter((other) => other.rule === 'any')
          .map((other) => other.recordId)
        hits.push({
          para,
          start,
          end,
          text: text.slice(start, end),
          recordIds: [...new Set(owners)],
          plural: false,
          needsMid: false,
          sentenceStart: false
        })
      }
    }
    // Not a mention: the owner is struck from this span, keyed by the span and its neighbours.
    for (const found of hits) {
      const phrase = mentionPhrase(text, found.start, found.end)
      found.recordIds = found.recordIds.filter(
        (recordId) => !ctx.notMention.has(dismissedKey({ kind: 'notMention', recordId, phrase }))
      )
      if (found.recordIds.length > 0) raw.push(found)
    }
  })

  // Rule 4: who each paragraph names for certain, for the shared aliases around it.
  const certain = new Map<number, Set<string>>()
  for (const found of raw) {
    if (found.plural || found.recordIds.length !== 1) continue
    const id = found.recordIds[0]
    if (id === undefined) continue
    const set = certain.get(found.para) ?? new Set<string>()
    set.add(id)
    certain.set(found.para, set)
  }

  interface Resolved extends RawHit {
    owners: string[]
    ambiguous: boolean
  }
  const resolved: Resolved[] = raw.map((found) => {
    if (found.plural) {
      const groups = found.recordIds.filter((id) => index.kinds.get(id) === 'group')
      if (groups.length === 1) return { ...found, owners: groups, ambiguous: false }
      const owners = groups.length > 1 ? groups : found.recordIds
      return { ...found, owners, ambiguous: true }
    }
    if (found.recordIds.length === 1) return { ...found, owners: found.recordIds, ambiguous: false }
    const near = new Set<string>()
    for (const para of [found.para - 1, found.para, found.para + 1]) {
      for (const id of certain.get(para) ?? []) near.add(id)
    }
    const named = found.recordIds.filter((id) => near.has(id))
    if (named.length === 1) return { ...found, owners: named, ambiguous: false }
    if (ctx.povRecordId !== null && found.recordIds.includes(ctx.povRecordId)) {
      return { ...found, owners: [ctx.povRecordId], ambiguous: false }
    }
    return { ...found, owners: found.recordIds, ambiguous: true }
  })

  // Rule 3's sentence-start half: an exact-case name at a sentence start counts only when the
  // scene names that record somewhere mid-sentence.
  const namedMid = new Set<string>()
  for (const found of resolved) {
    if (found.ambiguous || found.sentenceStart) continue
    for (const id of found.owners) namedMid.add(id)
  }

  const mentions: NameMention[] = []
  for (const found of resolved) {
    const paragraph = paragraphs[found.para]
    if (paragraph === undefined) continue
    const from = paragraph.from + found.start
    const to = paragraph.from + found.end
    for (const recordId of found.owners) {
      if (found.needsMid && !namedMid.has(recordId)) continue
      mentions.push({
        recordId,
        para: found.para,
        from,
        to,
        text: found.text,
        ambiguous: found.ambiguous,
        spanKey: `${found.para}:${from}`
      })
    }
  }
  return mentions.sort((a, b) => a.from - b.from || a.to - b.to)
}
