import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { flushPendingSaves } from './pendingSaves'

/**
 * Save on blur (F-8.3): when the window loses focus, or its page is hidden (minimized, another
 * desktop), every pending save is written at once instead of waiting for the autosave debounce.
 * Returns the uninstaller; `App.tsx` mounts it once.
 */
export function installSaveOnBlur(target: Window = window): () => void {
  const flush = (): void => {
    flushPendingSaves().catch((err: unknown) => toast.error(describeError(err)))
  }
  const onVisibility = (): void => {
    if (target.document.visibilityState === 'hidden') flush()
  }
  target.addEventListener('blur', flush)
  target.document.addEventListener('visibilitychange', onVisibility)
  return () => {
    target.removeEventListener('blur', flush)
    target.document.removeEventListener('visibilitychange', onVisibility)
  }
}
