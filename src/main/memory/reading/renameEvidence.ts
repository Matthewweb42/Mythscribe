import { isDeepStrictEqual } from 'node:util'
import type { Paragraph } from '@shared/mentions'
import { anchorFor, sceneSentences } from '@shared/memory/anchor'
import {
  CardFields,
  CardPresent,
  emptyCardFields,
  valueKey,
  type CardField
} from '@shared/memory/claims'
import { locateQuote } from '@shared/memory/quote'
import type { RenameEdit } from '@shared/memory/rename'
import { locateInScene } from '@shared/memory/reproof'
import {
  rewriteAnchor,
  rewriteQuote,
  rewriteWords,
  sentencePairs,
  textEdits,
  type TextEdit
} from '@shared/memory/renameEvidence'
import { z } from 'zod'
import type { CardRow, ClaimRow, SceneReadRow, TopicQuoteRow } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'
import { getCardRow, writeCardRow } from './cardStore'
import { claimRows, sceneClaimRows, writeClaimRow } from './claimStore'
import { getSceneReadRow, writeSceneReadRow } from './sceneReadStore'
import { sceneTopicQuoteRows, topicQuoteRows, writeTopicQuoteRow } from './topicStore'

/**
 * Rename in book over the evidence (F-16.13, F-16.17; plan P2a §1.4), main side: inside the
 * rename's transaction, a rewritten scene's claims (quote, value, anchor), its card (quotes,
 * line, gist, anchor), its read set (sentence texts) and, P2b, its secrets' and threads' reveals
 * (quote, label, anchor; the gate texts fold names, so `stating` never moves) in that draft follow
 * the rewrite, and the rows as they were go into the rename's undo. The undo puts a row back only
 * while it still reads as the rename left it (a reading since then is kept).
 */

export interface EvidenceUndo {
  claims: { before: ClaimRow; after: ClaimRow }[]
  card: { before: CardRow; after: CardRow } | null
  read: { before: SceneReadRow; after: SceneReadRow } | null
  topicQuotes: { before: TopicQuoteRow; after: TopicQuoteRow }[]
}

const Hashes = z.array(z.string())

function parse<T>(raw: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

/** The scene before and after, and the edits by paragraph. */
interface Rewrite {
  before: string[]
  after: string[]
  edits: Map<number, TextEdit[]>
  pairs: ReturnType<typeof sentencePairs>
}

/**
 * The paragraph a stored quote sits in before the rewrite: where it is found once in the scene
 * (its stored paragraph first), else the stored one. A paragraph added or removed above it since
 * the anchors job last ran must not send the rewrite to the wrong paragraph.
 */
function paraOf(rewrite: Rewrite, para: number, quote: string): number {
  return locateInScene(rewrite.before, para, quote)?.p ?? para
}

/** A quote and its anchor after the rewrite (the anchor recomputed when sentences cannot pair). */
function moved(
  rewrite: Rewrite,
  para: number,
  quote: string,
  anchor: readonly string[]
): { quote: string; anchor: string[] } {
  const edits = rewrite.edits.get(para) ?? []
  const next = rewriteQuote(rewrite.before[para] ?? '', quote, edits) ?? quote
  if (rewrite.pairs !== null) return { quote: next, anchor: rewriteAnchor(anchor, rewrite.pairs) }
  const location = locateQuote(rewrite.after, para, next)
  const fresh = location.ok ? [...anchorFor(sceneSentences(rewrite.after), location)] : []
  return { quote: next, anchor: fresh.length > 0 ? fresh : [...anchor] }
}

function rewriteClaim(row: ClaimRow, rewrite: Rewrite): ClaimRow {
  const para = paraOf(rewrite, row.para, row.quote)
  const edits = rewrite.edits.get(para) ?? []
  const next = moved(rewrite, para, row.quote, parse(row.anchor, Hashes, []))
  const value = rewriteWords(row.value, edits)
  return {
    ...row,
    para,
    quote: next.quote,
    value,
    valueKey: valueKey(value),
    anchor: JSON.stringify(next.anchor)
  }
}

function rewriteTopicQuote(row: TopicQuoteRow, rewrite: Rewrite): TopicQuoteRow {
  const para = paraOf(rewrite, row.para, row.quote)
  const edits = rewrite.edits.get(para) ?? []
  const next = moved(rewrite, para, row.quote, parse(row.anchor, Hashes, []))
  return {
    ...row,
    para,
    quote: next.quote,
    label: rewriteWords(row.label, edits),
    anchor: JSON.stringify(next.anchor)
  }
}

function rewriteCard(row: CardRow, rewrite: Rewrite): CardRow {
  const all = [...rewrite.edits.values()].flat()
  const fields = parse(row.fields, CardFields, emptyCardFields())
  const moveField = (value: CardField): CardField => {
    const p = paraOf(rewrite, value.p, value.quote)
    const edits = rewrite.edits.get(p) ?? []
    return {
      ...value,
      p,
      value: rewriteWords(value.value, edits),
      quote: rewriteQuote(rewrite.before[p] ?? '', value.quote, edits) ?? value.quote
    }
  }
  const field = (value: CardField | null): CardField | null =>
    value === null ? null : moveField(value)
  const present = parse(row.present, z.array(CardPresent), []).map((each) => {
    const p = paraOf(rewrite, each.p, each.quote)
    return {
      ...each,
      p,
      quote:
        rewriteQuote(rewrite.before[p] ?? '', each.quote, rewrite.edits.get(p) ?? []) ?? each.quote
    }
  })
  return {
    ...row,
    line: rewriteWords(row.line, all),
    gist: rewriteWords(row.gist, all),
    fields: JSON.stringify({
      where: field(fields.where),
      when: field(fields.when),
      // The POV's value is a record id: only its quote and paragraph follow the rename.
      pov: fields.pov === null ? null : { ...moveField(fields.pov), value: fields.pov.value },
      year: field(fields.year),
      flashback: field(fields.flashback),
      elapsed: field(fields.elapsed)
    }),
    present: JSON.stringify(present),
    anchor: JSON.stringify(rewriteAnchor(parse(row.anchor, Hashes, []), rewrite.pairs))
  }
}

function rewriteRead(row: SceneReadRow, rewrite: Rewrite): SceneReadRow {
  const all = [...rewrite.edits.values()].flat()
  const entries = parse(row.sentences, z.array(z.tuple([z.string(), z.string()])), [])
  return {
    ...row,
    // The gate hash does not move (names are out of it); the text follows the rename.
    sentences: JSON.stringify(
      entries.map(([hash, text]) => [
        hash,
        rewrite.pairs?.texts.get(text) ?? rewriteWords(text, all)
      ])
    )
  }
}

/**
 * Rewrites one scene's evidence in one draft for a rename, inside the caller's transaction.
 * `before` is the stored scene's paragraphs, `after` the rewritten one's, `edits` the rename's
 * applied edits. Answers what the undo needs, or null when there was nothing to rewrite.
 */
export function rewriteEvidence(
  db: TreeDb,
  input: {
    nodeId: string
    draftId: string
    before: readonly Paragraph[]
    after: readonly Paragraph[]
    edits: readonly RenameEdit[]
  },
  now: Date
): EvidenceUndo | null {
  const claims = sceneClaimRows(db, input.nodeId, input.draftId)
  const card = getCardRow(db, input.nodeId, input.draftId)
  const read = getSceneReadRow(db, input.nodeId, input.draftId)
  const quotes = sceneTopicQuoteRows(db, input.nodeId).filter(
    (row) => row.draftId === input.draftId
  )
  if (claims.length === 0 && card === null && read === null && quotes.length === 0) return null
  const before = input.before.map((paragraph) => paragraph.text)
  const after = input.after.map((paragraph) => paragraph.text)
  const rewrite: Rewrite = {
    before,
    after,
    edits: textEdits(input.before, input.edits),
    pairs: sentencePairs(before, after)
  }
  const undo: EvidenceUndo = { claims: [], card: null, read: null, topicQuotes: [] }
  for (const row of claims) {
    const next = rewriteClaim(row, rewrite)
    if (isDeepStrictEqual(next, row)) continue
    writeClaimRow(db, next)
    undo.claims.push({ before: row, after: next })
  }
  for (const row of quotes) {
    const next = rewriteTopicQuote(row, rewrite)
    if (isDeepStrictEqual(next, row)) continue
    writeTopicQuoteRow(db, next)
    undo.topicQuotes.push({ before: row, after: next })
  }
  if (card !== null) {
    const next = rewriteCard(card, rewrite)
    if (!isDeepStrictEqual(next, card)) {
      writeCardRow(db, next, now)
      undo.card = { before: card, after: next }
    }
  }
  if (read !== null) {
    const next = rewriteRead(read, rewrite)
    if (!isDeepStrictEqual(next, read)) {
      writeSceneReadRow(db, next)
      undo.read = { before: read, after: next }
    }
  }
  return undo
}

/** Puts back each row the rename rewrote, while it still reads as the rename left it. */
export function restoreEvidence(db: TreeDb, undo: EvidenceUndo, now: Date): void {
  const current = new Map(
    claimRows(
      db,
      undo.claims.map((each) => each.after.id)
    ).map((row) => [row.id, row])
  )
  for (const { before, after } of undo.claims) {
    if (isDeepStrictEqual(current.get(after.id), after)) writeClaimRow(db, before)
  }
  const reveals = new Map(
    topicQuoteRows(
      db,
      undo.topicQuotes.map((each) => each.after.id)
    ).map((row) => [row.id, row])
  )
  for (const { before, after } of undo.topicQuotes) {
    if (isDeepStrictEqual(reveals.get(after.id), after)) writeTopicQuoteRow(db, before)
  }
  if (undo.card !== null) {
    const stored = getCardRow(db, undo.card.after.nodeId, undo.card.after.draftId)
    if (isDeepStrictEqual(stored, undo.card.after)) writeCardRow(db, undo.card.before, now)
  }
  if (undo.read !== null) {
    const row = getSceneReadRow(db, undo.read.after.nodeId, undo.read.after.draftId)
    if (isDeepStrictEqual(row, undo.read.after)) writeSceneReadRow(db, undo.read.before)
  }
}
