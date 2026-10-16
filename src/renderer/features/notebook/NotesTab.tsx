import { useState } from 'react'
import {
  ChevronRight,
  FilePlus,
  FolderPlus,
  LayoutTemplate,
  RefreshCw,
  Upload,
  type LucideIcon
} from 'lucide-react'
import { isFeatureAllowed } from '@shared/aiSettings'
import { useCanWrite } from '@renderer/features/account/appAccessStore'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { openNotesUpdateHere } from '@renderer/features/editFlow/editFlowStore'
import { useStoryMemory } from '@renderer/features/project/storyMemory'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { describeError } from '@renderer/lib/errors'
import { takeDropped } from './droppedEntries'
import { NotebookTemplateMenu } from './NotebookTemplateMenu'
import { NotebookTree } from './NotebookTree'
import { useNotebookStore } from './notebookStore'
import { useNotesSortStore } from './notesSortStore'

const BUTTON =
  'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'

const carriesFiles = (event: React.DragEvent): boolean => event.dataTransfer.types.includes('Files')

const failed = (err: unknown): void => {
  toast.error(describeError(err))
}

/** A sidebar section shown under Notes (the fresh start: Outline, Timeline). */
export interface NotesView {
  id: string
  label: string
  icon: LucideIcon
}

interface NotesTabProps {
  /** The large folders at the top of the tree; each opens in the Notes panel. None outside the fresh start. */
  views?: readonly NotesView[]
}

/**
 * The Notes section of the sidebar (notes redesign phase 1, slice 1): New page, New folder, New
 * from template (note templates, phase 6) and Import files… above the notebook's tree. Files and
 * folders dropped on the section become pages (a folder keeps its folders), in the folder under
 * the pointer, or beside the page under it, or at the top level. Notes redesign phase 3: Update notes… opens the edit flow pre-filled with
 * Update notes on the open scene's chapter (the book when no scene is open), while the edit flow
 * can run (v1, Use AI on). Structure A (2026-10-16, the author's layout): in the fresh start Outline
 * and Timeline sit at the top of the tree as two large folders; one opens its section, which the
 * sidebar shows under the Notes tab with a back row (Edits is a tab of its own). Structure B (2026-10-16): a drop or a pick
 * asks first how the files come in (`NotesImportDialog`).
 */
export function NotesTab({ views = [] }: NotesTabProps): React.JSX.Element {
  const busy = useNotebookStore((s) => s.busy)
  const writable = useCanWrite()
  const [dropping, setDropping] = useState(false)
  const [templateMenu, setTemplateMenu] = useState<{ x: number; y: number } | null>(null)
  const memory = useStoryMemory()
  const canUpdate = useAiSettingsStore(
    (s) => memory === 'v1' && s.settings !== null && isFeatureAllowed(s.settings, 'editFlow')
  )

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    setDropping(false)
    const read = takeDropped(event.dataTransfer)
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-notebook-id]')?.dataset.notebookId
        : undefined
    const store = useNotebookStore.getState()
    const item = row === undefined ? undefined : store.byId[row]
    const parentId = item === undefined ? null : item.kind === 'folder' ? item.id : item.parentId
    if (!writable) return
    // Structure B: how the files come in is asked first (one page each, split, or sorted).
    read()
      .then((files) => useNotesSortStore.getState().askImport(files, parentId))
      .catch(failed)
  }

  return (
    <div
      data-notebook-drop="true"
      data-dropping={dropping ? 'true' : undefined}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setDropping(false)
        }
      }}
      onDrop={onDrop}
      className={`flex min-h-0 flex-1 flex-col ${dropping ? 'ring-2 ring-accent ring-inset' : ''}`}
    >
      <div
        role="toolbar"
        aria-label="Notes"
        className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1 text-xs"
      >
        <button
          type="button"
          disabled={!writable}
          onClick={() => {
            useNotebookStore.getState().create('page').catch(failed)
          }}
          className={BUTTON}
        >
          <FilePlus size={12} aria-hidden="true" />
          New page
        </button>
        <button
          type="button"
          disabled={!writable}
          onClick={() => {
            useNotebookStore.getState().create('folder').catch(failed)
          }}
          className={BUTTON}
        >
          <FolderPlus size={12} aria-hidden="true" />
          New folder
        </button>
        <button
          type="button"
          disabled={!writable}
          aria-haspopup="menu"
          title="A page laid out for a character, a place, a style guide…, or one of your own templates"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setTemplateMenu((open) => (open ? null : { x: rect.left, y: rect.bottom }))
          }}
          className={BUTTON}
        >
          <LayoutTemplate size={12} aria-hidden="true" />
          New from template
        </button>
        <button
          type="button"
          disabled={!writable || busy}
          title="Word, Markdown, text and PDF files: one page each, split at headings, or sorted"
          onClick={() => {
            useNotesSortStore.getState().askImport().catch(failed)
          }}
          className={BUTTON}
        >
          <Upload size={12} aria-hidden="true" />
          Import files…
        </button>
        {canUpdate ? (
          <button
            type="button"
            data-testid="notes-update"
            disabled={!writable}
            title="Update your notes from the open scene's chapter (or the whole book), priced before Run"
            onClick={openNotesUpdateHere}
            className={BUTTON}
          >
            <RefreshCw size={12} aria-hidden="true" />
            Update notes…
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {views.length > 0 ? (
          <div role="group" aria-label="Views" className="border-b border-line py-1">
            {views.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => useLayoutStore.getState().setSidebarTab(id)}
                className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-[15px] font-medium hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
              >
                <Icon size={18} aria-hidden="true" className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <ChevronRight size={15} aria-hidden="true" className="shrink-0 text-fg-muted" />
              </button>
            ))}
          </div>
        ) : null}
        <NotebookTree />
      </div>
      {templateMenu !== null ? (
        <NotebookTemplateMenu
          x={templateMenu.x}
          y={templateMenu.y}
          onClose={() => setTemplateMenu(null)}
        />
      ) : null}
    </div>
  )
}
