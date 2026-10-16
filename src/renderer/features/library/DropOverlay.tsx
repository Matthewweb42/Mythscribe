import { useEffect, useState } from 'react'
import { Library, NotebookPen, NotebookText } from 'lucide-react'
import { currentStoryMemory, useStoryMemory } from '@renderer/features/project/storyMemory'
import { useResearchStore } from '@renderer/features/research/researchStore'
import { takeDropped } from '@renderer/features/notebook/droppedEntries'
import { useNotesSortStore } from '@renderer/features/notebook/notesSortStore'
import { archivedNow, useIsArchived } from '@renderer/features/shell/archived'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useLibraryStore } from './libraryStore'

/** Whether a drag carries files from outside the app (a text drag inside the editor does not). */
const carriesFiles = (event: DragEvent): boolean =>
  event.dataTransfer?.types.includes('Files') === true

/** Whether the drag is over the Notes section, which takes its own file drops (`NotesTab`). */
const overNotes = (event: DragEvent): boolean =>
  event.target instanceof Element && event.target.closest('[data-notebook-drop]') !== null

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
      // Over the Notes section its own drop hint shows instead of the overlay.
      setOver(!overNotes(event))
    }
    const onLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOver(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      depth = 0
      // Notes redesign phase 1: a drop on the Notes section makes note pages there instead.
      if (overNotes(event)) {
        setOver(false)
        return
      }
      event.preventDefault()
      event.stopPropagation()
      depth = 0
      setOver(false)
      // Notes redesign (fresh start): with the old story bible archived there is no Library to
      // add to; the files become note pages at the top of Notes, as a drop on Notes would.
      if (archivedNow('storyBible') && event.dataTransfer !== null) {
        const read = takeDropped(event.dataTransfer)
        // Notes structure B: asked first how they come in, as a drop on Notes is.
        read()
          .then((files) => useNotesSortStore.getState().askImport(files, null))
          .catch((err: unknown) => toast.error(describeError(err)))
        return
      }
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
  // Notes redesign (fresh start): with the old story bible archived, a drop makes note pages.
  const notes = useIsArchived('storyBible')
  const Icon = notes ? NotebookPen : research ? NotebookText : Library
  const title = notes
    ? 'Drop to add to Notes'
    : research
      ? 'Drop to add to Research'
      : 'Drop to add to the Library'
  const detail = notes
    ? 'Worldbuilding documents and notes (Word, Markdown, text, PDF), each as a page you can edit.'
    : research
      ? 'Worldbuilding documents, notes, maps, and art, each as a page you can read and edit.'
      : 'Worldbuilding documents, character notes, maps, and art. You review before anything lands.'
  return (
    <div
      data-testid="library-drop-overlay"
      className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-overlay"
    >
      <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-accent bg-surface-raised px-10 py-8 text-center shadow-panel">
        <Icon size={28} aria-hidden="true" className="text-accent" />
        <p className="m-0 text-base font-semibold">{title}</p>
        <p className="m-0 text-sm text-fg-muted">{detail}</p>
      </div>
    </div>
  )
}
