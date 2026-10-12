import { passageParagraphs } from '@shared/mentions'
import { anchorFor, sceneSentences } from '@shared/memory/anchor'
import type {
  ClaimMode,
  ClaimPending,
  ClaimProof,
  ClaimState,
  ClaimVoice
} from '@shared/memory/claims'
import { locateQuote } from '@shared/memory/quote'
import type { Slot } from '@shared/memory/slots'
import { EMPTY_DOC } from '@shared/tiptap'
import { activeDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../../voice/profile'
import { insertClaims, type NewClaim } from './claimStore'

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
    state: seed.state ?? 'live'
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
