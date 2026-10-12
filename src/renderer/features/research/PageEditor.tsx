import { useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useCanWrite } from '@renderer/features/account/appAccessStore'
import { buildPageExtensions, EDITOR_CORE_OPTIONS } from '@renderer/features/editor/extensions'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { pageKey, usePageStore, type PageOwner } from './pageStore'
import { selectionNotCanon } from './researchView'

/** Pages are not the manuscript, so a scene break on one is fixed rather than following the format. */
const PAGE_SCENE_BREAK = '* * *'

export interface PageEditorProps {
  owner: PageOwner
  /** The editor's accessible name ("Research page", "Pinned"…). */
  label: string
  /** What an empty page says. */
  placeholder: string
  /**
   * A page inside a longer view (a sheet's Pinned and Ideas, F-16.6): it grows with its text and
   * scrolls with the view, instead of filling the pane and scrolling on its own.
   */
  inline?: boolean
  /**
   * Whether the toolbar offers Not canon (default true). Off for a record's Ideas page, which is
   * never canon whatever its marks (answer 3), so the page has no toolbar at all.
   */
  notCanonToggle?: boolean
}

/**
 * One page of story memory v2 (F-16.6, F-16.8; plan P1 §2.3): the `NotesEditor` pattern over the
 * page store. It loads its owner's page on mount (and again when the owner changes) and unloads on
 * unmount, which saves any pending edit. The schema is the page schema (`buildPageExtensions`),
 * so a paragraph can be marked Not canon and carries its AI marks until the author edits it. The
 * toolbar holds only the Not canon toggle (none on Ideas); the StarterKit shortcuts apply, and
 * Ctrl+S saves.
 */
export function PageEditor({
  owner,
  label,
  placeholder,
  inline = false,
  notCanonToggle = true
}: PageEditorProps): React.JSX.Element {
  const key = pageKey(owner)
  const content = usePageStore((s) => s.docs[key]?.content ?? null)
  const load = usePageStore((s) => s.load)
  const unload = usePageStore((s) => s.unload)

  useEffect(() => {
    load(key).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(key)
  }, [key, load, unload])

  return (
    <PageInstance
      key={`${key}:${content === null ? 'loading' : 'ready'}`}
      pageKey={key}
      content={content}
      label={label}
      placeholder={placeholder}
      inline={inline}
      notCanonToggle={notCanonToggle}
    />
  )
}

/**
 * One editor instance for one loaded page; `content === null` is the read-only loading state.
 * Built with the loaded content, so loading never enters the undo history.
 */
function PageInstance({
  pageKey: key,
  content,
  label,
  placeholder,
  inline,
  notCanonToggle
}: {
  pageKey: string
  content: TiptapNodeT | null
  label: string
  placeholder: string
  inline: boolean
  notCanonToggle: boolean
}): React.JSX.Element {
  const edit = usePageStore((s) => s.edit)
  const extensions = useMemo(
    () => [
      ...buildPageExtensions({
        sceneBreak: PAGE_SCENE_BREAK,
        onSave: () => void usePageStore.getState().saveNow(),
        // F-16.9: a filed Pinned line names the Research page it came from.
        filedTitle: (docId) => useTreeStore.getState().byId[docId]?.title ?? null
      }),
      Placeholder.configure({ placeholder })
    ],
    [placeholder]
  )
  const ready = content !== null
  // The toggle follows the caret; a re-render per selection change is all it costs.
  const [notCanon, setNotCanon] = useState(false)

  const editor = useEditor(
    {
      extensions,
      coreExtensionOptions: EDITOR_CORE_OPTIONS,
      content: content ?? EMPTY_DOC,
      editable: ready,
      editorProps: {
        attributes: {
          class: inline ? 'ms-editor ms-page ms-page-inline' : 'ms-editor ms-page',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': label
        }
      },
      onUpdate: ({ editor: updated }) => edit(key, updated.getJSON()),
      onTransaction: ({ editor: updated }) => setNotCanon(selectionNotCanon(updated))
    },
    [extensions]
  )
  // AI-BILLING-SPEC M1: read-only after the trial without the license, like the manuscript.
  const writable = useCanWrite()
  const editable = ready && writable
  useEffect(() => {
    if (!editor.isDestroyed && editor.isEditable !== editable) editor.setEditable(editable, false)
  }, [editor, editable])

  return (
    <div className={inline ? 'flex flex-col' : 'flex min-h-0 flex-1 flex-col'}>
      {notCanonToggle ? (
        <div
          role="toolbar"
          aria-label={inline ? `${label} page` : 'Page'}
          className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1 text-xs"
        >
          <button
            type="button"
            aria-pressed={notCanon}
            disabled={!editable}
            title="Mark the paragraphs the selection touches as Not canon: ideas and maybes, never treated as true"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleNotCanon().run()}
            className="rounded-md px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-50 aria-pressed:bg-surface-raised aria-pressed:text-fg"
          >
            Not canon
          </button>
        </div>
      ) : null}
      {inline ? (
        <div className="py-2 pr-3 pl-20">
          <EditorContent editor={editor} className="flex flex-col" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-4 pl-24">
            <EditorContent editor={editor} className="flex min-h-0 flex-1 flex-col" />
          </div>
        </div>
      )}
    </div>
  )
}
