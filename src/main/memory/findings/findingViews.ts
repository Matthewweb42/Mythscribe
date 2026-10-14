import { setsState } from '@shared/memory/claims'
import {
  hidingScenes,
  RULE_ORDER,
  type Finding,
  type FindingSide,
  type FindingSideView,
  type FindingState,
  type FindingView
} from '@shared/memory/findings'
import { kinWords } from '@shared/memory/literal'
import { patchNoteParagraph } from '@shared/memory/noteValues'
import { parseSlot, slotLabel } from '@shared/memory/slots'
import { NOTE_PATCH_MAX, type FindingsView } from '@shared/memory/views'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { sceneReadState } from '../reading/views'
import { findingsOf } from './findingStore'
import {
  judgeContext,
  recordName,
  resolveSide,
  type JudgeContext,
  type ResolvedSide
} from './judge'

/**
 * `memory:findings` (F-16.27; plan P4 §2.4): the active draft's open findings (those touching the
 * asked scene first, then by `RULE_ORDER` and reading order) and the unclear ones, each with both
 * sides resolved for display against the book and the notes as they are now; counts by state; how
 * many wait for a verdict; whether a judge run is queued or running; whether the asked scene was
 * read and how much of it is not read yet (what a scoped answer says it has not checked). Empty,
 * with `on` false, while the **Contradiction check** switch is off (P4-D21: with Use AI off,
 * judged findings stay visible).
 * A finding whose side is gone is left out (the next recompute closes it). Local and free.
 */

const EMPTY_COUNTS = (): Record<FindingState, number> => ({
  unjudged: 0,
  held: 0,
  hidden: 0,
  open: 0,
  unclear: 0,
  fine: 0
})

export function emptyFindingsView(): FindingsView {
  return {
    on: false,
    open: [],
    unclear: [],
    counts: EMPTY_COUNTS(),
    waiting: 0,
    judging: false,
    scene: null
  }
}

/** A finding's slot as a sheet names it ("Eyes", "Family (Orrin)", "Knows: the sold map"). */
function slotTitle(ctx: JudgeContext, slot: string): string {
  if (slot.startsWith('kinship:')) {
    const object = recordName(ctx, slot.slice('kinship:'.length))
    return object === '' ? 'Family' : `Family (${object})`
  }
  if (slot.startsWith('knows:')) return `Knows: ${recordName(ctx, slot.slice('knows:'.length))}`
  const parsed = parseSlot(slot)
  return parsed === null ? slot : slotLabel(parsed)
}

function sideView(side: ResolvedSide): FindingSideView {
  return {
    kind: side.kind,
    ref: side.ref,
    nodeId: side.nodeId,
    para: side.para,
    quote: side.quote,
    value: side.value,
    voice: side.voice,
    mode: side.mode,
    label: side.kind === 'note' ? side.place : side.ref,
    open: side.open
  }
}

/** *Update my note*'s edit of a C6 finding's note paragraph (`noteEdit`). */
export interface NoteEdit {
  note: Extract<FindingSide, { kind: 'note' }>
  /** The note side resolved: its paragraph as the passage index reads it, its owner's name. */
  resolved: ResolvedSide
  /** The note's sentence as it reads now, and the paragraph with the book's value in it. */
  sentence: string
  after: string
  /** The book's value (its kin word for kinship). */
  value: string
}

/**
 * *Update my note*'s edit (P4-D18), the one test behind both the view's offer and the proposal: a
 * C6 finding whose book side is narration in `now` mode (never speech, rumour, a memory, a
 * thought, a dream or a hypothetical) and whose note value code can place in its sentence, with the
 * paragraph before and after within `NOTE_PATCH_MAX` so its save's channel takes them. Null when
 * it is not offered.
 */
export function noteEdit(finding: Finding, a: ResolvedSide, b: ResolvedSide): NoteEdit | null {
  if (finding.rule !== 'C6') return null
  const [note, resolved, book] = finding.a.kind === 'note' ? [finding.a, a, b] : [finding.b, b, a]
  if (note.kind !== 'note' || resolved.kind !== 'note' || book.claim === null) return null
  if (!setsState(book.claim) || resolved.paragraph.length > NOTE_PATCH_MAX) return null
  const value = finding.slot.startsWith('kinship:')
    ? (kinWords(book.claim.value)[0]?.word ?? book.claim.value)
    : book.claim.value
  const patched = patchNoteParagraph(resolved.paragraph, note.sentence, note.value, value)
  if (patched === null || patched.after.length > NOTE_PATCH_MAX) return null
  return { note, resolved, sentence: patched.sentence, after: patched.after, value }
}

/** A finding as the channels answer it; null when a side is gone. */
export function findingView(ctx: JudgeContext, finding: Finding): FindingView | null {
  const a = resolveSide(ctx, finding.a)
  const b = resolveSide(ctx, finding.b)
  if (a === null || b === null) return null
  // The scenes whose flashback hides it, by its rule's own sides (`flashbackSides`), so *Not a
  // flashback?* sets the switch of the scene that hides the pair, never the other side's.
  const flashback =
    finding.state === 'hidden'
      ? hidingScenes(
          finding.rule,
          finding.variant,
          finding.a,
          finding.b,
          (nodeId) => ctx.inputs.scene(nodeId).flashback
        )
      : []
  return {
    id: finding.id,
    rule: finding.rule,
    variant: finding.variant,
    recordId: finding.recordId,
    name: recordName(ctx, finding.recordId),
    slot: finding.slot,
    slotLabel: slotTitle(ctx, finding.slot),
    a: sideView(a),
    b: sideView(b),
    state: finding.state,
    verdictAb: finding.verdictAb,
    verdictBa: finding.verdictBa,
    confirmed: finding.confirm === 'c',
    why: finding.why,
    costUsd: finding.costUsd,
    year:
      finding.extra?.year === undefined
        ? null
        : { value: finding.extra.year.value, source: finding.extra.year.source },
    actions: {
      // P4-D17: *This one's right* marks the other side not right; on a note conflict the book is
      // canon (answer 1), so neither side offers it (the panel offers *Update my note*).
      right: {
        a: a.kind !== 'note' && b.kind !== 'note',
        b: a.kind !== 'note' && b.kind !== 'note'
      },
      // P4-D18: a note conflict whose book side is narration in `now` mode, offered only when
      // code can place the note's value (the proposal's own test).
      updateNote: noteEdit(finding, a, b) !== null,
      notFlashback: flashback
    }
  }
}

/** The findings listed for `nodeId`: those touching it first, then by rule, then reading order. */
function listed(
  ctx: JudgeContext,
  findings: readonly Finding[],
  nodeId: string | null
): FindingView[] {
  const order = ctx.inputs.reading.order
  const views = findings.flatMap((finding) => {
    const view = findingView(ctx, finding)
    return view === null ? [] : [view]
  })
  const touches = (view: FindingView): number =>
    nodeId !== null && (view.a.nodeId === nodeId || view.b.nodeId === nodeId) ? 0 : 1
  const at = (view: FindingView): number =>
    Math.min(
      ...[view.a.nodeId, view.b.nodeId].map((id) =>
        id === null ? Number.MAX_SAFE_INTEGER : (order.get(id) ?? Number.MAX_SAFE_INTEGER)
      )
    )
  return views.sort(
    (x, y) =>
      touches(x) - touches(y) ||
      RULE_ORDER.indexOf(x.rule) - RULE_ORDER.indexOf(y.rule) ||
      at(x) - at(y)
  )
}

export interface FindingsViewOptions {
  /** The Contradiction check switch (`features.judge`); off, the view is empty. */
  on: boolean
  /** A judge or check run is queued or running. */
  judging: boolean
}

export function findingsView(
  db: TreeDb,
  nodeId: string | null,
  options: FindingsViewOptions
): FindingsView {
  if (!options.on) return emptyFindingsView()
  const draftId = currentDraftId(db)
  const scene = nodeId === null ? null : sceneReadState(db, nodeId, draftId)
  // No draft yet: nothing was read, so nothing was judged.
  const all = draftId === null ? [] : findingsOf(db, draftId)
  const counts = EMPTY_COUNTS()
  for (const finding of all) counts[finding.state] += 1
  const shown = all.filter((finding) => finding.state === 'open' || finding.state === 'unclear')
  if (shown.length === 0 || draftId === null) {
    return {
      ...emptyFindingsView(),
      on: true,
      counts,
      waiting: counts.unjudged,
      judging: options.judging,
      scene
    }
  }
  const ctx = judgeContext(db, draftId)
  return {
    on: true,
    open: listed(
      ctx,
      shown.filter((finding) => finding.state === 'open'),
      nodeId
    ),
    unclear: listed(
      ctx,
      shown.filter((finding) => finding.state === 'unclear'),
      nodeId
    ),
    counts,
    waiting: counts.unjudged,
    judging: options.judging,
    scene
  }
}
