import { estimateTokens } from '@shared/ai'
import type { ReadingOrder } from '@shared/memory/asOf'
import { HOW_LABEL } from '@shared/memory/knows'
import { aiFiledOf, markedParagraphs, pageTextBlocks } from '@shared/memory/pageMarks'
import type { PassageSource } from '@shared/memory/passages'
import type { StoryRecord } from '@shared/memory/records'
import { slotLabel } from '@shared/memory/slots'
import { meaningOf } from '@shared/memory/sources'
import type { AgeView, YearView } from '@shared/memory/views'
import type { Claim } from '@shared/memory/claims'
import {
  citableLabel,
  evidenceTag,
  labelOf,
  type CitationTarget,
  type EvidenceKey,
  type EvidenceLabel
} from '@shared/scribe'
import { searchableText } from '@shared/search'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import type { NodeRow } from '../db/schema'
import { currentDraftId } from '../draft/draftStore'
import { manuscriptRows } from '../ai/context/storyTime'
import { listAuthorTodos } from '../memory/authorTodoStore'
import { sceneStatuses, type SceneStatuses } from '../memory/passageIndexer'
import { getCard } from '../memory/reading/cardStore'
import { getClaim } from '../memory/reading/claimStore'
import { storedKnows } from '../memory/reading/knowsViews'
import { readingOrder, rowTexts } from '../memory/reading/readingFrame'
import { storedAge, storedYears } from '../memory/reading/timeViews'
import { getRecord } from '../memory/recordStore'
import { researchDocOf } from '../research/researchStore'
import { isUnderResearch } from '../research/researchTree'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'

/**
 * Ms Scribe's evidence (F-16.25; plan P3 §1.3): what each `EvidenceKey` is in the book as it is
 * now, labelled by meaning (design §2.2), and rendered as the prompts show it. Main keeps no state
 * between `ai:navigate` and `ai:agent` (P3-D1): the renderer carries the keys, and every key is
 * resolved again here, so a scene edited since reads as it reads now and a key whose owner is gone
 * is dropped and counted. Every item is citable but a card, a map (P3-D9). Absence is never an
 * item: `knows` lists the lines that show knowing or half-knowing, never one that does not
 * (P2b rule 9), and nothing here reads `checkedUpTo`. Read-only and local.
 */

/** One resolved item: its id in the prompt, its key, label, place and current text. */
export interface EvidenceItem {
  /** `E1`…, or `W1`… for a widened chapter (slice 2). */
  id: string
  key: EvidenceKey
  label: EvidenceLabel
  /** Where it is: "9.3 ¶4", "Mara's Pinned ¶2", "Research “Harbour” ¶1". */
  ref: string
  title: string
  text: string
  citable: boolean
  open: CitationTarget | null
  /** For a filed Pinned line, the document it was filed from. */
  doc: string | null
}

/** What every key of one call is read against, built once. */
export interface EvidenceFrame {
  db: TreeDb
  nodes: NodeRow[]
  reading: ReadingOrder
  statuses: SceneStatuses
  /** Now: the open scene, else the latest written; null with nothing written. */
  nowId: string | null
  draftId: string | null
  /** The manuscript documents by id (every status). */
  documents: Map<string, NodeRow>
  records: Map<string, StoryRecord | null>
}

export function evidenceFrame(
  db: TreeDb,
  nowId: string | null,
  nodes: NodeRow[] = listNodes(db),
  reading: ReadingOrder = readingOrder(db, nodes)
): EvidenceFrame {
  return {
    db,
    nodes,
    reading,
    statuses: sceneStatuses(db, nodes),
    nowId,
    draftId: currentDraftId(db),
    documents: new Map(manuscriptDocuments(db, nodes).map((row) => [row.id, row])),
    records: new Map()
  }
}

/** A record with its pages, read once per frame. */
export function frameRecord(frame: EvidenceFrame, id: string): StoryRecord | null {
  if (!frame.records.has(id)) frame.records.set(id, getRecord(frame.db, id))
  return frame.records.get(id) ?? null
}

const titleOf = (row: Pick<NodeRow, 'title'>): string =>
  searchableText(row.title).trim() || 'Untitled'

/** A manuscript scene's reference ("9.3", or an Idea scene's title). */
export const sceneRefOf = (frame: EvidenceFrame, nodeId: string): string =>
  frame.reading.refs.get(nodeId) ?? ''

/**
 * A manuscript scene's label from where it is now (`labelOf`): an Idea scene, a scene left out of
 * the book, else the manuscript before or at now (`happened`) or after it (`later`).
 */
export function sceneLabel(frame: EvidenceFrame, nodeId: string): EvidenceLabel {
  if (frame.statuses.idea.has(nodeId)) return labelOf('ideaScene', 'never')
  if (frame.statuses.excluded.has(nodeId)) return labelOf('excludedScene', 'never')
  const order = frame.reading.order.get(nodeId) ?? Infinity
  const now = frame.nowId === null ? -1 : (frame.reading.at.get(frame.nowId) ?? -1)
  return labelOf('scene', meaningOf('scene', { order, openOrder: now }))
}

function parseDoc(raw: string | null): TiptapNodeT | null {
  if (raw === null) return null
  try {
    const parsed = TiptapNode.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A Research document's row and meta, or null when it is no longer one. */
function researchPage(
  frame: EvidenceFrame,
  nodeId: string
): { row: NodeRow; upload: boolean; notCanon: boolean } | null {
  const row = frame.nodes.find((each) => each.id === nodeId)
  if (row?.kind !== 'document' || !isUnderResearch(frame.db, row)) return null
  const meta = researchDocOf(frame.db, nodeId)
  return { row, upload: meta.origin === 'upload', notCanon: meta.notCanon }
}

/** One indexed paragraph as it is now: its label, place, text and where it opens; null when gone. */
export function passageNow(
  frame: EvidenceFrame,
  source: PassageSource,
  ownerId: string,
  para: number
): Omit<EvidenceItem, 'id' | 'key'> | null {
  switch (source) {
    case 'scene':
    case 'ideaScene':
    case 'excludedScene': {
      const row = frame.documents.get(ownerId)
      const text = row === undefined ? undefined : rowTexts(row)[para]
      if (row === undefined || text === undefined) return null
      const label = sceneLabel(frame, ownerId)
      return {
        label,
        ref: `${sceneRefOf(frame, ownerId)} ¶${para}`,
        title: titleOf(row),
        text,
        citable: citableLabel(label),
        open: { kind: 'scene', id: ownerId, para },
        doc: null
      }
    }
    case 'sceneNote': {
      const row = frame.documents.get(ownerId)
      const doc = row === undefined ? null : parseDoc(row.notes)
      const paragraph = doc === null ? undefined : markedParagraphs(doc)[para]
      if (row === undefined || paragraph === undefined) return null
      return {
        label: labelOf('sceneNote', 'plan', { notCanon: paragraph.notCanon }),
        ref: `${sceneRefOf(frame, ownerId)} notes ¶${para}`,
        title: titleOf(row),
        text: paragraph.text,
        citable: true,
        open: { kind: 'scene', id: ownerId, para: null },
        doc: null
      }
    }
    case 'pinned':
    case 'idea': {
      const record = frameRecord(frame, ownerId)
      const page = record === null ? null : source === 'pinned' ? record.pinned : record.ideas
      const block = page === null ? undefined : pageTextBlocks(page)[para]
      if (record === null || block === undefined) return null
      const filed = source === 'pinned' ? aiFiledOf(block.block) : null
      const filedFrom = filed === null ? undefined : frame.nodes.find((row) => row.id === filed.doc)
      const label =
        source === 'idea'
          ? labelOf('idea', 'never')
          : labelOf('pinned', 'canon', { notCanon: block.notCanon, filed: filed !== null })
      const pageName = source === 'pinned' ? 'Pinned' : 'Ideas'
      return {
        label,
        ref: `${record.name}'s ${pageName} ¶${para}`,
        title: record.name,
        text: block.text,
        citable: true,
        open: { kind: 'record', id: ownerId, page: source === 'pinned' ? 'pinned' : 'ideas', para },
        doc: filed === null ? null : filedFrom === undefined ? 'a document' : titleOf(filedFrom)
      }
    }
    case 'note':
    case 'research': {
      const page = researchPage(frame, ownerId)
      const doc = page === null ? null : parseDoc(page.row.content)
      const paragraph = doc === null ? undefined : markedParagraphs(doc)[para]
      if (page === null || paragraph === undefined) return null
      const label = labelOf(source, 'canon', {
        notCanon: page.notCanon || paragraph.notCanon,
        upload: page.upload
      })
      return {
        label,
        ref: `Research “${titleOf(page.row)}” ¶${para}`,
        title: titleOf(page.row),
        text: paragraph.text,
        citable: true,
        open: { kind: 'research', id: ownerId, para },
        doc: null
      }
    }
    case 'card':
      return cardNow(frame, ownerId)
  }
}

/** A scene's card in the active draft: a map, never citable (P3-D9). */
function cardNow(frame: EvidenceFrame, nodeId: string): Omit<EvidenceItem, 'id' | 'key'> | null {
  const row = frame.documents.get(nodeId)
  const card = frame.draftId === null ? null : getCard(frame.db, nodeId, frame.draftId)
  if (row === undefined || card === null) return null
  return {
    label: labelOf('card', 'map'),
    ref: sceneRefOf(frame, nodeId),
    title: titleOf(row),
    text: [card.line, card.gist].filter((line) => line.trim() !== '').join('\n'),
    citable: false,
    open: { kind: 'scene', id: nodeId, para: null },
    doc: null
  }
}

const nameOf = (frame: EvidenceFrame, id: string | null): string =>
  id === null ? '' : (frameRecord(frame, id)?.name ?? '')

/** How a claim's mode reads in its fact line: only `now` is the story's present (design §2.2). */
const MODE_WORDS: Readonly<Record<Exclude<Claim['mode'], 'now'>, string>> = {
  memory: 'remembered',
  hypothetical: 'supposed, not real',
  dream: 'in a dream'
}

/**
 * A claim's fact line: who says it and in what mode when it is not the narration's present ("Orrin
 * says, in a dream: Mara · eyes: green"), since only narration in `now` mode sets state; never a
 * bare value for speech, thought or rumour.
 */
export function claimFact(
  claim: Pick<
    Claim,
    'slot' | 'value' | 'voice' | 'mode' | 'speakerId' | 'recordId' | 'subjectText' | 'objectId'
  >,
  nameOf: (id: string | null) => string
): string {
  const named = nameOf(claim.recordId)
  const subject = named !== '' ? named : (claim.subjectText ?? 'someone')
  const object = claim.objectId === null ? '' : ` (${nameOf(claim.objectId)})`
  const fact = `${subject} · ${slotLabel(claim.slot).toLowerCase()}: ${claim.value}${object}`
  const speaker = nameOf(claim.speakerId) || 'someone'
  const who =
    claim.voice === 'dialogue'
      ? `${speaker} says`
      : claim.voice === 'thought'
        ? `${speaker} thinks`
        : claim.voice === 'rumour'
          ? 'Rumour'
          : ''
  const how = claim.mode === 'now' ? '' : MODE_WORDS[claim.mode]
  const lead = [who, how].filter((part) => part !== '').join(', ')
  return lead === '' ? fact : `${lead.charAt(0).toUpperCase()}${lead.slice(1)}: ${fact}`
}

/** A claim with its paragraph as it reads now, the fact line above it ("Mara · eyes: grey"). */
function claimNow(frame: EvidenceFrame, claimId: string): Omit<EvidenceItem, 'id' | 'key'> | null {
  const claim = getClaim(frame.db, claimId)
  if (claim === null) return null
  if (claim.draftId !== frame.draftId || claim.state === 'waiting') return null
  const row = frame.documents.get(claim.nodeId)
  const paragraph = row === undefined ? undefined : rowTexts(row)[claim.para]
  if (row === undefined || paragraph === undefined) return null
  const fact =
    claimFact(claim, (id) => nameOf(frame, id)) +
    (claim.state === 'stale' ? ' · re-checking: the sentence changed since it was read' : '')
  const label = sceneLabel(frame, claim.nodeId)
  return {
    label,
    ref: `${sceneRefOf(frame, claim.nodeId)} ¶${claim.para}`,
    title: titleOf(row),
    text: `${fact}\n${paragraph}`,
    citable: citableLabel(label),
    open: { kind: 'scene', id: claim.nodeId, para: claim.para },
    doc: null
  }
}

/**
 * Who knows a secret as of now: its reveal, then each knower's line that shows knowing or
 * half-knowing, with the quote; never a line that someone does not know (P2b rule 9).
 */
function knowsNow(frame: EvidenceFrame, secretId: string): Omit<EvidenceItem, 'id' | 'key'> | null {
  const knows = storedKnows(frame.db, frame.nowId, frame.reading, frame.nodes)
  const secret = knows.secrets.find((each) => each.recordId === secretId)
  if (secret === undefined) return null
  const lines: string[] = []
  const now = frame.nowId === null ? -1 : (frame.reading.at.get(frame.nowId) ?? -1)
  const defining = secret.defining
  if (defining !== null && (frame.reading.order.get(defining.nodeId) ?? Infinity) <= now) {
    lines.push(`Revealed in ${defining.ref}: “${defining.quote}”`)
  }
  for (const cell of secret.cells) {
    if (cell.later || cell.line === 'other') continue
    const who = nameOf(frame, cell.knowerId) || 'someone'
    if (cell.source === 'author') {
      lines.push(`${who}: knew before the book (your mark)`)
      continue
    }
    const quote = cell.claimId === null ? null : (getClaim(frame.db, cell.claimId)?.quote ?? null)
    const from = cell.fromId === null ? '' : ` from ${nameOf(frame, cell.fromId)}`
    const stale = cell.stale ? ', re-checking' : ''
    lines.push(
      `${who}: ${HOW_LABEL[cell.how]}${from} (${cell.ref ?? ''}${stale})${quote === null ? '' : `: “${quote}”`}`
    )
  }
  if (lines.length === 0) return null
  return {
    label: 'happened',
    ref: secret.readersSince?.ref ?? '',
    title: secret.label,
    text: lines.join('\n'),
    citable: true,
    open: { kind: 'record', id: secretId, para: null },
    doc: null
  }
}

const yearText = (year: YearView): string | null => {
  if (year.kind === 'unknown') return null
  const how = year.kind === 'carried' ? `carried from ${year.from.ref}` : year.kind
  return `${year.value} (${how})`
}

/** A character's age as of now, in words (computed, stated, not born yet, or the birth year alone). */
export function ageText(age: AgeView): string {
  switch (age.kind) {
    case 'computed':
      return `about ${age.age} (born ${age.born.year}; year ${age.year.value} from ${age.year.from.ref})`
    case 'notBorn':
      return `not born yet (born ${age.born.year}; year ${age.year.value} from ${age.year.from.ref})`
    case 'stated':
      return `${age.value}, stated in ${age.ref}${age.since.length > 0 ? ' (time has passed since)' : ''}`
    case 'bornOnly':
      return `born ${age.born.year} (no story year for this scene)`
  }
}

/** The story years up to now, or a record's age as of now: computed from the book (P3-D9). */
function timelineNow(
  frame: EvidenceFrame,
  recordId: string | null
): Omit<EvidenceItem, 'id' | 'key'> | null {
  const nowRef = frame.nowId === null ? '' : sceneRefOf(frame, frame.nowId)
  if (recordId !== null) {
    const record = frameRecord(frame, recordId)
    if (record === null) return null
    const age = storedAge(frame.db, recordId, frame.nowId, frame.reading, frame.nodes)
    if (age === null) return null
    return {
      label: 'computed',
      ref: nowRef,
      title: `${record.name}'s age`,
      text: `${record.name}'s age as of ${nowRef || 'the end of the book'}: ${ageText(age)}`,
      citable: true,
      open: { kind: 'record', id: recordId, para: null },
      doc: null
    }
  }
  const now = frame.nowId === null ? Infinity : (frame.reading.at.get(frame.nowId) ?? -1)
  const lines = storedYears(frame.db, frame.reading, frame.nodes).flatMap((year) => {
    const order = frame.reading.order.get(year.nodeId) ?? Infinity
    if (order > now || year.year.kind === 'carried') return []
    const text = yearText(year.year)
    return text === null ? [] : [`${year.ref}: ${text}${year.flashback ? ', a flashback' : ''}`]
  })
  if (lines.length === 0) return null
  return {
    label: 'computed',
    ref: nowRef,
    title: 'Story years',
    text: lines.join('\n'),
    citable: true,
    open: null,
    doc: null
  }
}

/** A record's Ideas, each paragraph numbered: the author's ideas, never in the book. */
function ideasNow(frame: EvidenceFrame, recordId: string): Omit<EvidenceItem, 'id' | 'key'> | null {
  const record = frameRecord(frame, recordId)
  const paragraphs = record?.ideas === null || record === null ? [] : markedParagraphs(record.ideas)
  if (record === null || paragraphs.length === 0) return null
  return {
    label: 'idea',
    ref: `${record.name}'s Ideas`,
    title: record.name,
    text: paragraphs.map((paragraph) => `¶${paragraph.index} ${paragraph.text}`).join('\n'),
    citable: true,
    open: { kind: 'record', id: recordId, page: 'ideas', para: null },
    doc: null
  }
}

/** The most outline lines one item lists. */
const OUTLINE_LINES = 80

/** The manuscript's chapters and scenes with their references, in reading order. */
function outlineNow(frame: EvidenceFrame): Omit<EvidenceItem, 'id' | 'key'> | null {
  const lines = manuscriptRows(frame.nodes).flatMap((row) => {
    if (row.kind === 'document') {
      const ref = sceneRefOf(frame, row.id)
      const what = frame.statuses.idea.has(row.id)
        ? ' (idea scene)'
        : frame.statuses.excluded.has(row.id)
          ? ' (cut from the book)'
          : ''
      return [`  ${ref} ${titleOf(row)}${what}`]
    }
    return row.hierarchyLevel === 'chapter' || row.hierarchyLevel === 'part'
      ? [`${titleOf(row)}`]
      : []
  })
  if (lines.length === 0) return null
  return {
    label: 'computed',
    ref: '',
    title: 'Outline',
    text: lines.slice(0, OUTLINE_LINES).join('\n'),
    citable: true,
    open: null,
    doc: null
  }
}

/** The author's open to-dos. */
function todosNow(frame: EvidenceFrame): Omit<EvidenceItem, 'id' | 'key'> | null {
  const open = listAuthorTodos(frame.db).filter((todo) => !todo.done)
  if (open.length === 0) return null
  return {
    label: 'todo',
    ref: '',
    title: 'Your to-dos',
    text: open.map((todo) => `- ${todo.text}`).join('\n'),
    citable: true,
    open: null,
    doc: null
  }
}

/** One key as it is now, without its id; null when what it names is gone or holds nothing. */
export function itemOf(
  frame: EvidenceFrame,
  key: EvidenceKey
): Omit<EvidenceItem, 'id' | 'key'> | null {
  switch (key.kind) {
    case 'scene': {
      const row = frame.documents.get(key.nodeId)
      if (row === undefined) return null
      const texts = rowTexts(row)
      const from = Math.min(key.from, key.to)
      const to = Math.min(Math.max(key.from, key.to), texts.length - 1)
      if (from > to) return null
      const label = sceneLabel(frame, key.nodeId)
      const ref = sceneRefOf(frame, key.nodeId)
      return {
        label,
        ref: from === to ? `${ref} ¶${from}` : `${ref} ¶${from}–${to}`,
        title: titleOf(row),
        text: texts
          .slice(from, to + 1)
          .map((text, i) => `¶${from + i} ${text}`)
          .join('\n'),
        citable: citableLabel(label),
        open: { kind: 'scene', id: key.nodeId, para: from },
        doc: null
      }
    }
    case 'passage':
      return passageNow(frame, key.source, key.ownerId, key.para)
    case 'claim':
      return claimNow(frame, key.claimId)
    case 'card':
      return cardNow(frame, key.nodeId)
    case 'knows':
      return knowsNow(frame, key.secretId)
    case 'timeline':
      return timelineNow(frame, key.recordId)
    case 'ideas':
      return ideasNow(frame, key.recordId)
    case 'outline':
      return outlineNow(frame)
    case 'todos':
      return todosNow(frame)
  }
}

/**
 * The keys as the book is now (P3-D1), numbered from `first` with `prefix` (`E1`…; `W1`… for a
 * widened chapter): a key whose owner is gone is dropped and counted; a key that names nothing now
 * (a secret no line shows, an empty Ideas page) is left out and not counted.
 */
export function resolveEvidence(
  db: TreeDb,
  keys: readonly EvidenceKey[],
  nowId: string | null,
  options: { first?: number; prefix?: 'E' | 'W'; frame?: EvidenceFrame } = {}
): { items: EvidenceItem[]; dropped: number } {
  const frame = options.frame ?? evidenceFrame(db, nowId)
  const prefix = options.prefix ?? 'E'
  let n = options.first ?? 1
  let dropped = 0
  const items: EvidenceItem[] = []
  for (const key of keys) {
    const item = itemOf(frame, key)
    if (item === null) {
      if (gone(frame, key)) dropped += 1
      continue
    }
    items.push({ id: `${prefix}${n}`, key, ...item })
    n += 1
  }
  return { items, dropped }
}

/** Whether what a key names is gone (a scene, a record, a claim, a Research page deleted). */
function gone(frame: EvidenceFrame, key: EvidenceKey): boolean {
  switch (key.kind) {
    case 'scene':
    case 'card':
      return !frame.documents.has(key.nodeId)
    case 'passage':
      if (key.source === 'pinned' || key.source === 'idea') {
        return frameRecord(frame, key.ownerId) === null
      }
      if (key.source === 'note' || key.source === 'research') {
        return !frame.nodes.some((row) => row.id === key.ownerId)
      }
      return !frame.documents.has(key.ownerId)
    case 'claim':
      return getClaim(frame.db, key.claimId) === null
    case 'knows':
      return frameRecord(frame, key.secretId) === null
    case 'timeline':
      return key.recordId !== null && frameRecord(frame, key.recordId) === null
    case 'ideas':
      return frameRecord(frame, key.recordId) === null
    case 'outline':
    case 'todos':
      return false
  }
}

/** One item as the prompt shows it: `E1 [happened, 9.3 ¶4] The quay` and its text. */
export function renderEvidenceItem(item: EvidenceItem): string {
  return `${item.id} [${evidenceTag(item.label, item.ref, item.doc)}] ${item.title}\n${item.text}`
}

/**
 * The labelled evidence within `budget` tokens, in the given order (the menu's rank): an item that
 * does not fit is left out and the ones after it still go in, so the far items are dropped first
 * and one long item never drops the rest. Answers the text, the ids kept and how many were dropped.
 */
export function renderEvidence(
  items: readonly EvidenceItem[],
  budget: number
): { text: string; kept: string[]; dropped: number } {
  const blocks: string[] = []
  const kept: string[] = []
  let used = 0
  for (const item of items) {
    const block = renderEvidenceItem(item)
    const cost = estimateTokens(block)
    if (used + cost > budget) continue
    blocks.push(block)
    kept.push(item.id)
    used += cost
  }
  return { text: blocks.join('\n\n'), kept, dropped: items.length - kept.length }
}
