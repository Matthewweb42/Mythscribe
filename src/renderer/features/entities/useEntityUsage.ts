import { useEffect } from 'react'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useMentionStore } from '@renderer/features/tags/mentionStore'
import { describeError } from '@renderer/lib/errors'

/**
 * Asks for what the entity page's scene lists read (F-9.4, F-11.2c): every document's tags and
 * the entity tag's recorded mentions, once per tag; both stores then follow main's own events,
 * so a scan that lands while the page is open shows up without a reload. Failures are toasted.
 */
export function useEntityUsage(tagId: string | null): void {
  useEffect(() => {
    if (tagId === null) return
    const report = (err: unknown): void => {
      toast.error(describeError(err))
    }
    useDocumentTagStore.getState().loadAll().catch(report)
    useMentionStore.getState().loadForTag(tagId).catch(report)
  }, [tagId])
}
