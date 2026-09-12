import { useEffect, useMemo } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { buildExtensions } from './extensions'
import { useNotesStore } from './notesStore'

/** Notes are not a manuscript, so the scene-break text is fixed rather than following the format. */
const NOTES_SCENE_BREAK = '* * *'

/**
 * The notes of one document or folder (F-3.7): loads them through `useNotesStore` on mount (and
 * again when `id` changes) and unloads on unmount, which saves any pending edit under its own
 * id. Host-agnostic on purpose: it takes only the id, so the side panel here and the floating
 * panel in focus mode (F-6.6) edit the same notes through the same store. Same document schema
 * as the manuscript, with no toolbar: the StarterKit keyboard shortcuts apply, and Ctrl+S saves.
 */
export function NotesEditor({ id }: { id: string }): React.JSX.Element {
  const content = useNotesStore((s) => s.docs[id]?.content ?? null)
  const load = useNotesStore((s) => s.load)
  const unload = useNotesStore((s) => s.unload)

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(id)
  }, [id, load, unload])

  return (
    <NotesInstance
      key={`${id}:${content === null ? 'loading' : 'ready'}`}
      id={id}
      content={content}
    />
  )
}

/**
 * One editor instance for one loaded notes record; `content === null` is the read-only loading
 * state. Like `DocumentEditor`, the instance is built with the loaded content so loading never
 * enters the undo history.
 */
function NotesInstance({
  id,
  content
}: {
  id: string
  content: TiptapNodeT | null
}): React.JSX.Element {
  const edit = useNotesStore((s) => s.edit)
  const extensions = useMemo(
    () =>
      buildExtensions({
        sceneBreak: NOTES_SCENE_BREAK,
        onSave: () => void useNotesStore.getState().saveNow()
      }),
    []
  )
  const ready = content !== null

  const editor = useEditor(
    {
      extensions,
      content: content ?? EMPTY_DOC,
      editable: ready,
      editorProps: {
        attributes: {
          class: 'ms-editor ms-notes',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Notes'
        }
      },
      onUpdate: ({ editor }) => edit(id, editor.getJSON())
    },
    [extensions]
  )

  return <EditorContent editor={editor} />
}
