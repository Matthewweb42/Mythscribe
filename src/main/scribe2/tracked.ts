import type { AgentEdit } from '@shared/agent'
import { createScribePass, insertChanges, type ChangeInput } from '../editPass/editPassStore'
import type { TreeDb } from '../tree/treeStore'

/**
 * Ms Scribe's prose suggestions as tracked changes in the scene (notes fixes, 2026-10-15): each
 * `propose_prose_edit` of a turn becomes a pending `edit_change` row of one hidden `edit_pass` row
 * per turn (`createScribePass`), so the editor's tracked-change plugin draws it inline with Accept
 * and Reject and `editPass:settle` settles it, exactly as the edit flow's fixes. The chat card
 * stays; it carries the row's id (`trackedId`) and the two stay in sync through the settle.
 * Nothing is applied here: a suggestion waits for the author in every mode.
 */

/** What the editor shows on the change's hover and the review deck: whose suggestion it is. */
export const SCRIBE_TRACKED_RATIONALE = 'Ms Scribe’s suggestion'

interface TurnChange {
  edit: AgentEdit
  violation: string | null
  applied: boolean
}

/**
 * Writes a turn's prose suggestions as tracked changes (owned by one hidden row) and answers, for
 * every change in order, its row's id, or null for a change that is not a waiting text
 * replacement (a note edit, applied already). Answers all null, writing nothing, when the turn
 * proposed no prose. `textOf` gives a scene's text as it stands, for the change's place in it.
 */
export function trackScribeProposals(
  db: TreeDb,
  changes: readonly TurnChange[],
  proposalId: string,
  textOf: (nodeId: string) => string | null,
  now?: string
): (string | null)[] {
  const prose = changes.flatMap((change, index) =>
    change.edit.kind === 'text' && !change.applied ? [{ index, change, edit: change.edit }] : []
  )
  if (prose.length === 0) return changes.map(() => null)
  return db.transaction((tx) => {
    const nodeIds = [...new Set(prose.map(({ edit }) => edit.nodeId))]
    const pass = createScribePass(tx, nodeIds, now)
    const rows: ChangeInput[] = prose.map(({ change, edit }) => {
      const at = textOf(edit.nodeId)?.indexOf(edit.find) ?? -1
      return {
        passId: pass.id,
        nodeId: edit.nodeId,
        kind: 'change',
        position: Math.max(0, at),
        original: edit.find,
        replacement: edit.replace,
        rationale: SCRIBE_TRACKED_RATIONALE,
        category: null,
        flagged: change.violation !== null,
        violation: change.violation,
        proposalId
      }
    })
    const ids = insertChanges(tx, rows)
    const byIndex = new Map(prose.map(({ index }, i) => [index, ids[i] ?? null]))
    return changes.map((_, index) => byIndex.get(index) ?? null)
  })
}
