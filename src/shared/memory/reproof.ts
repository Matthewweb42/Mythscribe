import {
  anchorFor,
  anchorHolds,
  anchorInPlace,
  type MemoryAnchor,
  type SceneSentence
} from './anchor'
import type { CardFields, CardPresent, Claim } from './claims'
import { literalProof, type LiteralName } from './literal'
import { hasReproofMarker } from './markers'
import { locateQuote, type QuoteLocation } from './quote'
import { splitSentences } from './sentences'

/**
 * Invalidation (F-16.17; design §2.3 "Invalidation"): on every save, each live claim's anchor
 * (its quote's sentences ±1, and the naming sentence for a pronoun subject) is checked against
 * the scene's sentences, in place (`anchorInPlace`: the same sentences, side by side, in order).
 * A claim whose anchor holds stays live, and follows its quote when paragraphs above it come or
 * go (`moved`). Any other goes stale, except a literal claim that re-proves for free: its quote
 * is still word for word in the scene (once), its code proof still passes there, and the
 * sentences that are new in its anchor bring no re-proof marker (dream, remembered, said, if,
 * not …). It then stays live with its new paragraph and anchor. Verified claims never re-prove
 * for free: only a reading revives them.
 *
 * A stale claim whose anchor holds in place again (the edit was undone, or the renamed text came
 * back) is `restored`: the very sentences that proved it are back. A claim waiting on its subject
 * is judged the same way (it goes stale, follows its quote, or is restored to waiting); a claim
 * waiting on a new name waits for the author and is not judged here.
 */

export type ReproofClaim = Pick<
  Claim,
  | 'id'
  | 'proof'
  | 'state'
  | 'pending'
  | 'anchor'
  | 'quote'
  | 'para'
  | 'recordId'
  | 'slot'
  | 'value'
  | 'objectId'
  | 'voice'
  | 'mode'
>

export interface ReproofScene {
  /** The scene's paragraph texts (`passageParagraphs` numbering). */
  paragraphs: readonly string[]
  /** `sceneSentences(paragraphs)`. */
  sentences: readonly SceneSentence[]
  /** The names the scan finds in one sentence (paragraph, sentence index), offsets into it. */
  names: (p: number, sentence: number) => readonly LiteralName[]
}

export type AnchorVerdict =
  | { id: string; verdict: 'holds' }
  /** The anchor holds and the quote now sits in another paragraph (paragraphs came or went above it). */
  | { id: string; verdict: 'moved'; para: number }
  | { id: string; verdict: 'reproved'; para: number; anchor: string[] }
  | { id: string; verdict: 'stale' }
  /** A stale claim whose anchor holds in place again, with its quote's paragraph now. */
  | { id: string; verdict: 'restored'; para: number }

/** Where the quote sits once in the whole scene, trying its own paragraph first. */
export function locateInScene(
  paragraphs: readonly string[],
  para: number,
  quote: string
): QuoteLocation | null {
  const first = locateQuote(paragraphs, para, quote)
  if (first.ok) return first
  if (first.reason !== 'otherParagraph') return null
  for (let p = 0; p < paragraphs.length; p += 1) {
    if (p === para) continue
    const found = locateQuote(paragraphs, p, quote)
    if (found.ok) return found
  }
  return null
}

/** The free re-proof of one literal claim, or null when it does not hold. */
function reprove(
  claim: ReproofClaim,
  scene: ReproofScene
): { para: number; anchor: string[] } | null {
  if (claim.proof !== 'literal' || claim.recordId === null) return null
  const location = locateInScene(scene.paragraphs, claim.para, claim.quote)
  if (location?.sentences.length !== 1) return null
  const index = location.sentences[0] ?? 0
  const span = splitSentences(scene.paragraphs[location.p] ?? '')[index]
  if (span === undefined) return null
  const proof = literalProof(
    {
      recordId: claim.recordId,
      slot: claim.slot,
      value: claim.value,
      objectId: claim.objectId,
      voice: claim.voice,
      mode: claim.mode,
      quote: claim.quote
    },
    { paragraphs: scene.paragraphs, p: location.p, span },
    scene.names(location.p, index)
  )
  if (!proof.ok) return null
  const anchor = [...anchorFor(scene.sentences, location)]
  if (anchor.length === 0) return null
  const before = new Set(claim.anchor)
  const added = scene.sentences.filter(
    (each) => anchor.includes(each.hash) && !before.has(each.hash)
  )
  if (added.some((each) => hasReproofMarker(each.text))) return null
  return { para: location.p, anchor }
}

/** A claim whose subject waits on the name scan or a reading (not on the author's answer). */
const waitsOnSubject = (claim: ReproofClaim): boolean =>
  claim.state === 'waiting' && claim.pending?.kind === 'subject'

/**
 * Each claim's verdict after a save: a live claim `holds`, `moved` (with its quote's paragraph
 * now), `reproved` (with its new paragraph and anchor) or goes `stale`; a claim waiting on its
 * subject `holds`, `moved` or goes `stale`; a stale claim is `restored` when its anchor holds in
 * place again (else it is left out). Claims waiting on a new name are left out.
 */
export function checkAnchors(
  claims: readonly ReproofClaim[],
  scene: ReproofScene
): AnchorVerdict[] {
  const hashes = scene.sentences.map((sentence) => sentence.hash)
  const inPlace = (claim: ReproofClaim): boolean => anchorInPlace(claim.anchor, hashes)
  /** The quote's paragraph now, when it sits once in the scene. */
  const paraOf = (claim: ReproofClaim): number =>
    locateInScene(scene.paragraphs, claim.para, claim.quote)?.p ?? claim.para
  const verdicts: AnchorVerdict[] = []
  for (const claim of claims) {
    if (claim.state === 'stale') {
      if (inPlace(claim)) verdicts.push({ id: claim.id, verdict: 'restored', para: paraOf(claim) })
      continue
    }
    if (claim.state !== 'live' && !waitsOnSubject(claim)) continue
    if (inPlace(claim)) {
      const para = paraOf(claim)
      verdicts.push(
        para === claim.para
          ? { id: claim.id, verdict: 'holds' }
          : { id: claim.id, verdict: 'moved', para }
      )
      continue
    }
    const fresh = claim.state === 'live' ? reprove(claim, scene) : null
    verdicts.push(
      fresh === null
        ? { id: claim.id, verdict: 'stale' }
        : { id: claim.id, verdict: 'reproved', para: fresh.para, anchor: fresh.anchor }
    )
  }
  return verdicts
}

/** Whether a card's quotes rest on a sentence that changed (the card is then due, P2a-D17). */
export function cardStale(anchor: MemoryAnchor, present: ReadonlySet<string>): boolean {
  return !anchorHolds(anchor, present)
}

/**
 * A card's fields and on-page entries with each `p` moved to where its quote sits now (once in
 * the scene); null when none moved. A quote no longer in the scene keeps its `p`: the card is
 * due then anyway (`cardStale`).
 */
export function cardParas(
  card: { fields: CardFields; present: readonly CardPresent[] },
  paragraphs: readonly string[]
): { fields: CardFields; present: CardPresent[] } | null {
  let moved = false
  const follow = <T extends { quote: string; p: number }>(entry: T): T => {
    const p = locateInScene(paragraphs, entry.p, entry.quote)?.p
    if (p === undefined || p === entry.p) return entry
    moved = true
    return { ...entry, p }
  }
  const field = <T extends { quote: string; p: number }>(entry: T | null): T | null =>
    entry === null ? null : follow(entry)
  const fields: CardFields = {
    where: field(card.fields.where),
    when: field(card.fields.when),
    pov: field(card.fields.pov),
    year: field(card.fields.year),
    flashback: field(card.fields.flashback),
    elapsed: field(card.fields.elapsed)
  }
  const present = card.present.map(follow)
  return moved ? { fields, present } : null
}
