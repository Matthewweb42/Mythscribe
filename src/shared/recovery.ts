import { z } from 'zod'

/**
 * Crash recovery (F-8.3). The editor stashes its latest unsaved state in a per-record journal
 * file under `<Project>.mythscribe/recovery/` on a short trailing throttle and clears it once the
 * real save lands; whatever a crash leaves behind is offered back on the next open. Only the two
 * Tiptap autosave stores take part: prose is what an author loses.
 */
export const RECOVERY_KINDS = ['document', 'notes'] as const
export const RecoveryKind = z.enum(RECOVERY_KINDS)
export type RecoveryKind = z.infer<typeof RecoveryKind>

/** How long after the first unstashed edit the editor writes its journal entry (trailing throttle). */
export const RECOVERY_STASH_MS = 250

/** One leftover journal entry that differs from what is stored, as the recovery prompt lists it. */
export const RecoveryItem = z.object({ kind: RecoveryKind, id: z.string(), title: z.string() })
export type RecoveryItem = z.infer<typeof RecoveryItem>

/** One entry written back by `recovery:restore`; `wordCount` is the new cached count for documents, null for notes. */
export const RecoveryRestored = z.object({
  kind: RecoveryKind,
  id: z.string(),
  wordCount: z.number().int().nonnegative().nullable()
})
export type RecoveryRestored = z.infer<typeof RecoveryRestored>
