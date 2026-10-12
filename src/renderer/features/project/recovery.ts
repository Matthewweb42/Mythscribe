import type { RecoveryItem, RecoveryKind } from '@shared/recovery'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import { refreshRewrittenDocuments } from '@renderer/features/editor/rewrittenDocuments'
import { pageKey, usePageStore } from '@renderer/features/research/pageStore'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { flushPendingSaves } from './pendingSaves'

/** How many recovered records the prompt names before it says "and N more". */
const LISTED_MAX = 5

/** What the prompt calls each kind's part of its record. */
const KIND_WORD: Record<RecoveryKind, string> = {
  document: 'text',
  notes: 'notes',
  pinned: 'Pinned',
  ideas: 'Ideas'
}

/** The prompt's list: `"Title" (text)`, `"Title" (notes)`, `"Name" (Pinned)`, at most `LISTED_MAX`, then "and N more". */
export function describeRecoveryItems(items: readonly RecoveryItem[]): string {
  const named = items
    .slice(0, LISTED_MAX)
    .map((item) => `"${item.title || 'Untitled'}" (${KIND_WORD[item.kind]})`)
  const more = items.length - named.length
  return more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ')
}

/**
 * Crash recovery (F-8.3): asks main for the journal entries a crash left behind and, if any,
 * offers them back. Recover writes them through the editor's save paths and reloads whatever an
 * editor has open; Discard asks once more, then deletes the journal; keeping it asks again on
 * the next open. Called when a project becomes current (start-up with one open, and open).
 */
export async function offerRecovery(): Promise<void> {
  try {
    const items = await ipc().invoke('recovery:list', undefined)
    if (items.length === 0) return
    const recover = await dialogs.confirm({
      title: 'Recover unsaved changes?',
      message: `MythScribe closed before these changes were saved: ${describeRecoveryItems(items)}.`,
      confirmLabel: 'Recover',
      cancelLabel: 'Discard…'
    })
    if (recover) {
      await flushPendingSaves()
      const restored = await ipc().invoke('recovery:restore', undefined)
      const notes = restored.filter((r) => r.kind === 'notes').map((r) => r.id)
      // F-16.6: a record's Pinned and Ideas open in a sheet are read again too.
      const pages = restored.flatMap((r) =>
        r.kind === 'pinned' || r.kind === 'ideas' ? [pageKey({ kind: r.kind, id: r.id })] : []
      )
      await Promise.all([
        refreshRewrittenDocuments(restored.filter((r) => r.kind === 'document')),
        useNotesStore.getState().reload(notes),
        usePageStore.getState().reload(pages)
      ])
      toast.success(
        restored.length === 1
          ? 'Recovered 1 unsaved change.'
          : `Recovered ${restored.length} unsaved changes.`
      )
      return
    }
    const discard = await dialogs.confirm({
      title: 'Discard unsaved changes?',
      message: 'They cannot be recovered afterwards.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep for later',
      danger: true
    })
    if (discard) await ipc().invoke('recovery:discard', undefined)
  } catch (err) {
    toast.error(describeError(err))
  }
}
