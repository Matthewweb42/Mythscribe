import type { FindingSideView } from '@shared/memory/findings'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { openRecordSheet } from '@renderer/features/records/openRecord'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { openResearchPage } from '@renderer/features/research/openResearch'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'

/**
 * *Go there* on a finding's side (F-16.27, F-16.29): a book side opens its scene with the quote
 * selected (F-9.6's jump guard, `openPassage`: a quote no longer there says so); a note side opens
 * the record's sheet (leaving focus mode first: a sheet has no focus view) or the Research page.
 */
export function openSide(side: FindingSideView): void {
  const fail = (err: unknown): void => {
    toast.error(describeError(err))
  }
  switch (side.open.kind) {
    case 'scene':
      openPassage(side.open.id, (doc) => locateText(doc, side.quote)).catch(fail)
      return
    case 'research':
      openResearchPage(side.open.id)
      return
    case 'record':
      openSheet(side.open.id).catch(fail)
  }
}

/** A record's sheet (its Pinned page shows there), out of focus mode first. */
async function openSheet(recordId: string): Promise<void> {
  const record = useRecordStore.getState().byId[recordId]
  if (record === undefined) {
    toast.error('That record is gone')
    return
  }
  const focus = useFocusStore.getState()
  if (focus.active) await focus.exit()
  openRecordSheet(record.id, record.categoryId)
}

/** Opens a scene with a quote selected (a *This one's right* line's *Go there*). */
export function openQuote(nodeId: string, quote: string): void {
  openPassage(nodeId, (doc) => locateText(doc, quote)).catch((err: unknown) =>
    toast.error(describeError(err))
  )
}
