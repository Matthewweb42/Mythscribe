import { useEffect, useMemo } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { defaultEditorSettings } from '@shared/editorSettings'
import type { NovelFormat } from '@shared/ipc/contract'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'
import { Toolbar } from './Toolbar'

/**
 * The writing surface for one document (F-3.1): toolbar plus the Tiptap editor. Loads the
 * document through `useDocumentStore` when `id` changes. Every document gets its own editor
 * instance, created with the loaded content, so the undo history holds only the author's edits
 * to that document: loading never lands on the stack and undo can never walk into the previous
 * document. While the load is in flight a read-only, empty editor keeps the layout and the toolbar
 * is disabled. Every edit goes to the store, which autosaves it (F-3.2); Ctrl+S saves at once.
 */
export function EditorPane({ id, format }: { id: string; format: NovelFormat }): React.JSX.Element {
  const content = useDocumentStore((s) => (s.id === id ? s.content : null))
  const load = useDocumentStore((s) => s.load)
  const sceneBreak = defaultEditorSettings(format).sceneBreak

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
  }, [id, load])

  return (
    <DocumentEditor
      key={`${id}:${content === null ? 'loading' : 'ready'}`}
      content={content}
      sceneBreak={sceneBreak}
    />
  )
}

/** One editor instance for one loaded document; `content === null` is the read-only loading state. */
function DocumentEditor({
  content,
  sceneBreak
}: {
  content: TiptapNodeT | null
  sceneBreak: string
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
          class: 'ms-editor',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Document'
        }
      },
      onUpdate: ({ editor }) => edit(editor.getJSON())
    },
    [extensions]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar editor={ready ? editor : null} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EditorContent editor={editor} className="mx-auto max-w-[700px] px-6 py-6" />
      </div>
    </div>
  )
}
