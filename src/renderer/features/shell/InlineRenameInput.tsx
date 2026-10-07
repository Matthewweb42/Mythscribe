import { useRef } from 'react'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'

interface InlineRenameInputProps {
  /** The current name; the field starts with it, selected. */
  value: string
  /** Called with the trimmed new name when it is non-empty and differs; a throw is toasted. */
  onCommit: (next: string) => Promise<unknown> | void
  /** Called once the rename settled: committed, cancelled, failed, or a no-op. */
  onDone: () => void
  label?: string
  maxLength?: number
  className?: string
}

/**
 * The one inline rename field (F-2.2, and since 2026-10-07 the double-click rename of the tree,
 * the story-bible lists, and the chat tabs): Enter or blur commits, Escape cancels, an empty or
 * unchanged name is a no-op. Clicks inside it never reach the row it replaces.
 */
export function InlineRenameInput({
  value,
  onCommit,
  onDone,
  label = 'Rename',
  maxLength,
  className = 'min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-sm text-fg outline-none'
}: InlineRenameInputProps): React.JSX.Element {
  // Enter and Escape both unmount the input, which can fire one last blur; skip it.
  const settled = useRef(false)

  const commit = async (raw: string): Promise<void> => {
    if (settled.current) return
    settled.current = true
    const next = raw.trim()
    if (next.length === 0 || next === value) {
      onDone()
      return
    }
    try {
      await onCommit(next)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      onDone()
    }
  }

  const cancel = (): void => {
    if (settled.current) return
    settled.current = true
    onDone()
  }

  return (
    <input
      aria-label={label}
      defaultValue={value}
      maxLength={maxLength}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={(event) => void commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          void commit(event.currentTarget.value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancel()
        }
      }}
      className={className}
    />
  )
}
