import { Fragment, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Editor } from '@tiptap/core'
import { defaultEditorSettings } from '@shared/editorSettings'
import type { NovelFormat } from '@shared/ipc/contract'
import { levelLabel, type SectionType } from '@shared/labels'
import { resolveCreateTarget } from '@renderer/features/manuscript/placement'
import { descendantDocuments, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { DocumentEditor } from './DocumentEditor'
import { Toolbar } from './Toolbar'

const COLUMN = 'mx-auto max-w-[700px] px-6'

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
 * end matter. An empty folder invites the author to add the first document.
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
  const [active, setActive] = useState<ActiveRegion | null>(null)
  // A region that leaves the stack (deleted, moved out) takes its editor with it; the toolbar
  // must not keep pointing at it. Membership is decided here, at render, because Tiptap destroys
  // an unmounted editor on a timer, so `isDestroyed` alone would lag behind.
  const editor =
    active !== null && docIds.includes(active.id) && !active.editor.isDestroyed
      ? active.editor
      : null

  if (docIds.length === 0)
    return <EmptyFolder folderId={folderId} format={format} section={section} />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar editor={editor} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-12">
        {docIds.map((id, index) => (
          <Fragment key={id}>
            {index > 0 ? <RegionSeparator format={format} section={section} /> : null}
            <Region id={id} format={format} onFocus={setActive} />
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/** One document of the stack: a muted title (not part of the document) above its editor. */
function Region({
  id,
  format,
  onFocus
}: {
  id: string
  format: NovelFormat
  onFocus: (region: ActiveRegion) => void
}): React.JSX.Element {
  const title = useTreeStore((s) => s.byId[id]?.title ?? '')
  return (
    <section aria-label={title}>
      <h2 className={`${COLUMN} m-0 pt-6 text-sm font-medium text-fg-muted`}>{title}</h2>
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
  format,
  section
}: {
  format: NovelFormat
  section: SectionType
}): React.JSX.Element {
  if (section === 'manuscript') {
    return (
      <div
        role="separator"
        aria-label="Scene break"
        className={`${COLUMN} py-2 text-center tracking-[0.25em] text-fg-muted select-none`}
      >
        {defaultEditorSettings(format).sceneBreak}
      </div>
    )
  }
  return <hr aria-label="Page break" className={`${COLUMN} my-4 border-line`} />
}

/**
 * The invitation for a folder with no documents. In the manuscript the button adds a scene where
 * `resolveCreateTarget` puts it; an empty part has no scene target (a chapter must come first),
 * so it gets the text only. Front and end matter get a generic document.
 */
function EmptyFolder({
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
  const canAddScene = useTreeStore((s) => resolveCreateTarget(s, folderId, 'scene') !== null)
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
    ? canAddScene
      ? `Nothing here yet. Add a ${scene} to start writing.`
      : `Nothing here yet. Add a ${levelLabel(format, 'chapter').toLowerCase()} first, then a ${scene}.`
    : 'Nothing here yet. Add a document to start writing.'

  return (
    <div className={`${COLUMN} flex flex-col items-start gap-3 py-6`}>
      <p className="m-0 text-sm text-fg-muted">{message}</p>
      {manuscript && !canAddScene ? null : (
        <button type="button" disabled={busy} onClick={() => void onAdd()} className={ADD_BUTTON}>
          {manuscript ? `Add a ${scene}` : 'Add a document'}
        </button>
      )}
    </div>
  )
}
