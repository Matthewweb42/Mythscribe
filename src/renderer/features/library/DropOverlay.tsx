import { useEffect, useState } from 'react'
import { Library } from 'lucide-react'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useLibraryStore } from './libraryStore'

/** Whether a drag carries files from outside the app (a text drag inside the editor does not). */
const carriesFiles = (event: DragEvent): boolean =>
  event.dataTransfer?.types.includes('Files') === true

/**
 * Files dragged onto the window anywhere go to the context library (F-9.8): an overlay says so
 * while the drag is over the window, and a drop adds every file and offers to sort them. Listens
 * on the window in the capture phase, so a drop over the editor is the library's and never an
 * image pasted into the manuscript; a drag that carries no files (moving text) is left alone.
 * The manuscript importer stays in File › Import.
 */
export function DropOverlay(): React.JSX.Element | null {
  const [over, setOver] = useState(false)

  useEffect(() => {
    let depth = 0
    const onEnter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth += 1
      setOver(true)
    }
    const onOver = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOver(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      depth = 0
      setOver(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) return
      useLibraryStore
        .getState()
        .addDropped(files)
        .catch((err: unknown) => toast.error(describeError(err)))
    }
    window.addEventListener('dragenter', onEnter, true)
    window.addEventListener('dragover', onOver, true)
    window.addEventListener('dragleave', onLeave, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragenter', onEnter, true)
      window.removeEventListener('dragover', onOver, true)
      window.removeEventListener('dragleave', onLeave, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [])

  if (!over) return null
  return (
    <div
      data-testid="library-drop-overlay"
      className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-overlay"
    >
      <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-accent bg-surface-raised px-10 py-8 text-center shadow-panel">
        <Library size={28} aria-hidden="true" className="text-accent" />
        <p className="m-0 text-base font-semibold">Drop to add to the Library</p>
        <p className="m-0 text-sm text-fg-muted">
          Worldbuilding documents, character notes, maps, and art. You review before anything lands.
        </p>
      </div>
    </div>
  )
}
