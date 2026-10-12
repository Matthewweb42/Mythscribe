import { anchorFor, anchorHolds, type MemoryAnchor, type SceneSentence } from './anchor'
import type { Claim } from './claims'
import { literalProof, type LiteralName } from './literal'
import { hasReproofMarker } from './markers'
import { locateQuote, type QuoteLocation } from './quote'
import { splitSentences } from './sentences'

/**
 * Invalidation (F-16.17; design §2.3 "Invalidation"): on every save, each live claim's anchor
 * (its quote's sentences ±1, and the naming sentence for a pronoun subject) is checked against
 * the scene's sentences. A claim whose anchor holds stays live. Any other goes stale, except a
 * literal claim that re-proves for free: its quote is still word for word in the scene (once),
 * its code proof still passes there, and the sentences that are new in its anchor bring no
 * re-proof marker (dream, remembered, said, if, not …). It then stays live with its new
 * paragraph and anchor. Verified claims never re-prove for free: only a reading revives them.
 */

export type ReproofClaim = Pick<
  Claim,
  | 'id'
  | 'proof'
  | 'state'
  | 'anchor'
  | 'quote'
  | 'para'
  | 'recordId'
  | 'slot'
  | 'value'
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
  | { id: string; verdict: 'reproved'; para: number; anchor: string[] }
  | { id: string; verdict: 'stale' }

/** Where the quote sits once in the whole scene, trying its own paragraph first. */
function locateInScene(
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
  const sentence = splitSentences(scene.paragraphs[location.p] ?? '')[index]
  if (sentence === undefined) return null
  const proof = literalProof(
    {
      recordId: claim.recordId,
      slot: claim.slot,
      value: claim.value,
      voice: claim.voice,
      mode: claim.mode,
      quote: claim.quote
    },
    sentence.text,
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

/**
 * Each live claim's verdict after a save: `holds`, `reproved` (with its new paragraph and
 * anchor), or `stale`. Stale and waiting claims are not judged here.
 */
export function checkAnchors(
  claims: readonly ReproofClaim[],
  scene: ReproofScene
): AnchorVerdict[] {
  const present = new Set(scene.sentences.map((sentence) => sentence.hash))
  return claims
    .filter((claim) => claim.state === 'live')
    .map((claim): AnchorVerdict => {
      if (claim.anchor.length > 0 && anchorHolds(claim.anchor, present)) {
        return { id: claim.id, verdict: 'holds' }
      }
      const fresh = reprove(claim, scene)
      return fresh === null
        ? { id: claim.id, verdict: 'stale' }
        : { id: claim.id, verdict: 'reproved', para: fresh.para, anchor: fresh.anchor }
    })
}

/** Whether a card's quotes rest on a sentence that changed (the card is then due, P2a-D17). */
export function cardStale(anchor: MemoryAnchor, present: ReadonlySet<string>): boolean {
  return !anchorHolds(anchor, present)
}
