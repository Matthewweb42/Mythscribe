import { useEffect, useMemo } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { defaultEditorSettings } from '@shared/editorSettings'
import type { NovelFormat } from '@shared/ipc/contract'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'
import { Toolbar } from './Toolbar'

export interface DocumentEditorProps {
  id: string
  format: NovelFormat
  /**
   * Own toolbar and scroll container (the single-document pane, F-3.1), or bare content for a
   * region in a stack whose toolbar and scrolling belong to the stack (F-3.8).
   */
  toolbar?: boolean
  /** Fires when the editor gains focus, so a stack can point its shared toolbar at this region. */
  onFocus?: (editor: Editor) => void
}

/**
 * The writing surface for one document: loads it through `useDocumentStore` on mount (and again
 * when `id` changes) and unloads it on unmount, which saves any pending edit under its own id.
 * Every document gets its own editor instance, created with the loaded content, so the undo
 * history holds only the author's edits to that document: loading never lands on the stack and
 * undo can never walk into another document. While the load is in flight a read-only, empty
 * editor keeps the layout and the toolbar is disabled. Every edit goes to the store, which
 * autosaves it (F-3.2); Ctrl+S saves everything pending at once.
 */
export function DocumentEditor({
  id,
  format,
  toolbar = true,
  onFocus
}: DocumentEditorProps): React.JSX.Element {
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  const load = useDocumentStore((s) => s.load)
  const unload = useDocumentStore((s) => s.unload)
  const sceneBreak = defaultEditorSettings(format).sceneBreak

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(id)
  }, [id, load, unload])

  return (
    <RegionEditor
      key={`${id}:${content === null ? 'loading' : 'ready'}`}
      id={id}
      content={content}
      sceneBreak={sceneBreak}
      toolbar={toolbar}
      onFocus={onFocus}
    />
  )
}

/** One editor instance for one loaded document; `content === null` is the read-only loading state. */
function RegionEditor({
  id,
  content,
  sceneBreak,
  toolbar,
  onFocus
}: {
  id: string
  content: TiptapNodeT | null
  sceneBreak: string
  toolbar: boolean
  onFocus: ((editor: Editor) => void) | undefined
}): React.JSX.Element {
  const edit = useDocumentStore((s) => s.edit)
  const extensions = useMemo(
    () => buildExtensions({ sceneBreak, onSave: () => void useDocumentStore.getState().saveNow() }),
    [sceneBreak]
  )
  const ready = content !== null

  const editor = useEditor(
    {
      extensions,
      content: content ?? EMPTY_DOC,
      editable: ready,
      editorProps: {
        attributes: {
          class: toolbar ? 'ms-editor' : 'ms-editor ms-editor-region',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Document'
        }
      },
      onUpdate: ({ editor }) => edit(id, editor.getJSON()),
      // `useEditor` reads the latest `onFocus` on every call, so a changed callback is honoured.
      onFocus: ({ editor }) => onFocus?.(editor)
    },
    [extensions]
  )

  const body = <EditorContent editor={editor} className="mx-auto max-w-[700px] px-6 py-6" />
  if (!toolbar) return body
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar editor={ready ? editor : null} />
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  )
}
