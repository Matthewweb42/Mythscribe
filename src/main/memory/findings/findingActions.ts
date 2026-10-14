import { setsState } from '@shared/memory/claims'
import type { Dismissed } from '@shared/memory/dismissed'
import type { Finding, FindingSide } from '@shared/memory/findings'
import { kinWords } from '@shared/memory/literal'
import { looseEnds, looseKey } from '@shared/memory/looseEnds'
import { patchNoteParagraph } from '@shared/memory/noteValues'
import { pageTextBlocks, withoutAiMarks } from '@shared/memory/pageMarks'
import type {
  LooseEndKey,
  LooseEndsView,
  NotePatch,
  NotePatchApplied,
  SceneRefView
} from '@shared/memory/views'
import type { TiptapNodeT } from '@shared/tiptap'
import { currentDraftId } from '../../draft/draftStore'
import { AppError } from '../../ipc/errors'
import { getNode, type TreeDb } from '../../tree/treeStore'
import { searchableText } from '@shared/search'
import { dismiss } from '../dismissedStore'
import { indexOwner } from '../passageIndexer'
import { getRecord } from '../recordStore'
import { cardNotRight, wrongValue } from '../reading/notRight'
import { findingsFrame, looseEndInputs } from './candidateInputs'
import { closeFindings, findingsOf } from './findingStore'
import { findingView } from './findingViews'
import { judgeContext, recordName, resolveSide } from './judge'

/**
 * The answers on a finding and a loose end, main side (F-16.27, F-16.29; plan P4 §3.2, P4-D17,
 * P4-D18). Findings are derived index data: *Not a problem* and *This one's right* write only
 * Dismissed rows (through the paths that already own them) and close the finding; the one write to
 * the author's text is *Update my note*, a code-made proposal she edits and saves. Nothing here ever
 * touches the manuscript.
 */

/** A finding of the active draft by id; NOT_FOUND once it closed. */
export function requireFinding(db: TreeDb, findingId: string): Finding {
  const draftId = currentDraftId(db)
  const found =
    draftId === null ? undefined : findingsOf(db, draftId).find((each) => each.id === findingId)
  if (found === undefined) {
    throw new AppError('NOT_FOUND', 'That possible contradiction is no longer there', {
      findingId
    })
  }
  return found
}

/** The scenes and records an answer on `finding` moved (the `memory:changed` it pushes). */
export function findingTouches(finding: Finding): { nodeIds: string[]; recordIds: string[] } {
  const nodeIds = [finding.a, finding.b].flatMap((side) =>
    side.kind === 'note' ? [] : [side.nodeId]
  )
  return { nodeIds: [...new Set(nodeIds)].sort(), recordIds: [finding.recordId] }
}

const quoted = (text: string): string => `“${text}”`

/**
 * *Not a problem* (design §2.4, P4-D14): a `notProblem` Dismissed row keyed by the finding's *Not a
 * problem* key (the record, the slot, both values and places), labelled "Mara Vell: eyes grey (1.1)
 * and brown (1.2): not a problem" with both quotes; the finding closes (reason `dismissed`). *Undo*
 * in Dismissed deletes the row, and the next recompute brings the finding back with its remembered
 * verdicts at no cost.
 */
export function findingNotProblem(db: TreeDb, findingId: string, now: Date): Dismissed {
  const finding = requireFinding(db, findingId)
  const ctx = judgeContext(db, finding.draftId)
  const view = findingView(ctx, finding)
  const name = recordName(ctx, finding.recordId)
  const label =
    view === null
      ? `${name}: not a problem`
      : `${view.name}: ${view.slotLabel.toLowerCase()} ${view.a.value} (${view.a.label}) and ${view.b.value} (${view.b.label}): not a problem`
  const bookSide = [finding.a, finding.b].find(
    (side): side is Exclude<FindingSide, { kind: 'note' }> => side.kind !== 'note'
  )
  const row = dismiss(
    db,
    {
      kind: 'notProblem',
      key: finding.npKey,
      recordId: getRecord(db, finding.recordId) === null ? null : finding.recordId,
      nodeId: bookSide?.nodeId ?? null,
      label,
      quote: view === null ? null : `${quoted(view.a.quote)} · ${quoted(view.b.quote)}`
    },
    now
  )
  closeFindings(db, finding.draftId, [{ key: finding.key, reason: 'dismissed' }])
  return row
}

/**
 * *This one's right* under `side` (P4-D17): the other side is marked not right through its own
 * path: a line's *Not right › Wrong value* (`wrongValue`), a character on the page the card's *Not
 * right* (`cardNotRight`); the finding closes (reason `right`). Never on a note conflict (the book
 * is canon: the panel offers *Update my note*), never the manuscript. Answers the Dismissed row and
 * the other side's scene, for *Go there*.
 */
export function findingRight(
  db: TreeDb,
  findingId: string,
  side: 'a' | 'b',
  now: Date
): { dismissed: Dismissed | null; other: SceneRefView | null } {
  const finding = requireFinding(db, findingId)
  const other: FindingSide = side === 'a' ? finding.b : finding.a
  if (finding.a.kind === 'note' || finding.b.kind === 'note' || other.kind === 'note') {
    throw new AppError(
      'VALIDATION',
      'The book is the canon side of a note conflict: update your note, or mark it not a problem.',
      { findingId }
    )
  }
  let dismissed: Dismissed | null
  if (other.kind === 'claim') {
    dismissed = wrongValue(db, other.claimId, now).dismissed
  } else {
    dismissed = cardNotRight(
      db,
      { nodeId: other.nodeId, field: 'present', value: other.recordId },
      now
    )
  }
  closeFindings(db, finding.draftId, [{ key: finding.key, reason: 'right' }])
  const ref = findingsFrame(db).reading.refs.get(other.nodeId) ?? ''
  return { dismissed, other: { nodeId: other.nodeId, ref } }
}

/** A C6 finding's note side and book side, or null for any other finding. */
function noteConflict(finding: Finding): {
  note: Extract<FindingSide, { kind: 'note' }>
  book: Extract<FindingSide, { kind: 'claim' }>
} | null {
  if (finding.rule !== 'C6') return null
  const [note, book] = finding.a.kind === 'note' ? [finding.a, finding.b] : [finding.b, finding.a]
  return note.kind === 'note' && book.kind === 'claim' ? { note, book } : null
}

/**
 * *Update my note*'s proposal (P4-D18), in code: offered only for a book-against-note finding
 * whose book side is narration in `now` mode (never speech, rumour, a memory, a thought, a dream or
 * a hypothetical); the note sentence with the note's value replaced by the book's (for kinship,
 * the book's kin word). Null when it is not offered or code cannot place the value.
 */
export function notePatch(db: TreeDb, findingId: string): NotePatch | null {
  const finding = requireFinding(db, findingId)
  const conflict = noteConflict(finding)
  if (conflict === null) return null
  const ctx = judgeContext(db, finding.draftId)
  const claim = ctx.claims.get(conflict.book.claimId)
  const note = resolveSide(ctx, conflict.note)
  if (claim === undefined || note === null || !setsState(claim)) return null
  const bookValue = finding.slot.startsWith('kinship:')
    ? (kinWords(claim.value)[0]?.word ?? claim.value)
    : claim.value
  const patched = patchNoteParagraph(
    note.paragraph,
    conflict.note.sentence,
    conflict.note.value,
    bookValue
  )
  if (patched === null) return null
  return {
    findingId,
    owner: { kind: conflict.note.ownerKind, id: conflict.note.ownerId, name: note.ref },
    page: conflict.note.page,
    index: conflict.note.para,
    before: note.paragraph,
    after: patched.after,
    sentence: patched.sentence,
    value: bookValue
  }
}

/**
 * `doc` with its text block `index` (`pageTextBlocks` numbering, the passage index's) replaced by
 * `text`, found by index and its text as it read (`before`); the block's AI marks go (the words are
 * the author's now, F-16.6). VALIDATION when the block moved or changed since.
 */
export function patchedPage(
  doc: TiptapNodeT,
  index: number,
  before: string,
  text: string
): TiptapNodeT {
  const target = pageTextBlocks(doc).find((block) => block.index === index && block.text === before)
  if (target === undefined) {
    throw new AppError('VALIDATION', 'That line changed since; open the page to edit it')
  }
  const replace = (node: TiptapNodeT): TiptapNodeT => {
    if (node === target.block) {
      return withoutAiMarks({ ...node, content: [{ type: 'text', text }] })
    }
    return node.content === undefined ? node : { ...node, content: node.content.map(replace) }
  }
  return replace(doc)
}

/** How *Update my note* saves a page: through the owners' own writes (the handlers'). */
export interface NoteWriters {
  pinned: (recordId: string, doc: TiptapNodeT) => void
  research: (nodeId: string, doc: TiptapNodeT) => void
  /** The page as stored now (a Research page's document; a record's Pinned page). */
  read: (owner: { kind: 'record' | 'research'; id: string }) => TiptapNodeT | null
}

/**
 * Saves the author's edited note line (*Update my note*, design §2.2's second exception): the
 * paragraph found by its index and text (VALIDATION when it moved since), through the page's own
 * save; then the page is indexed again at once and the finding closes (reason `right`). If the
 * line still disagrees, the next recompute finds the new pair.
 */
export function applyNotePatch(
  db: TreeDb,
  input: { findingId: string; index: number; before: string; text: string },
  writers: NoteWriters,
  now: Date
): NotePatchApplied {
  const finding = requireFinding(db, input.findingId)
  const conflict = noteConflict(finding)
  if (conflict === null) {
    throw new AppError('VALIDATION', 'Update my note is only for a note against the book')
  }
  const text = input.text.replace(/\s+/g, ' ').trim()
  if (text === '') throw new AppError('VALIDATION', 'A note line needs some words')
  if (text === input.before.replace(/\s+/g, ' ').trim()) {
    throw new AppError('VALIDATION', 'The line is unchanged')
  }
  const owner = { kind: conflict.note.ownerKind, id: conflict.note.ownerId }
  if (owner.kind === 'record' && conflict.note.page !== 'pinned') {
    throw new AppError('VALIDATION', 'That line changed since; open the page to edit it')
  }
  const stored = writers.read(owner)
  if (stored === null) {
    throw new AppError('VALIDATION', 'That line changed since; open the page to edit it')
  }
  const next = patchedPage(stored, input.index, input.before, text)
  if (owner.kind === 'record') writers.pinned(owner.id, next)
  else writers.research(owner.id, next)
  // Indexed at once, so no recompute reads the old line again.
  indexOwner(db, owner.kind, owner.id, now)
  const closed = closeFindings(db, finding.draftId, [{ key: finding.key, reason: 'right' }])
  return { owner, closed: closed.length > 0 }
}

/** Needs a look's Loose ends over the active draft (local, free; Use AI off too). */
export function looseEndsView(db: TreeDb): LooseEndsView {
  return looseEnds(looseEndInputs(db, currentDraftId(db)))
}

/**
 * *Not a problem* on a loose end (P4-D19): a `notProblem` row keyed by what it is and where it was
 * last touched, so a later touch brings it back.
 */
export function looseEndNotProblem(db: TreeDb, input: LooseEndKey, now: Date): Dismissed {
  const name =
    input.kind === 'planned'
      ? searchableText(getNode(db, input.id)?.title ?? '').trim() || 'Untitled scene'
      : (getRecord(db, input.id)?.name ?? '')
  if (name === '') {
    throw new AppError('NOT_FOUND', 'That loose end is no longer there', { id: input.id })
  }
  const frame = findingsFrame(db)
  const last = input.lastNodeId === null ? null : (frame.reading.refs.get(input.lastNodeId) ?? null)
  const what =
    input.kind === 'planned'
      ? `planned scene “${name}”`
      : last === null
        ? name
        : `${name} (last in ${last})`
  return dismiss(
    db,
    {
      kind: 'notProblem',
      key: looseKey(input.kind, input.id, input.lastNodeId),
      recordId: input.kind === 'planned' ? null : input.id,
      nodeId: input.kind === 'planned' ? input.id : input.lastNodeId,
      label: `Loose end: ${what}: not a problem`
    },
    now
  )
}
