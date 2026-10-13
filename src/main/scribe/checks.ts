import type { QuestionCues } from '@shared/memory/askParse'
import {
  evidenceTag,
  NAVIGATION_TERMS_MAX,
  sameEvidence,
  type EvidenceKey,
  type EvidenceLabel,
  type Navigation,
  type SearchHit,
  type SearchScope
} from '@shared/scribe'
import { quoteContext, type ParsedAnswer, type SentenceVerdict } from '@shared/scribeAnswer'
import {
  CITE_CONTEXT_CHARS,
  CITE_SCOPE_HITS_MAX,
  type CitePromptScope,
  type CitePromptSentence,
  type CiteReply,
  type CiteVerdict
} from '../ai/prompts/cite.v1'
import type { UnsupportedReason } from '../ai/prompts/agent.v9'
import { snippetAround } from '../memory/passageIndexer'
import { rowTexts } from '../memory/reading/readingFrame'
import type { EvidenceFrame } from './evidence'
import type { Step0 } from './step0'

/**
 * Ms Scribe's checks after code's quote check (F-16.25; plan P3 §3.3, P3-D8, P3-D14): the scope
 * rule (a first/last/ever/never or knows question is answered over every scene up to now, widened
 * locally when the navigation searched less), what `cite.v1` is sent (each cited sentence with its
 * quotes in their sentences ±1; the scope item with the earlier passages the search found), and
 * how its verdicts land (a `no` drops the sentence's citations and marks it unsupported; a `yes`
 * raises its citations to "quote and sentence checked"; the first sentence unsupported is the
 * main claim the answer is asked again about). Pure but for reading the scenes' current text.
 */

/** A question whose answer must say what was searched: first, last, ever, never, how many, knows. */
export function scopeAsked(cues: Pick<QuestionCues, 'scopeAll' | 'knows' | 'learns'>): boolean {
  return cues.scopeAll || cues.knows || cues.learns
}

/** Whether a search covered every scene up to now (or the whole book, when the question asks). */
export function coversScope(scope: SearchScope | null, wholeBook: boolean): boolean {
  if (scope === null) return false
  return scope.wholeBook || (!wholeBook && scope.allEarlier)
}

/** The evidence, scope, words and hits an answer is built from. */
export interface ScopedSearch {
  keys: EvidenceKey[]
  scope: SearchScope | null
  terms: string[]
  hits: SearchHit[]
  /** True when the navigation's narrower search was widened with Step 0's (P3 §3.3 step 2). */
  widened: boolean
}

/**
 * The scope rule (P3 §3.3 step 2, P3-D8): without a navigation, Step 0's menu and its search;
 * with one, its keys and search, unless the question needs every scene up to now (or the whole
 * book) and the navigation searched less: then Step 0's every-earlier-scene search, run for this
 * question already, is added (its scene hits after the navigation's keys, its words joined, its
 * hits first and every one kept) and its scope is the answer's.
 */
export function enforceScope(
  navigation: Navigation | null,
  step0: Pick<Step0, 'cues' | 'scope' | 'menu' | 'hits' | 'terms'>
): ScopedSearch {
  const menuKeys = step0.menu.map((item) => item.key)
  if (navigation === null) {
    return {
      keys: menuKeys,
      scope: step0.scope,
      terms: step0.terms,
      hits: step0.hits,
      widened: false
    }
  }
  const asIs: ScopedSearch = {
    keys: navigation.evidence,
    scope: navigation.scope,
    terms: navigation.terms,
    hits: navigation.hits,
    widened: false
  }
  if (!scopeAsked(step0.cues) || coversScope(navigation.scope, step0.cues.wholeBook)) return asIs
  if (step0.scope === null) return asIs
  const keys = [...navigation.evidence]
  for (const key of menuKeys) {
    if (key.kind !== 'passage' || key.source !== 'scene') continue
    if (!keys.some((each) => sameEvidence(each, key))) keys.push(key)
  }
  // Step 0's hits first and all kept (the scope is its search: the scope item and the search-miss
  // check read them), then the navigation's; each list holds at most 50 already.
  const hits = [...step0.hits]
  for (const hit of navigation.hits) {
    if (!hits.some((each) => each.nodeId === hit.nodeId && each.para === hit.para)) hits.push(hit)
  }
  return {
    keys,
    scope: step0.scope,
    terms: [...new Set([...navigation.terms, ...step0.terms])].slice(0, NAVIGATION_TERMS_MAX),
    hits,
    widened: true
  }
}

/** A sent item as the checks read it (`runScribe`'s `SentItem`). */
export interface CheckedItem {
  label: EvidenceLabel
  ref: string
  doc: string | null
  quotable: readonly string[]
  /**
   * Where a quote's neighbouring sentences are read: a scene's paragraphs as one run (a quote's
   * sentence ±1 may lie in the next paragraph), else the quotable stretches apart (who-knows
   * quotes from different scenes are not neighbours).
   */
  context: readonly string[]
  open: { kind: 'scene' | 'record' | 'research'; id: string } | null
  /** E0 is tagged "the open scene 9.3", as the answer was sent it. */
  e0: boolean
}

/** A citation's tag as the answer was sent it, with the paragraph it lands in. */
export function citeTag(item: CheckedItem, para: number | null): string {
  const where = `${item.e0 ? 'the open scene ' : ''}${item.ref}${para === null ? '' : ` ¶${para}`}`
  return evidenceTag(item.label, where, item.doc)
}

/** One sentence the check is sent: its index in the answer and its kept citations. */
export interface CitedSentence {
  index: number
  sentence: CitePromptSentence
}

/**
 * A quote's context as the check reads it: its sentence ±1 (`quoteContext`), or its own sentence
 * alone when that is longer than the check sends (`CITE_CONTEXT_CHARS`), so the neighbours are
 * cut before the quote's own sentence is; `cite.v1` then clips around the quote.
 */
function contextOf(quotable: readonly string[], quote: string): string {
  const wide = quoteContext(quotable, quote)
  if (wide === null) return quote
  return wide.length <= CITE_CONTEXT_CHARS ? wide : (quoteContext(quotable, quote, 0) ?? wide)
}

/**
 * The sentences `cite.v1` rules on: every sentence with a kept citation, in the answer's order,
 * each kept quote with its sentence ±1 in the item as sent (`contextOf`).
 */
export function citedSentences(
  parsed: Pick<ParsedAnswer, 'sentences'>,
  verdicts: readonly SentenceVerdict[],
  itemOf: (evidence: string) => CheckedItem | undefined,
  paraOf: (evidence: string, quote: string) => number | null
): CitedSentence[] {
  return parsed.sentences.flatMap((sentence, index) => {
    const keep = verdicts[index]?.keep ?? []
    const quotes = sentence.citations.flatMap((citation, j) => {
      const item = keep[j] === true ? itemOf(citation.evidence) : undefined
      if (item === undefined) return []
      return [
        {
          evidence: citation.evidence,
          tag: citeTag(item, paraOf(citation.evidence, citation.quote)),
          quote: citation.quote,
          context: contextOf(item.context, citation.quote)
        }
      ]
    })
    return quotes.length === 0 ? [] : [{ index, sentence: { text: sentence.text, quotes } }]
  })
}

/** A place in the book's reading order: a scene's order and a paragraph (-1: the scene as a whole). */
interface Place {
  order: number
  para: number
}

const before = (a: Place, b: Place): boolean =>
  a.order < b.order || (a.order === b.order && a.para < b.para)

/**
 * The scope item's passages (P3 §3.2): the search's hits in manuscript scenes before the cited
 * place in reading order (after it, for a last or latest answer; every hit when nothing is cited),
 * the nearest to the start of the search first (the latest first for a last answer), at most five,
 * each with its words around the search terms as the scene reads now.
 */
export function scopeHits(
  frame: EvidenceFrame,
  hits: readonly SearchHit[],
  cited: { nodeId: string; para: number | null } | null,
  options: { latest: boolean; terms: readonly string[] }
): CitePromptScope['hits'] {
  const at =
    cited === null
      ? null
      : (() => {
          const order = frame.reading.order.get(cited.nodeId)
          return order === undefined ? null : { order, para: cited.para ?? -1 }
        })()
  if (cited !== null && at === null) return []
  const placed = hits.flatMap((hit) => {
    const order = frame.reading.order.get(hit.nodeId)
    if (order === undefined) return []
    const place = { order, para: hit.para }
    if (at !== null) {
      const same = place.order === at.order && (at.para < 0 || place.para === at.para)
      if (same) return []
      if (options.latest ? !before(at, place) : !before(place, at)) return []
    }
    const row = frame.documents.get(hit.nodeId)
    const text = row === undefined ? undefined : rowTexts(row)[hit.para]
    if (text === undefined || text.trim() === '') return []
    return [{ place, hit, text }]
  })
  const sign = options.latest ? -1 : 1
  placed.sort((a, b) => sign * (a.place.order - b.place.order || a.place.para - b.place.para))
  return placed.slice(0, CITE_SCOPE_HITS_MAX).map(({ hit, text }) => ({
    ref: `${frame.reading.refs.get(hit.nodeId) ?? ''} ¶${hit.para}`.trim(),
    text: snippetAround(
      text,
      options.terms.map((term) => term.toLowerCase())
    )
  }))
}

/** What the check found, per sentence of the answer, and for the main claim. */
export interface CiteOutcome {
  /** Per sentence index: the checker's verdict, or null (not sent, or no verdict). */
  verdicts: Map<number, CiteVerdict>
  /** Why the first sentence is unsupported by the checker's verdicts; null when it is not. */
  main: UnsupportedReason | null
}

/**
 * The checker's reply on the sentences sent (the first `sent` of `cited`), mapped back to the
 * answer's sentences: a `no` marks its sentence unsupported in `verdicts` (its citations then go,
 * `markerize`); the main claim (sentence `claimAt`: 0, or 1 after a bare yes or no) is
 * unsupported when it was found `no`, or when the scope item found the same thing earlier (later
 * for a last answer; for an answer that found nothing, the thing it said was not found).
 */
export function applyCite(
  reply: CiteReply,
  cited: readonly CitedSentence[],
  sent: number,
  verdicts: SentenceVerdict[],
  scope: { sent: boolean; latest: boolean; absence: boolean; claimAt: number }
): CiteOutcome {
  const found = new Map<number, CiteVerdict>()
  cited.slice(0, sent).forEach((each, i) => {
    const verdict = reply.verdicts.get(i + 1)
    if (verdict === undefined) return
    found.set(each.index, verdict)
    const current = verdicts[each.index]
    if (verdict === 'no' && current !== undefined) {
      verdicts[each.index] = { ...current, unsupported: true }
    }
  })
  let main: UnsupportedReason | null = found.get(scope.claimAt) === 'no' ? 'quotesDoNotSay' : null
  if (main === null && scope.sent && reply.scope === 'earlier') {
    main = scope.absence ? 'notFoundShown' : scope.latest ? 'later' : 'earlier'
  }
  return { verdicts: found, main }
}

/**
 * How far each kept citation was checked (`ScribeCitation.checked`): `cite` when every sentence
 * that kept it was found `yes`, else `quote` (code's check alone: not sent, no verdict, `partly`).
 */
export function citationLevels(
  parsed: Pick<ParsedAnswer, 'sentences'>,
  verdicts: readonly SentenceVerdict[],
  found: ReadonlyMap<number, CiteVerdict>
): Map<string, 'quote' | 'cite'> {
  const levels = new Map<string, 'quote' | 'cite'>()
  parsed.sentences.forEach((sentence, index) => {
    const keep = verdicts[index]?.keep ?? []
    sentence.citations.forEach((citation, j) => {
      if (keep[j] !== true) return
      const key = `${citation.evidence}\u0000${citation.quote}`
      const level = found.get(index) === 'yes' ? 'cite' : 'quote'
      levels.set(key, levels.get(key) === 'quote' ? 'quote' : level)
    })
  })
  return levels
}
