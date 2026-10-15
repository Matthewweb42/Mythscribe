import { useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import { Sparkles, X } from 'lucide-react'
import { docToText } from '@shared/docText'
import { NOTEBOOK_TITLE_MAX } from '@shared/notebook'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useCanWrite } from '@renderer/features/account/appAccessStore'
import { buildExtensions, EDITOR_CORE_OPTIONS } from '@renderer/features/editor/extensions'
import { useViewStore } from '@renderer/features/shell/viewStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { changedLines } from './notebookChanges'
import { useNotebookPageStore } from './notebookPageStore'
import { useNotebookStore } from './notebookStore'

/** Note pages are not the manuscript, so a scene break on one is fixed rather than following the format. */
const PAGE_SCENE_BREAK = '* * *'

const BUTTON =
  'rounded-md px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-50'

const failed = (err: unknown): void => {
  toast.error(describeError(err))
}

/**
 * A note page in the main pane (notes redesign phase 1, slice 1): its title, editable; the bar
 * for Ms Scribe's edit the author has not seen (Show changes, Undo); and the page in the
 * manuscript's editor schema without the manuscript's own tools (no ghost text, tags, find,
 * rewrite or tracked changes), saved as the author types.
 */
export function NotebookPageView({ id }: { id: string }): React.JSX.Element {
  const title = useNotebookStore((s) => s.byId[id]?.title ?? '')
  const aiEdit = useNotebookStore((s) => (s.aiEdit?.pageId === id ? s.aiEdit : null))
  const showChanges = useNotebookStore((s) => s.showChanges)
  const content = useNotebookPageStore((s) => s.docs[id]?.content ?? null)
  const load = useNotebookPageStore((s) => s.load)
  const unload = useNotebookPageStore((s) => s.unload)

  useEffect(() => {
    load(id).catch(failed)
    return () => unload(id)
  }, [id, load, unload])

  return (
    <section
      aria-label="Note page"
      data-testid="notebook-page"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <TitleField key={`${id}:${title}`} id={id} title={title} />
      </header>
      {aiEdit !== null ? <AiEditBar showing={showChanges} /> : null}
      {aiEdit !== null && showChanges && content !== null ? (
        <ChangesView before={aiEdit.before} after={content} />
      ) : null}
      <PageInstance
        key={`${id}:${content === null ? 'loading' : 'ready'}`}
        id={id}
        content={content}
      />
    </section>
  )
}

/** The page's title: committed on Enter or when it loses focus; Escape puts it back. */
function TitleField({ id, title }: { id: string; title: string }): React.JSX.Element {
  const [draft, setDraft] = useState(title)
  const writable = useCanWrite()
  const commit = (): void => {
    const next = draft.trim()
    if (next === '' || next === title) {
      setDraft(title)
      return
    }
    useNotebookStore.getState().rename(id, next).catch(failed)
  }
  return (
    <input
      type="text"
      aria-label="Page title"
      value={draft}
      maxLength={NOTEBOOK_TITLE_MAX}
      disabled={!writable}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          setDraft(title)
        }
      }}
      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-base font-medium text-fg outline-none hover:border-line focus:border-accent"
    />
  )
}

/** "Ms Scribe edited this page · Show changes · Undo", with ✕ to put it away. */
function AiEditBar({ showing }: { showing: boolean }): React.JSX.Element {
  const assistant = useViewStore((s) => s.assistantName)
  const writable = useCanWrite()
  const store = useNotebookStore.getState
  return (
    <div
      role="status"
      data-testid="notebook-ai-edit"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-1.5 text-xs"
    >
      <Sparkles size={12} aria-hidden="true" className="text-accent" />
      <span>{`${assistant} edited this page`}</span>
      <span aria-hidden="true" className="text-fg-subtle">
        ·
      </span>
      <button
        type="button"
        aria-pressed={showing}
        onClick={() => store().setShowChanges(!showing)}
        className={BUTTON}
      >
        {showing ? 'Hide changes' : 'Show changes'}
      </button>
      <span aria-hidden="true" className="text-fg-subtle">
        ·
      </span>
      <button
        type="button"
        disabled={!writable}
        title="Put the page back as it was before this edit"
        onClick={() => {
          store().undoAiEdit().catch(failed)
        }}
        className={BUTTON}
      >
        Undo
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => store().dismissAiEdit()}
        className="ml-auto rounded p-0.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  )
}

/** The page's lines now, the ones Ms Scribe changed highlighted with her words marked. */
function ChangesView({
  before,
  after
}: {
  before: TiptapNodeT | null
  after: TiptapNodeT
}): React.JSX.Element {
  const lines = useMemo(
    () => changedLines(docToText(before ?? EMPTY_DOC), docToText(after)),
    [before, after]
  )
  return (
    <div
      data-testid="notebook-changes"
      aria-label="Changes"
      role="region"
      className="max-h-64 shrink-0 overflow-y-auto border-b border-line px-4 py-2"
    >
      <div className="rewrite-diff mx-auto flex max-w-3xl flex-col gap-1 text-sm">
        {lines.map((line, index) => (
          <p
            key={index}
            data-changed={line.changed ? 'true' : undefined}
            className={`m-0 rounded px-1 whitespace-pre-wrap ${line.changed ? 'bg-accent/15' : 'text-fg-muted'}`}
          >
            {line.pieces.map((piece, at) =>
              piece.op === 'del' ? (
                <del key={at}>{piece.text}</del>
              ) : piece.op === 'add' ? (
                <ins key={at}>{piece.text}</ins>
              ) : (
                <span key={at}>{piece.text}</span>
              )
            )}
          </p>
        ))}
      </div>
    </div>
  )
}

/**
 * One editor for one loaded page; `content === null` is the read-only loading state. Built with
 * the loaded content, so loading never enters the undo history; a reload (Undo, Ms Scribe's edit)
 * builds a new one.
 */
function PageInstance({
  id,
  content
}: {
  id: string
  content: TiptapNodeT | null
}): React.JSX.Element {
  const edit = useNotebookPageStore((s) => s.edit)
  const extensions = useMemo(
    () => [
      ...buildExtensions({
        sceneBreak: PAGE_SCENE_BREAK,
        onSave: () => void useNotebookPageStore.getState().saveNow()
      }),
      Placeholder.configure({ placeholder: 'Write a note…' })
    ],
    []
  )
  const ready = content !== null
  const editor = useEditor(
    {
      extensions,
      coreExtensionOptions: EDITOR_CORE_OPTIONS,
      content: content ?? EMPTY_DOC,
      editable: ready,
      editorProps: {
        attributes: {
          class: 'ms-editor ms-page',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Note page'
        }
      },
      onUpdate: ({ editor: updated }) => edit(id, updated.getJSON())
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-4 pl-24">
        <EditorContent editor={editor} className="flex min-h-0 flex-1 flex-col" />
      </div>
    </div>
  )
}
