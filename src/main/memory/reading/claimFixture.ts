import { passageParagraphs } from '@shared/mentions'
import { anchorFor, sceneSentences } from '@shared/memory/anchor'
import type {
  ClaimMode,
  ClaimPending,
  ClaimProof,
  ClaimState,
  ClaimVoice
} from '@shared/memory/claims'
import { gateText } from '@shared/memory/gate'
import { locateQuote } from '@shared/memory/quote'
import { splitSentences } from '@shared/memory/sentences'
import type { Slot } from '@shared/memory/slots'
import { EMPTY_DOC } from '@shared/tiptap'
import { activeDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../../voice/profile'
import { nameScanShared } from '../nameIndexer'
import { insertClaims, type NewClaim } from './claimStore'
import type { NewTopicQuote } from './topicStore'

/**
 * Claims the reading tests store as slice 2's pipeline would (F-16.17): the quote located in the
 * saved scene, the anchor from its sentences ±1, in the active draft. Test support only.
 */

export interface ClaimSeed {
  recordId: string | null
  slot: Slot
  value: string
  quote: string
  para: number
  proof?: ClaimProof
  state?: ClaimState
  voice?: ClaimVoice
  mode?: ClaimMode
  speakerId?: string | null
  objectId?: string | null
  subjectText?: string | null
  pending?: ClaimPending | null
  readingId?: string | null
  /** P2b: a knows line's how and source, a thread step's step, the merged reveal it came with. */
  how?: string | null
  fromId?: string | null
  topicQuoteId?: string | null
}

/** The scene's paragraph texts as saved. */
export function sceneTexts(db: TreeDb, nodeId: string): string[] {
  const row = manuscriptDocuments(db).find((document) => document.id === nodeId)
  if (row === undefined) throw new Error(`Not a manuscript scene: ${nodeId}`)
  return passageParagraphs(documentJson(row) ?? EMPTY_DOC).map((paragraph) => paragraph.text)
}

/** A claim to store, anchored in the saved scene. */
export function anchoredClaim(db: TreeDb, nodeId: string, seed: ClaimSeed): NewClaim {
  const texts = sceneTexts(db, nodeId)
  const location = locateQuote(texts, seed.para, seed.quote)
  if (!location.ok) throw new Error(`Quote not in ¶${seed.para}: ${location.reason}`)
  return {
    nodeId,
    draftId: activeDraftId(db),
    readingId: seed.readingId ?? null,
    recordId: seed.recordId,
    pending: seed.pending ?? null,
    subjectText: seed.subjectText ?? null,
    slot: seed.slot,
    value: seed.value,
    objectId: seed.objectId ?? null,
    voice: seed.voice ?? 'narration',
    speakerId: seed.speakerId ?? null,
    mode: seed.mode ?? 'now',
    quote: seed.quote,
    para: seed.para,
    anchor: [...anchorFor(sceneSentences(texts), location)],
    proof: seed.proof ?? 'literal',
    change: false,
    state: seed.state ?? 'live',
    how: seed.how ?? null,
    fromId: seed.fromId ?? null,
    topicQuoteId: seed.topicQuoteId ?? null
  }
}

/**
 * A secret's or thread's reveal as slice 2's pipeline would store it (P2b): located in the saved
 * scene, anchored on its sentences ±1, with the gate texts of its own sentences.
 */
export function revealIn(
  db: TreeDb,
  nodeId: string,
  seed: { para: number; quote: string; label: string; readingId?: string | null }
): NewTopicQuote {
  const texts = sceneTexts(db, nodeId)
  const location = locateQuote(texts, seed.para, seed.quote)
  if (!location.ok) throw new Error(`Quote not in ¶${seed.para}: ${location.reason}`)
  const spans = splitSentences(texts[location.p] ?? '')
  const names = nameScanShared(db).index
  return {
    nodeId,
    draftId: activeDraftId(db),
    para: location.p,
    quote: seed.quote,
    label: seed.label,
    anchor: [...anchorFor(sceneSentences(texts), location)],
    stating: location.sentences.map((i) => gateText(spans[i]?.text ?? '', names)),
    readingId: seed.readingId ?? null
  }
}

/** Stores claims anchored in the saved scene; answers their ids. */
export function seedClaims(
  db: TreeDb,
  nodeId: string,
  seeds: readonly ClaimSeed[],
  now: Date
): string[] {
  return insertClaims(
    db,
    seeds.map((seed) => anchoredClaim(db, nodeId, seed)),
    now
  )
}

/** A card's anchor as a reading of the saved scene would leave it: every sentence's hash. */
export function cardAnchorOf(db: TreeDb, nodeId: string): string[] {
  return [...new Set(sceneSentences(sceneTexts(db, nodeId)).map((sentence) => sentence.hash))]
}
