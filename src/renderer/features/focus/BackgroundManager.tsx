import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ImagePlus, Trash2, X } from 'lucide-react'
import type { Background } from '@shared/focus'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useBackgroundStore } from './backgroundStore'

const TILE =
  'flex h-full w-full flex-col items-stretch gap-1 rounded-md border border-line bg-bg p-1 text-left text-xs hover:border-line-strong aria-pressed:border-accent aria-pressed:ring-1 aria-pressed:ring-accent'
const THUMB = 'aspect-video w-full rounded-sm bg-surface object-cover'

/**
 * The Background Manager (F-6.2): a modal listing the project's uploaded backgrounds as
 * thumbnails, with "No background" first. A tile is a toggle button (`aria-pressed` marks the
 * current one); Delete asks for confirmation and removes the file; "Add images…" opens the OS
 * file dialog through main. Escape, the close button, and a click on the backdrop close it.
 * Opened from Settings → Editor until the control bar (F-6.5) hosts the same component.
 */
export function BackgroundManager({ onClose }: { onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const backgrounds = useBackgroundStore((s) => s.backgrounds)
  const currentId = useBackgroundStore((s) => s.settings?.backgroundId ?? null)
  const loaded = useBackgroundStore((s) => s.settings !== null)
  const select = useBackgroundStore((s) => s.select)
  const add = useBackgroundStore((s) => s.add)
  const remove = useBackgroundStore((s) => s.remove)
  const [busy, setBusy] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButton.current?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    // The Settings dialog behind listens for Escape too; this one is closer.
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await task()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async (background: Background): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete "${background.name}"?`,
      message: 'This removes the image from the project folder. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await run(() => remove(background.id))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex max-h-[85vh] w-[560px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel"
      >
        <div className="flex items-center justify-between gap-2 px-5 pt-4">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Backgrounds
          </h2>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close backgrounds"
            title="Close"
            onClick={onClose}
            className="-mr-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="mx-5 mt-1 mb-0 text-xs text-fg-muted">
          Shown behind the editor in focus mode. Images are copied into the project folder.
        </p>
        <ul role="list" className="m-0 grid list-none grid-cols-3 gap-2 overflow-y-auto p-5">
          <li className="relative">
            <button
              type="button"
              aria-pressed={currentId === null}
              disabled={!loaded}
              onClick={() => select(null)}
              className={TILE}
            >
              <span
                aria-hidden="true"
                className={`${THUMB} flex items-center justify-center text-fg-subtle`}
              >
                None
              </span>
              <span className="truncate px-1 pb-0.5">No background</span>
            </button>
          </li>
          {backgrounds.map((background) => (
            <li key={background.id} className="relative">
              <button
                type="button"
                aria-pressed={currentId === background.id}
                aria-label={background.name}
                disabled={!loaded}
                onClick={() => select(background.id)}
                className={TILE}
              >
                <img src={background.url} alt="" className={THUMB} />
                <span className="truncate px-1 pb-0.5">{background.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Delete ${background.name}`}
                title="Delete"
                disabled={busy}
                onClick={() => void confirmDelete(background)}
                className="absolute top-2 right-2 rounded-md bg-overlay p-1 text-fg-muted hover:text-danger"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3 text-sm">
          <span className="text-xs text-fg-muted">
            {backgrounds.length === 0
              ? 'No images yet.'
              : `${backgrounds.length} image${backgrounds.length === 1 ? '' : 's'}`}
          </span>
          <button
            type="button"
            disabled={busy || !loaded}
            onClick={() => void run(add)}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 hover:bg-surface disabled:opacity-60"
          >
            <ImagePlus size={14} aria-hidden="true" />
            Add images…
          </button>
        </div>
      </div>
    </div>
  )
}
