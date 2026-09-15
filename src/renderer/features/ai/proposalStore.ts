import type { SettledStatus } from '@shared/proposal'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer side of proposal review (F-14.5). Every AI answer the author can act on
 * arrives with a `proposalId`; whichever surface showed it (the ghost-text widget, the tag
 * bar) settles it exactly once when the author accepts, accepts part, rejects, or asks
 * again. The guard below makes a second settlement for the same id a no-op here, before the
 * store in main makes it one too. A failed write toasts: nothing in the manuscript depends on
 * it, and the row stays pending (the retention cap bounds it).
 */

/** Ids already handed to `proposal:settle` this session (a settlement in flight counts). */
const settled = new Set<string>()

async function settle(
  id: string,
  status: SettledStatus,
  note: string | null = null
): Promise<void> {
  if (settled.has(id)) return
  settled.add(id)
  try {
    await ipc().invoke('proposal:settle', { id, status, note })
  } catch (err) {
    toast.error(describeError(err))
  }
}

export const proposalStore = { settle }

/** Forgets every settled id. For tests only. */
export function resetProposalStore(): void {
  settled.clear()
}
