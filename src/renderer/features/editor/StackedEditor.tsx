import { Fragment, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Editor } from '@tiptap/core'
import type { NovelFormat } from '@shared/ipc/contract'
import { levelLabel, type SectionType } from '@shared/labels'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { descendantDocuments, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useEditorZoom, usePageEdges } from '@renderer/features/shell/viewStore'
import { describeError } from '@renderer/lib/errors'
import { COLUMN, columnClass, editorStyle } from './column'
import { DocumentEditor } from './DocumentEditor'
import { useDocumentStore } from './documentStore'
import { FocusModeButton } from './FocusModeButton'
import { NotesToggleButton } from './NotesPanel'
import { useScrollMemory } from './scrollMemory'
import { useEditorSettings } from './settingsStore'
import { StatusBar } from './StatusBar'
import { Toolbar } from './Toolbar'

/** The region that last gained focus: the shared toolbar's target. */
interface ActiveRegion {
  id: string
  editor: Editor
}
const ADD_BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface-raised disabled:opacity-50 disabled:hover:bg-transparent'

/**
 * Every document under a folder, stacked in tree order as its own editable region (F-3.8,
 * F-2.5). Regions are keyed by document id, so two scenes with the same title never share an
 * editor or a save; each region loads and saves through `useDocumentStore` under its own id.
 * One toolbar serves the stack and targets the region that last gained focus; Ctrl+S anywhere
 * saves every pending region. The separator between regions follows the folder's section: the
 * format's scene-break text (F-3.6) inside the manuscript, a thin page-break line in front and
 * end matter. An empty folder invites the author to add the first document. The status bar
 * shows the folder's combined saved count (F-3.3), so it follows each region's autosave; no
 * session delta, because a folder's rollup also moves when scenes are moved or deleted. The
 * folder's own tags and metadata live in the tags and notes columns. Focus mode (F-6.1) drops
 * the toolbar. F-1.7: the stack's scroll is kept in the session under the folder's id and put
 * back once every region has its text.
 */
export function StackedEditor({
  folderId,
  format
}: {
  folderId: string
  format: NovelFormat
}): React.JSX.Element {
  const docIds = useTreeStore(useShallow((s) => descendantDocuments(s, folderId)))
  const section = useTreeStore((s) => s.sectionOf[folderId] ?? 'manuscript')
  const focus = useFocusStore((s) => s.active)
  const [active, setActive] = useState<ActiveRegion | null>(null)
  const words = useTreeStore((s) => s.wordCountRollup[folderId] ?? 0)
  const settings = useEditorSettings(format)
  // F-7.10: the stack is a writing surface too, so it takes the app-wide document zoom.
  const zoom = useEditorZoom()
  // F-7.11: each region is a sheet on the desk; focus mode keeps the plain stack (F-6.4).
  const sheet = usePageEdges() && !focus
  const scroller = useRef<HTMLDivElement>(null)
  const loaded = useDocumentStore((s) => docIds.every((d) => (s.docs[d]?.content ?? null) !== null))
  useScrollMemory(scroller, folderId, loaded && docIds.length > 0)
  // A region that leaves the stack (deleted, moved out) takes its editor with it; the toolbar
  // must not keep pointing at it. Membership is decided here, at render, because Tiptap destroys
  // an unmounted editor on a timer, so `isDestroyed` alone would lag behind.
  const editor =
    active !== null && docIds.includes(active.id) && !active.editor.isDestroyed
      ? active.editor
      : null

  if (docIds.length === 0)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EmptyFolder folderId={folderId} format={format} section={section} />
      </div>
    )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={editorStyle(settings, zoom)}>
      {focus ? null : (
        <Toolbar
          editor={editor}
          right={
            <>
              <NotesToggleButton />
              <FocusModeButton />
            </>
          }
        />
      )}
      <div
        ref={scroller}
        className={`min-h-0 flex-1 overflow-y-auto pb-12 ${sheet ? 'bg-page px-4' : ''}`}
      >
        {docIds.map((id, index) => (
          <Fragment key={id}>
            {index > 0 ? (
              <RegionSeparator sceneBreak={settings.sceneBreak} section={section} />
            ) : null}
            <Region id={id} format={format} sheet={sheet} onFocus={setActive} />
          </Fragment>
        ))}
      </div>
      <StatusBar words={words} />
    </div>
  )
}

/**
 * One document of the stack: a muted title (not part of the document) above its editor. The
 * section is the column, so with the page edges on (F-7.11) the title and the text share one
 * sheet, set off from its neighbours; the separators between regions stay on the desk.
 */
function Region({
  id,
  format,
  sheet,
  onFocus
}: {
  id: string
  format: NovelFormat
  sheet: boolean
  onFocus: (region: ActiveRegion) => void
}): React.JSX.Element {
  const title = useTreeStore((s) => s.byId[id]?.title ?? '')
  return (
    <section aria-label={title} className={`${columnClass(sheet)} ${sheet ? 'my-6' : ''}`}>
      <h2 className="m-0 pt-6 text-sm font-medium text-fg-muted">{title}</h2>
      <DocumentEditor
        id={id}
        format={format}
        toolbar={false}
        onFocus={(editor) => onFocus({ id, editor })}
      />
    </section>
  )
}

/** Between manuscript scenes: the scene-break text, static. Between matter documents: a page-break line. */
function RegionSeparator({
  sceneBreak,
  section
}: {
  sceneBreak: string
  section: SectionType
}): React.JSX.Element {
  if (section === 'manuscript') {
    return (
      <div
        role="separator"
        aria-label="Scene break"
        className={`${COLUMN} py-2 text-center tracking-[0.25em] text-fg-muted select-none`}
      >
        {sceneBreak}
      </div>
    )
  }
  return <hr aria-label="Page break" className={`${COLUMN} my-4 border-line`} />
}

/**
 * The invitation for a folder with no documents. In the manuscript the button adds a scene where
 * `resolveCreateTarget` puts it (an empty part or the root takes the scene itself, flexible
 * nesting, so every manuscript folder has a scene target). Front and end matter get a generic document. The cork board (F-11.1)
 * shows the same invitation for a folder with no children.
 */
export function EmptyFolder({
  folderId,
  format,
  section
}: {
  folderId: string
  format: NovelFormat
  section: SectionType
}): React.JSX.Element {
  const busy = useTreeStore((s) => s.busy)
  const createLevel = useTreeStore((s) => s.createLevel)
  const createGeneric = useTreeStore((s) => s.createGeneric)
  const manuscript = section === 'manuscript'
  const scene = levelLabel(format, 'scene').toLowerCase()

  const onAdd = async (): Promise<void> => {
    try {
      const keep = { keepSelection: true }
      if (manuscript) await createLevel('scene', folderId, keep)
      else await createGeneric('document', folderId, keep)
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  const message = manuscript
    ? `Nothing here yet. Add a ${scene} to start writing.`
    : 'Nothing here yet. Add a document to start writing.'

  return (
    <div className={`${COLUMN} flex flex-col items-start gap-3 py-6`}>
      <p className="m-0 text-sm text-fg-muted">{message}</p>
      <button type="button" disabled={busy} onClick={() => void onAdd()} className={ADD_BUTTON}>
        {manuscript ? `Add a ${scene}` : 'Add a document'}
      </button>
    </div>
  )
}
