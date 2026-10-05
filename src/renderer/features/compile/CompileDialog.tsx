import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { DOMSerializer, Node as PmNode, type Schema } from '@tiptap/pm/model'
import type { CompiledEntry, CompiledManuscript } from '@shared/compile'
import type { NovelFormat } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { COLUMN, editorStyle } from '@renderer/features/editor/column'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { manuscriptSchema } from '@renderer/features/editor/extensions'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useEditorSettings } from '@renderer/features/editor/settingsStore'
import { StatsFrame } from '@renderer/features/stats/StatsFrame'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { compiledBlocks, type Block } from '@shared/compiledBlocks'

interface CompileDialogProps {
  format: NovelFormat
  onClose: () => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; manuscript: CompiledManuscript }

/**
 * The compiled preview (F-3.12): the whole manuscript read top to bottom, read-only, in the
 * project's editor formatting. Drafts (document text and scene metadata) are flushed first so
 * the stored rows main reads are current. Shell dialog `compile`, from View › Compiled preview.
 */
export function CompileDialog({ format, onClose }: CompileDialogProps): React.JSX.Element {
  const settings = useEditorSettings(format)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [details, setDetails] = useState(true)
  const detailsId = useId()
  const schema = useMemo(() => manuscriptSchema(settings.sceneBreak), [settings.sceneBreak])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      // A failed save is reported by the autosave itself; the stored text is still worth showing.
      await Promise.all([
        useDocumentStore
          .getState()
          .flush()
          .catch(() => undefined),
        useSceneMetaStore
          .getState()
          .flush()
          .catch(() => undefined)
      ])
      const manuscript = await ipc().invoke('manuscript:compile', undefined)
      if (!cancelled) setState({ status: 'ready', manuscript })
    }
    load().catch((err: unknown) => {
      if (!cancelled) setState({ status: 'error', message: describeError(err) })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const blocks = useMemo(
    () => (state.status === 'ready' ? compiledBlocks(state.manuscript.entries, details) : []),
    [state, details]
  )

  let body: ReactNode
  if (state.status === 'loading') body = <p className="m-0 text-xs text-fg-muted">Loading…</p>
  else if (state.status === 'error')
    body = (
      <p role="alert" className="m-0 text-sm text-danger">
        {state.message}
      </p>
    )
  else if (blocks.length === 0)
    body = <p className="m-0 text-sm text-fg-muted">Nothing to compile yet.</p>
  else
    body = (
      <article
        data-testid="compile-preview"
        aria-label="Compiled manuscript"
        className="ms-editor ms-preview min-h-0 flex-1 overflow-y-auto rounded-md border border-line bg-surface py-4"
        style={editorStyle(settings)}
      >
        <div className={COLUMN}>
          {blocks.map((block) => (
            <CompiledBlock
              key={block.kind === 'break' ? block.key : `${block.kind}-${block.entry.id}`}
              block={block}
              schema={schema}
              sceneBreak={settings.sceneBreak}
            />
          ))}
        </div>
      </article>
    )

  return (
    <StatsFrame
      title="Compiled preview"
      widthClassName="h-[90vh] w-[min(1000px,94vw)]"
      onClose={onClose}
    >
      <div className="flex items-center gap-2 text-sm">
        <input
          id={detailsId}
          type="checkbox"
          checked={details}
          onChange={(event) => setDetails(event.target.checked)}
        />
        <label htmlFor={detailsId}>Scene details</label>
      </div>
      {body}
    </StatsFrame>
  )
}

function CompiledBlock({
  block,
  schema,
  sceneBreak
}: {
  block: Block
  schema: Schema
  sceneBreak: string
}): React.JSX.Element {
  switch (block.kind) {
    case 'heading':
      return block.level === 'part' ? (
        <h1 data-testid="compile-heading" data-level="part" className="text-center">
          {block.entry.title}
        </h1>
      ) : (
        <h2 data-testid="compile-heading" data-level="chapter">
          {block.entry.title}
        </h2>
      )
    case 'meta':
      return <SceneHeader entry={block.entry} />
    case 'break':
      return (
        <div
          data-testid="compile-scene-break"
          role="separator"
          aria-label="Scene break"
          className="scene-break"
        >
          {sceneBreak}
        </div>
      )
    case 'text':
      return <CompiledText content={block.content} schema={schema} />
  }
}

/** A scene's metadata header: Location, Time, POV (each only when set), then its tags as chips. */
function SceneHeader({ entry }: { entry: CompiledEntry }): React.JSX.Element {
  const fields = entry.meta
    ? [
        { label: 'Location', value: entry.meta.location },
        { label: 'Time', value: entry.meta.timeline },
        { label: 'POV', value: entry.meta.pov }
      ].filter((field) => field.value !== '')
    : []
  return (
    <div
      data-testid="compile-scene-meta"
      className="mt-4 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-ui text-xs text-fg-muted"
    >
      {fields.map((field) => (
        <span key={field.label}>
          <span className="font-medium text-fg-subtle">{field.label}:</span> {field.value}
        </span>
      ))}
      {entry.tags.length > 0 ? (
        <ul aria-label="Tags" className="m-0 flex list-none flex-wrap gap-1 p-0">
          {entry.tags.map((tag) => (
            <li
              key={tag.id}
              className="flex items-center gap-1.5 rounded-full border border-line bg-surface-raised px-2 py-0.5"
            >
              <span
                aria-hidden="true"
                style={{ backgroundColor: tag.color }}
                className="size-2.5 shrink-0 rounded-full"
              />
              <span className="max-w-48 truncate">{tag.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * A stored document rendered through the editor schema's own DOM output, so it reads exactly as
 * in the editor (scene breaks, inline tags painted from the bank, provenance) without an editor
 * and without `innerHTML`. A document the schema refuses renders as nothing.
 */
function CompiledText({
  content,
  schema
}: {
  content: TiptapNodeT
  schema: Schema
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = ref.current
    if (!target) return
    try {
      const doc = PmNode.fromJSON(schema, content)
      target.replaceChildren(
        DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document })
      )
    } catch {
      target.replaceChildren()
    }
  }, [content, schema])
  return <div ref={ref} data-testid="compile-text" />
}
