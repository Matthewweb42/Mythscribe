import { setsState } from '@shared/memory/claims'
import {
  RULE_ORDER,
  type Finding,
  type FindingSideView,
  type FindingState,
  type FindingView
} from '@shared/memory/findings'
import { parseSlot, slotLabel } from '@shared/memory/slots'
import type { FindingsView } from '@shared/memory/views'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
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
 * many wait for a verdict; whether a judge run is queued or running. Empty while the
 * **Contradiction check** switch is off (P4-D21: with Use AI off, judged findings stay visible).
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
  return { open: [], unclear: [], counts: EMPTY_COUNTS(), waiting: 0, judging: false }
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

/** A finding as the channels answer it; null when a side is gone. */
export function findingView(ctx: JudgeContext, finding: Finding): FindingView | null {
  const a = resolveSide(ctx, finding.a)
  const b = resolveSide(ctx, finding.b)
  if (a === null || b === null) return null
  const bookClaim = [a, b].find((side) => side.kind === 'claim')?.claim ?? null
  const flashback =
    finding.state === 'hidden'
      ? ([a, b].find((side) => side.nodeId !== null && ctx.inputs.scene(side.nodeId).flashback)
          ?.nodeId ?? null)
      : null
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
    actions: {
      // P4-D17: *This one's right* marks the other side not right; on a note conflict the book is
      // canon (answer 1), so neither side offers it (the panel offers *Update my note*).
      right: {
        a: a.kind !== 'note' && b.kind !== 'note',
        b: a.kind !== 'note' && b.kind !== 'note'
      },
      // P4-D18: a note conflict whose book side is narration in `now` mode.
      updateNote: finding.rule === 'C6' && bookClaim !== null && setsState(bookClaim),
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
  const draftId = currentDraftId(db)
  if (!options.on || draftId === null) return emptyFindingsView()
  const all = findingsOf(db, draftId)
  const counts = EMPTY_COUNTS()
  for (const finding of all) counts[finding.state] += 1
  const shown = all.filter((finding) => finding.state === 'open' || finding.state === 'unclear')
  if (shown.length === 0) {
    return { ...emptyFindingsView(), counts, waiting: counts.unjudged, judging: options.judging }
  }
  const ctx = judgeContext(db, draftId)
  return {
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
    judging: options.judging
  }
}
