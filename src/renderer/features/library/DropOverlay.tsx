import { useEffect, useState } from 'react'
import { Library, NotebookText } from 'lucide-react'
import { currentStoryMemory, useStoryMemory } from '@renderer/features/project/storyMemory'
import { useResearchStore } from '@renderer/features/research/researchStore'
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
 * The manuscript importer stays in File › Import. In story memory v2 (F-16.8) there is no Library
 * section and no sort: a drop becomes Research pages, as Upload in the Research tab does.
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
      const adding =
        currentStoryMemory() === 'v2'
          ? useResearchStore.getState().addDropped(files)
          : useLibraryStore.getState().addDropped(files)
      adding.catch((err: unknown) => toast.error(describeError(err)))
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
  return <DropHint />
}

/** What a drop will do, in the open project's story memory. */
function DropHint(): React.JSX.Element {
  const research = useStoryMemory() === 'v2'
  const Icon = research ? NotebookText : Library
  return (
    <div
      data-testid="library-drop-overlay"
      className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-overlay"
    >
      <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-accent bg-surface-raised px-10 py-8 text-center shadow-panel">
        <Icon size={28} aria-hidden="true" className="text-accent" />
        <p className="m-0 text-base font-semibold">
          {research ? 'Drop to add to Research' : 'Drop to add to the Library'}
        </p>
        <p className="m-0 text-sm text-fg-muted">
          {research
            ? 'Worldbuilding documents, notes, maps, and art, each as a page you can read and edit.'
            : 'Worldbuilding documents, character notes, maps, and art. You review before anything lands.'}
        </p>
      </div>
    </div>
  )
}
