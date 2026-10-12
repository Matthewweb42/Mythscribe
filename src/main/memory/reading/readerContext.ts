import { passageParagraphs, type Paragraph } from '@shared/mentions'
import { sceneSentences, type SceneSentence } from '@shared/memory/anchor'
import { setsState, type Card, type Claim } from '@shared/memory/claims'
import type { KnownWords } from '@shared/memory/gate'
import type { LadderSentence } from '@shared/memory/ladder'
import { sentenceNames } from '@shared/memory/literal'
import { scanNames, type NameMention } from '@shared/memory/nameScan'
import type { RecordKind } from '@shared/memory/records'
import type { SceneDetails } from '@shared/memory/sceneDetails'
import { splitSentences, type SentenceSpan } from '@shared/memory/sentences'
import { slotGroup } from '@shared/memory/slots'
import type { MemorySource } from '@shared/memory/sources'
import { searchableText } from '@shared/search'
import { EMPTY_DOC } from '@shared/tiptap'
import type { NodeRow } from '../../db/schema'
import { getProjectDictionary } from '../../project/settingsStore'
import type { TreeDb } from '../../tree/treeStore'
import { documentJson, documentText, manuscriptDocuments } from '../../voice/profile'
import { nameScanShared, type NameScanShared } from '../nameIndexer'
import { storedSceneDetails } from '../sceneDetailStore'
import { claimSources } from './claimStore'
import type { ReaderRoster } from './rosterCache'

/**
 * What a reading reads (F-16.17; plan P2a §2.4): one scene of the active draft as the reader and
 * the ladder see it (paragraphs in `passageParagraphs` numbering, sentences, the name scan's
 * mentions, the typed details), and the lines of `reader.v1`'s user turn (the scene's position,
 * typed details and current card, the facts known near the window, the facts anchored in it).
 * Local: nothing here is sent; the pipeline sends what these lines say.
 */

export interface ReadingScene {
  nodeId: string
  title: string
  paragraphs: Paragraph[]
  texts: string[]
  sentences: SceneSentence[]
  hashes: string[]
  /** Each paragraph's sentence spans (`splitSentences`). */
  spans: SentenceSpan[][]
  mentions: NameMention[]
  shared: NameScanShared
  details: SceneDetails
  kindOf: (recordId: string) => RecordKind | undefined
  /** The position in `sentences` of sentence `index` of paragraph `p`; -1 when there is none. */
  position: (p: number, index: number) => number
  /** A sentence (by position) with the names the scan found in it. */
  ladderSentence: (position: number) => LadderSentence
}

/**
 * The active manuscript read once (F-16.16): its rows, the name scan's roster, where each scene
 * may be read from, and the cosmetic skip's known words. A walk over many scenes (the backlog
 * check, the back-fill's sizing, the spot checks) shares one, so it reads the tree, the roster and
 * every scene's words once rather than once per scene; one scene's reading builds its own.
 */
export interface Book {
  rows: readonly NodeRow[]
  row: (nodeId: string) => NodeRow | undefined
  shared: NameScanShared
  sourceOf: (nodeId: string) => MemorySource
  /**
   * The words the cosmetic skip treats as known for one scene (P2a-D3): every word of the active
   * manuscript's other scenes, the roster's names, and the project dictionary, lower case.
   */
  knownWords: (nodeId: string) => KnownWords
}

/** The words of a text, lower case, as the cosmetic skip compares them. */
function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? [])
}

export function readBook(db: TreeDb): Book {
  const rows = manuscriptDocuments(db)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const shared = nameScanShared(db)
  // Built on the first question only: most walks never need it (nothing unread, P2a-D3).
  let words: { own: Map<string, Set<string>>; count: Map<string, number>; extra: Set<string> } | null =
    null
  const index = (): { own: Map<string, Set<string>>; count: Map<string, number>; extra: Set<string> } => {
    if (words !== null) return words
    const own = new Map<string, Set<string>>()
    const count = new Map<string, number>()
    for (const row of rows) {
      const set = wordsOf(documentText(row))
      own.set(row.id, set)
      for (const word of set) count.set(word, (count.get(word) ?? 0) + 1)
    }
    const extra = new Set<string>()
    for (const norm of shared.index.byNorm.keys()) for (const word of wordsOf(norm)) extra.add(word)
    for (const entry of getProjectDictionary(db).words) {
      for (const word of wordsOf(entry)) extra.add(word)
    }
    words = { own, count, extra }
    return words
  }
  return {
    rows,
    row: (nodeId) => byId.get(nodeId),
    shared,
    sourceOf: claimSources(db, rows),
    knownWords: (nodeId) => {
      const { own, count, extra } = index()
      const mine = own.get(nodeId)
      return {
        has: (word) =>
          extra.has(word) || (count.get(word) ?? 0) - (mine?.has(word) === true ? 1 : 0) > 0
      }
    }
  }
}

/** Loads a manuscript scene for reading; null when the node is no manuscript document. */
export function loadReadingScene(
  db: TreeDb,
  nodeId: string,
  book: Book = readBook(db)
): ReadingScene | null {
  const row = book.row(nodeId)
  if (row === undefined) return null
  const paragraphs = passageParagraphs(documentJson(row) ?? EMPTY_DOC)
  const texts = paragraphs.map((paragraph) => paragraph.text)
  const sentences = sceneSentences(texts)
  const spans = texts.map((text) => splitSentences(text))
  const shared = book.shared
  const details = storedSceneDetails(db, nodeId)
  const mentions = scanNames(paragraphs, shared.index, {
    povRecordId: details.povRecordId,
    notMention: shared.notMention
  })
  const positions = new Map(sentences.map((sentence, i) => [`${sentence.p}:${sentence.index}`, i]))
  const kindOf = (recordId: string): RecordKind | undefined => shared.index.kinds.get(recordId)
  return {
    nodeId,
    title: searchableText(row.title).trim() || 'Untitled scene',
    paragraphs,
    texts,
    sentences,
    hashes: sentences.map((sentence) => sentence.hash),
    spans,
    mentions,
    shared,
    details,
    kindOf,
    position: (p, index) => positions.get(`${p}:${index}`) ?? -1,
    ladderSentence: (position) => {
      const sentence = sentences[position]
      const paragraph = sentence === undefined ? undefined : paragraphs[sentence.p]
      const span = sentence === undefined ? undefined : spans[sentence.p]?.[sentence.index]
      if (sentence === undefined || paragraph === undefined || span === undefined) {
        return { position, text: '', names: [] }
      }
      return {
        position,
        text: span.text,
        names: sentenceNames(paragraph, span, mentions, kindOf)
      }
    }
  }
}

/** The paragraphs that name a record for certain (where a window may start, `planWindows`). */
export function namingParas(scene: ReadingScene): Set<number> {
  return new Set(scene.mentions.filter((mention) => !mention.ambiguous).map((m) => m.para))
}

/** "Scene 14.2 “The Quay”, page 1 of 2 (the whole scene)", or "…, the changed paragraphs". */
export function positionLine(
  ref: string | null,
  title: string,
  piece: { page: number; pages: number; full: boolean }
): string {
  const where = `Scene ${ref ?? '?'} “${title}”`
  if (!piece.full) {
    return piece.pages > 1
      ? `${where}, the changed paragraphs (part ${piece.page} of ${piece.pages})`
      : `${where}, the changed paragraphs`
  }
  return piece.pages > 1
    ? `${where}, page ${piece.page} of ${piece.pages} (the whole scene)`
    : `${where}, the whole scene`
}

/** The typed details as one line ("POV r12 · place r30 (the harbour) · time dawn · year 1811"). */
export function typedLine(details: SceneDetails, roster: ReaderRoster): string | null {
  const parts: string[] = []
  if (details.povRecordId !== null) parts.push(`POV ${roster.shortOf(details.povRecordId)}`)
  const place = details.place
  if (place.recordId !== null || place.text.trim() !== '') {
    const id = place.recordId === null ? '' : roster.shortOf(place.recordId)
    const text = place.text.trim()
    parts.push(
      `place ${[id, text === '' ? '' : id === '' ? text : `(${text})`].filter(Boolean).join(' ')}`
    )
  }
  if (details.time.text.trim() !== '') parts.push(`time ${details.time.text.trim()}`)
  if (details.storyYear !== null) parts.push(`year ${details.storyYear}`)
  return parts.length === 0 ? null : parts.join(' · ')
}

/** The current card as one line: its line, then where, when and the POV it read. */
export function cardLine(card: Card | null, roster: ReaderRoster): string | null {
  if (card === null) return null
  const parts = [card.line]
  if (card.fields.where !== null) parts.push(`where ${card.fields.where.value}`)
  if (card.fields.when !== null) parts.push(`when ${card.fields.when.value}`)
  if (card.fields.pov !== null) parts.push(`POV ${roster.shortOf(card.fields.pov.value)}`)
  return parts.join(' · ')
}

/** Most values a near line carries for one record. */
const NEAR_VALUES = 8

/**
 * The facts known about the records named in the window (plan P2a §2.2): each record's live
 * fixed and lasting values that set state (narration, now), newest first, one line per record in
 * the order the window names them ("r12 eyes “grey” · hair “red”").
 */
export function nearLines(
  recordIds: readonly string[],
  claims: readonly Claim[],
  roster: ReaderRoster
): string[] {
  const lines: string[] = []
  for (const recordId of recordIds) {
    const seen = new Set<string>()
    const values: string[] = []
    const own = claims
      .filter(
        (claim) =>
          claim.recordId === recordId &&
          claim.state === 'live' &&
          setsState(claim) &&
          (slotGroup(claim.slot) === 'fixed' || slotGroup(claim.slot) === 'lasting')
      )
      .sort((a, b) => b.created.localeCompare(a.created))
    for (const claim of own) {
      const key = `${claim.slot}|${claim.valueKey}`
      if (seen.has(key) || values.length >= NEAR_VALUES) continue
      seen.add(key)
      values.push(`${claim.slot} “${claim.value}”`)
    }
    if (values.length > 0) lines.push(`${roster.shortOf(recordId)} ${values.join(' · ')}`)
  }
  return lines
}

/** A fact anchored in the window, with its short id ("c7 r12 location “at the quay” ¶3"). */
export function anchoredLine(short: string, claim: Claim, roster: ReaderRoster): string {
  const subject = claim.recordId === null ? '?' : roster.shortOf(claim.recordId)
  const stale = claim.state === 'stale' ? ', re-checking' : ''
  return `${short} ${subject} ${claim.slot} “${claim.value}” ¶${claim.para}${stale}`
}
