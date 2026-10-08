import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { ChevronDown, ChevronUp, GripVertical, X } from 'lucide-react'
import { docToText } from '@shared/docText'
import {
  IMPORT_PLACEMENTS,
  IMPORT_PLACEMENT_LABEL,
  IMPORT_TITLE_MAX,
  ImportPlacement,
  draftSummary,
  existingChanges,
  sceneFirstLine,
  sceneWords,
  type ExistingChanges,
  type ImportAiMarks,
  type ImportChapter,
  type ImportDraft,
  type ImportPart,
  type ImportScene,
  type ImportSummary
} from '@shared/import'
import { NovelFormat, PROJECT_NAME_MAX } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { AI_WAIT_CLASS } from '@renderer/features/ai/aiWaitPhrases'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import { PROJECT_FORMATS } from '@renderer/features/project/formats'
import { chapterIds, findNode, sceneIds, type DropZone } from './draftEdits'
import { useImportStore, type DetectState } from './importStore'

/** `N word` / `N words`, with the thousands separators the tree shows. */
const count = (n: number, singular: string): string =>
  `${n.toLocaleString()} ${n === 1 ? singular : `${singular}s`}`

/** What the author is about to create, as the header's one line. */
function summaryLine(summary: ImportSummary): string {
  const parts = [
    count(summary.parts, 'part'),
    count(summary.chapters, 'chapter'),
    count(summary.scenes, 'scene'),
    count(summary.words, 'word')
  ]
  if (summary.matter > 0) parts.push(`${count(summary.matter, 'matter document')}`)
  return parts.join(' · ')
}

/**
 * What Import does to the project's own nodes beyond moving and renaming them, spelled out
 * before anything is written (the author's rule: never silent). Empty when nothing goes.
 */
function existingLine(changes: ExistingChanges): string {
  const lines: string[] = []
  if (changes.deletedScenes.length > 0) {
    lines.push(`${count(changes.deletedScenes.length, 'existing scene')} will be deleted`)
  }
  if (changes.mergedScenes.length > 0) {
    lines.push(
      `${count(changes.mergedScenes.length, 'existing scene')} merged into another (the text is kept; their tags and notes are not)`
    )
  }
  if (changes.deletedChapters.length > 0) {
    lines.push(`${count(changes.deletedChapters.length, 'existing chapter')} will be deleted`)
  }
  if (changes.deletedParts.length > 0) {
    lines.push(`${count(changes.deletedParts.length, 'existing part')} will be deleted`)
  }
  return lines.join(' · ')
}

/** One paragraph of a scene as the review pane shows it; empty paragraphs read as a blank line. */
const paragraphText = (node: TiptapNodeT): string => docToText({ type: 'doc', content: [node] })

const ACTION =
  'shrink-0 rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'
const ICON_ACTION =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded border border-line text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'
const INDENT = ['pl-2', 'pl-6', 'pl-10'] as const
const FIELD = 'rounded border border-line bg-bg px-2 py-1 text-sm text-fg'

/** True while the AI pass runs: every edit in the tree is refused until it answers. */
const useDetectRunning = (): boolean => useImportStore((s) => s.detect?.status === 'running')

type RowKind = 'part' | 'chapter' | 'scene'

/** The level a row of `kind` can be dropped into (`into`), if any. */
const PARENT_KIND: Record<RowKind, RowKind | null> = {
  part: null,
  chapter: 'part',
  scene: 'chapter'
}

/** The drag in progress: the row being dragged and, once a row would take it, where it lands. */
interface DragState {
  id: string
  kind: RowKind
  over: { id: string; zone: DropZone } | null
}

/** What every row needs to take part in a drag (F-12.2: reorder and move by drag and drop). */
interface DragProps {
  drag: DragState | null
  onStart: (id: string, kind: RowKind, event: DragEvent<HTMLDivElement>) => void
  onOver: (id: string, kind: RowKind, event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onEnd: () => void
}

/**
 * The import review dialog (F-12.2): main's structure draft as an outline of parts, chapters,
 * and scenes — with, when the project already has a manuscript, the project's own nodes in the
 * same outline so the author sorts both together (imported rows are marked New). Everything
 * the author needs is on the row: click a title to rename it, drag a row (or Move up / Move
 * down) to reorder it or move a scene into another chapter, Merge with next, Split…, × to
 * delete; tick rows (Shift for a range) to merge them into one scene or delete them together.
 * Undo steps back. Import writes the outline as it stands, after the line above the buttons has
 * said what happens to existing nodes; Cancel drops it. The dialog holds review edits that
 * exist nowhere else, so a backdrop click does *not* close it (Escape and Cancel do).
 */
export function ImportDialog(): React.JSX.Element | null {
  const draft = useImportStore((s) => s.draft)
  if (!draft) return null
  return <ImportReview draft={draft} />
}

function ImportReview({ draft }: { draft: ImportDraft }): React.JSX.Element {
  const titleId = useId()
  const busy = useImportStore((s) => s.busy)
  const running = useDetectRunning()
  const sceneId = useImportStore((s) => s.sceneId)
  const target = useImportStore((s) => s.target)
  const canUndo = useImportStore((s) => s.history.length > 0)
  const cancel = useImportStore((s) => s.cancel)
  const commit = useImportStore((s) => s.commit)
  const undo = useImportStore((s) => s.undo)
  const moveTo = useImportStore((s) => s.moveTo)
  const panel = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  useEffect(() => {
    panel.current?.focus()
  }, [])

  // These walk every paragraph, so they are computed once per draft rather than once per render.
  const summary = useMemo(() => draftSummary(draft), [draft])
  const changes = useMemo(() => existingLine(existingChanges(draft)), [draft])
  const words = useMemo(() => wordMap(draft), [draft])
  const order = useMemo(() => ({ scenes: sceneIds(draft), chapters: chapterIds(draft) }), [draft])
  // Into a project with a manuscript the outline mixes both, so the imported rows say so.
  const mixed = draft.existing !== undefined

  const selected = sceneId === null ? null : findNode(draft, sceneId)
  const scene = selected?.kind === 'scene' ? selected.scene : null
  const nothingToImport = summary.scenes + summary.matter === 0 && changes.length === 0

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
      return
    }
    // Undo in the outline; a text field keeps its own Ctrl+Z.
    const typing =
      (event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') ||
      event.target instanceof HTMLSelectElement
    if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      undo()
    }
  }

  const dragProps: DragProps = {
    drag,
    onStart(id, kind, event) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', id)
      setDrag({ id, kind, over: null })
    },
    onOver(id, kind, event) {
      if (drag === null || drag.id === id) return
      let zone: DropZone | null = null
      if (kind === drag.kind) {
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0
        zone = ratio < 0.5 ? 'before' : 'after'
      } else if (PARENT_KIND[drag.kind] === kind) {
        zone = 'into'
      }
      if (zone === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (drag.over?.id !== id || drag.over.zone !== zone) setDrag({ ...drag, over: { id, zone } })
    },
    onDrop(event) {
      event.preventDefault()
      if (drag?.over) moveTo(drag.id, drag.over.id, drag.over.zone)
      setDrag(null)
    },
    onEnd() {
      setDrag(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="import-dialog"
        onKeyDown={onKeyDown}
        className="flex h-[85vh] w-[1100px] max-w-[95vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel outline-none"
      >
        <div className="shrink-0 border-b border-line px-5 pt-4 pb-3">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Import “{draft.source.name}”
          </h2>
          {target === 'new' ? <NewProjectFields /> : null}
          <p className="mt-1 mb-0 text-sm text-fg-muted" data-testid="import-question">
            Does this look right? Click a title to rename it, drag rows to reorder them, tick rows
            to merge or delete them.
          </p>
          <p className="mt-1 mb-0 text-xs text-fg-subtle" data-testid="import-summary">
            {summaryLine(summary)}
          </p>
        </div>
        <DetectPanel />
        <SelectionBar />
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            <ul className="m-0 flex list-none flex-col p-0">
              {draft.parts.map((part, partIndex) => (
                <li key={part.id} className="m-0 list-none p-0">
                  <PartRow
                    part={part}
                    words={words[part.id] ?? 0}
                    mixed={mixed}
                    canUp={partIndex > 0}
                    canDown={partIndex < draft.parts.length - 1}
                    dragProps={dragProps}
                  />
                  <ul className="m-0 flex list-none flex-col p-0">
                    {part.chapters.map((chapter) => {
                      const at = order.chapters.indexOf(chapter.id)
                      return (
                        <li key={chapter.id} className="m-0 list-none p-0">
                          <ChapterRow
                            chapter={chapter}
                            words={words[chapter.id] ?? 0}
                            mixed={mixed}
                            canUp={at > 0}
                            canDown={at < order.chapters.length - 1}
                            dragProps={dragProps}
                          />
                          <ul className="m-0 flex list-none flex-col p-0">
                            {chapter.scenes.map((sc) => {
                              const index = order.scenes.indexOf(sc.id)
                              return (
                                <li key={sc.id} className="m-0 list-none p-0">
                                  <SceneRow
                                    scene={sc}
                                    words={words[sc.id] ?? 0}
                                    mixed={mixed}
                                    active={sc.id === sceneId}
                                    canUp={index > 0}
                                    canDown={index < order.scenes.length - 1}
                                    dragProps={dragProps}
                                  />
                                </li>
                              )
                            })}
                          </ul>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-h-0 w-[300px] shrink-0 overflow-y-auto border-l border-line px-4 py-3">
            {scene ? (
              <>
                <h3 className="m-0 text-sm font-semibold">{scene.title}</h3>
                <p className="mt-0.5 mb-2 text-xs text-fg-subtle">
                  {count(scene.paragraphs.length, 'paragraph')} · split before any of them
                </p>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {scene.paragraphs.map((paragraph, index) => (
                    <li key={`${scene.id}-${index}`} className="m-0 list-none p-0">
                      {index > 0 ? (
                        <button
                          type="button"
                          data-testid="import-split"
                          disabled={running}
                          aria-label={`Split before paragraph ${index + 1}`}
                          onClick={() => useImportStore.getState().splitScene(scene.id, index)}
                          className="my-1 w-full rounded border border-dashed border-line py-0.5 text-[11px] text-fg-subtle hover:border-accent hover:text-fg disabled:opacity-40"
                        >
                          Split here
                        </button>
                      ) : null}
                      <p className="m-0 text-xs text-fg-muted">{paragraphText(paragraph)}</p>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="m-0 text-xs text-fg-subtle">
                Choose Split… on a scene to read its paragraphs and cut it in two.
              </p>
            )}
          </div>
        </div>
        {changes.length > 0 ? (
          <p
            role="note"
            data-testid="import-existing"
            className="m-0 shrink-0 border-t border-line bg-surface px-5 py-2 text-xs text-warning"
          >
            {`In your project: ${changes}.`}
          </p>
        ) : null}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            data-testid="import-undo"
            disabled={!canUndo || running}
            onClick={undo}
            className="mr-auto rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-40"
          >
            Undo
          </button>
          <button
            type="button"
            data-testid="import-cancel"
            onClick={cancel}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="import-commit"
            disabled={busy || running || nothingToImport}
            onClick={() => void commit()}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? 'Importing…' : target === 'new' ? 'Create project' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Import to start (F-12.2): the new project's name and format, above the outline. */
function NewProjectFields(): React.JSX.Element {
  const nameId = useId()
  const formatId = useId()
  const name = useImportStore((s) => s.projectName)
  const format = useImportStore((s) => s.projectFormat)
  const setName = useImportStore((s) => s.setProjectName)
  const setFormat = useImportStore((s) => s.setProjectFormat)
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
      <label htmlFor={nameId} className="text-fg-muted">
        Project name
      </label>
      <input
        id={nameId}
        data-testid="import-project-name"
        value={name}
        maxLength={PROJECT_NAME_MAX}
        onChange={(event) => setName(event.target.value)}
        className={`${FIELD} min-w-48 flex-1`}
      />
      <label htmlFor={formatId} className="text-fg-muted">
        Format
      </label>
      <select
        id={formatId}
        data-testid="import-project-format"
        value={format}
        onChange={(event) => {
          const chosen = NovelFormat.safeParse(event.target.value)
          if (chosen.success) setFormat(chosen.data)
        }}
        className={FIELD}
      >
        {PROJECT_FORMATS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** The ticked rows and what can be done with them together; absent while nothing is ticked. */
function SelectionBar(): React.JSX.Element | null {
  const draft = useImportStore((s) => s.draft)
  const selected = useImportStore((s) => s.selected)
  const running = useDetectRunning()
  const mergeSelected = useImportStore((s) => s.mergeSelected)
  const removeSelected = useImportStore((s) => s.removeSelected)
  const clearSelection = useImportStore((s) => s.clearSelection)
  if (draft === null || selected.length === 0) return null
  const kinds = new Set(selected.map((id) => findNode(draft, id)?.kind))
  const only = kinds.size === 1 ? [...kinds][0] : undefined
  const mergeLabel = only === 'chapter' ? 'Merge into one chapter' : 'Merge into one scene'
  const canMerge = selected.length >= 2 && (only === 'scene' || only === 'chapter')
  return (
    <div
      data-testid="import-selection"
      className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-5 py-2 text-xs"
    >
      <span className="text-fg-muted">{`${selected.length.toLocaleString()} selected`}</span>
      <span className="flex-1" />
      <button
        type="button"
        data-testid="import-merge-selected"
        disabled={!canMerge || running}
        title={canMerge ? undefined : 'Tick two or more scenes (or two or more chapters)'}
        onClick={mergeSelected}
        className={ACTION}
      >
        {mergeLabel}
      </button>
      <button
        type="button"
        data-testid="import-delete-selected"
        disabled={running}
        onClick={removeSelected}
        className={ACTION}
      >
        Delete selected
      </button>
      <button type="button" onClick={clearSelection} className={ACTION}>
        Clear selection
      </button>
    </div>
  )
}

interface RowProps {
  id: string
  kind: RowKind
  title: string
  depth: 0 | 1 | 2
  /** True for a node already in the project; false for imported text. */
  existing: boolean
  /** True when the outline mixes existing and imported rows, so the imported ones are badged. */
  mixed: boolean
  words: number
  preview?: string
  /** A count shown instead of a preview (a chapter's scenes). */
  detail?: string
  /** The scene whose paragraphs the right pane shows. */
  active?: boolean
  /** Chapters and scenes can be ticked for the selection bar; parts cannot. */
  selectable: boolean
  /** What the AI pass (F-12.3) did to this node, if anything: the row badges it and offers Reject. */
  ai?: ImportAiMarks
  dragProps: DragProps
  canUp: boolean
  canDown: boolean
  /** Actions between the move buttons and the delete button. */
  children?: ReactNode
}

/** One line of the outline: tick, grip, title (click to rename), badges, preview, words, actions, ×. */
function Row({
  id,
  kind,
  title,
  depth,
  existing,
  mixed,
  words,
  preview,
  detail,
  active,
  selectable,
  ai,
  dragProps,
  canUp,
  canDown,
  children
}: RowProps): React.JSX.Element {
  const renaming = useImportStore((s) => s.renamingId === id)
  const ticked = useImportStore((s) => s.selected.includes(id))
  const running = useDetectRunning()
  const startRename = useImportStore((s) => s.startRename)
  const toggleSelect = useImportStore((s) => s.toggleSelect)
  const remove = useImportStore((s) => s.remove)
  const move = useImportStore((s) => s.move)
  const reject = useImportStore((s) => s.rejectSuggestion)
  const { drag } = dragProps
  const zone = drag?.over?.id === id ? drag.over.zone : null

  return (
    <div
      data-testid="import-node"
      data-import-id={id}
      data-import-kind={kind}
      data-import-new={existing ? undefined : 'true'}
      data-drop={zone ?? undefined}
      draggable={!renaming && !running}
      onDragStart={(event) => dragProps.onStart(id, kind, event)}
      onDragOver={(event) => dragProps.onOver(id, kind, event)}
      onDrop={dragProps.onDrop}
      onDragEnd={dragProps.onEnd}
      className={`flex items-center gap-2 py-0.5 pr-3 text-sm ${INDENT[depth]} ${
        active || ticked ? 'bg-accent/10' : 'hover:bg-surface'
      } ${drag?.id === id ? 'opacity-50' : ''} ${zone === 'into' ? 'ring-2 ring-accent ring-inset' : ''} ${
        zone === 'before' ? 'border-t-2 border-accent' : ''
      } ${zone === 'after' ? 'border-b-2 border-accent' : ''}`}
    >
      {selectable ? (
        <input
          type="checkbox"
          data-testid="import-select"
          disabled={running}
          aria-label={`Select ${kind} ${title}`}
          checked={ticked}
          onChange={(event) => {
            const native = event.nativeEvent
            toggleSelect(id, native instanceof MouseEvent && native.shiftKey)
          }}
        />
      ) : (
        <span aria-hidden="true" className="w-[13px] shrink-0" />
      )}
      <GripVertical size={12} aria-hidden="true" className="shrink-0 cursor-grab text-fg-subtle" />
      {renaming ? (
        <RenameInput id={id} title={title} />
      ) : (
        <button
          type="button"
          title="Rename"
          disabled={running}
          onClick={() => startRename(id)}
          // The title keeps at least 6rem (up to 14rem) and the preview gives way first.
          className={`min-w-24 max-w-56 shrink truncate rounded px-1 text-left hover:bg-surface-raised disabled:hover:bg-transparent ${
            depth === 2 ? '' : 'font-medium'
          }`}
        >
          {title}
        </button>
      )}
      {mixed && !existing ? (
        <span
          data-testid="import-new-badge"
          className="shrink-0 rounded border border-line px-1 text-[10px] font-medium text-fg-muted"
        >
          New
        </span>
      ) : null}
      {ai && (ai.break || ai.title) ? (
        <span
          data-testid="import-ai-badge"
          title={ai.reason ?? undefined}
          className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1 text-[10px] font-medium text-accent"
        >
          AI
        </span>
      ) : null}
      {preview ? (
        <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{preview}</span>
      ) : detail ? (
        <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{detail}</span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{words.toLocaleString()}</span>
      <button
        type="button"
        disabled={!canUp || running}
        aria-label={`Move ${title} up`}
        onClick={() => move(id, -1)}
        className={ICON_ACTION}
      >
        <ChevronUp size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        disabled={!canDown || running}
        aria-label={`Move ${title} down`}
        onClick={() => move(id, 1)}
        className={ICON_ACTION}
      >
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {children}
      {ai?.break === true ? (
        <button
          type="button"
          data-testid="import-reject"
          disabled={running}
          aria-label={`Reject the ${kind} the AI added, ${title}`}
          onClick={() => reject(id)}
          className={ACTION}
        >
          Reject
        </button>
      ) : null}
      <button
        type="button"
        data-testid="import-delete"
        disabled={running}
        aria-label={`Delete ${kind} ${title}`}
        title={existing ? 'Delete (removes it from your project at Import)' : 'Delete'}
        onClick={() => remove(id)}
        className={ICON_ACTION}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  )
}

function PartRow({
  part,
  words,
  mixed,
  canUp,
  canDown,
  dragProps
}: {
  part: ImportPart
  words: number
  mixed: boolean
  canUp: boolean
  canDown: boolean
  dragProps: DragProps
}): React.JSX.Element {
  return (
    <Row
      id={part.id}
      kind="part"
      title={part.title}
      depth={0}
      existing={part.existing === true}
      mixed={mixed}
      words={words}
      detail={count(part.chapters.length, 'chapter')}
      selectable={false}
      dragProps={dragProps}
      canUp={canUp}
      canDown={canDown}
    />
  )
}

/** The chapter's own row: placement (imported chapters only) and Merge with next. */
function ChapterRow({
  chapter,
  words,
  mixed,
  canUp,
  canDown,
  dragProps
}: {
  chapter: ImportChapter
  words: number
  mixed: boolean
  canUp: boolean
  canDown: boolean
  dragProps: DragProps
}): React.JSX.Element {
  const setPlacement = useImportStore((s) => s.setPlacement)
  const mergeWithNext = useImportStore((s) => s.mergeWithNext)
  const running = useDetectRunning()
  const existing = chapter.existing === true
  return (
    <Row
      id={chapter.id}
      kind="chapter"
      title={chapter.title}
      depth={1}
      existing={existing}
      mixed={mixed}
      words={words}
      detail={count(chapter.scenes.length, 'scene')}
      selectable
      ai={chapter.ai}
      dragProps={dragProps}
      canUp={canUp}
      canDown={canDown}
    >
      {existing ? null : (
        <select
          data-testid="import-placement"
          aria-label={`Placement for ${chapter.title}`}
          value={chapter.placement}
          disabled={running}
          onChange={(event) => setPlacement(chapter.id, ImportPlacement.parse(event.target.value))}
          className="shrink-0 rounded border border-line bg-bg px-1 py-0.5 text-xs text-fg disabled:opacity-40"
        >
          {IMPORT_PLACEMENTS.map((placement) => (
            <option key={placement} value={placement}>
              {IMPORT_PLACEMENT_LABEL[placement]}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        data-testid="import-merge-next"
        disabled={!canDown || running}
        aria-label={`Merge ${chapter.title} with the next chapter`}
        onClick={() => mergeWithNext(chapter.id)}
        className={ACTION}
      >
        Merge ↓
      </button>
    </Row>
  )
}

/** A scene's row: its first line, Merge with next, and Split… (which opens the paragraph pane). */
function SceneRow({
  scene,
  words,
  mixed,
  active,
  canUp,
  canDown,
  dragProps
}: {
  scene: ImportScene
  words: number
  mixed: boolean
  active: boolean
  canUp: boolean
  canDown: boolean
  dragProps: DragProps
}): React.JSX.Element {
  const mergeWithNext = useImportStore((s) => s.mergeWithNext)
  const selectScene = useImportStore((s) => s.selectScene)
  const running = useDetectRunning()
  return (
    <Row
      id={scene.id}
      kind="scene"
      title={scene.title}
      depth={2}
      existing={scene.existing === true}
      mixed={mixed}
      words={words}
      preview={sceneFirstLine(scene)}
      active={active}
      selectable
      ai={scene.ai}
      dragProps={dragProps}
      canUp={canUp}
      canDown={canDown}
    >
      <button
        type="button"
        data-testid="import-merge-next"
        disabled={!canDown || running}
        aria-label={`Merge ${scene.title} with the next scene`}
        onClick={() => mergeWithNext(scene.id)}
        className={ACTION}
      >
        Merge ↓
      </button>
      <button
        type="button"
        disabled={scene.paragraphs.length < 2 || running}
        aria-label={`Split ${scene.title}`}
        onClick={() => selectScene(scene.id)}
        className={ACTION}
      >
        Split…
      </button>
    </Row>
  )
}

/** Inline rename, like the tree's (F-2.2): Enter and blur commit, Escape leaves the title alone. */
function RenameInput({ id, title }: { id: string; title: string }): React.JSX.Element {
  const rename = useImportStore((s) => s.rename)
  const endRename = useImportStore((s) => s.endRename)
  // Enter and Escape both unmount the input, which can fire one last blur; skip it.
  const settled = useRef(false)

  const commit = (value: string): void => {
    if (settled.current) return
    settled.current = true
    rename(id, value)
  }

  return (
    <input
      data-testid="import-rename"
      aria-label={`Rename ${title}`}
      defaultValue={title}
      autoFocus
      maxLength={IMPORT_TITLE_MAX}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          commit(event.currentTarget.value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (settled.current) return
          settled.current = true
          endRename()
        }
      }}
      className="min-w-0 shrink rounded border border-line bg-bg px-1 text-sm"
    />
  )
}

const DETECT_BUTTON =
  'shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60'

/** The estimate before anything is sent: dollars when the fast model is priced, tokens when not. */
function estimateLine(detect: DetectState): string {
  const chunks = formatCount(detect.estimate.chunks, 'chunk')
  return detect.estimate.priced
    ? `≈ ${formatUsd(detect.estimate.costUsd)} (${formatCount(detect.words, 'word')}, ${chunks})`
    : `≈ ${formatCount(detect.estimate.tokensIn)} tokens in (${chunks})`
}

/** What the finished pass really cost, against the estimate, and what it changed (CLAUDE.md rule 10). */
function outcomeLine(detect: DetectState): string {
  const outcome = detect.outcome
  if (outcome === null) return ''
  const estimated = detect.estimate.priced
    ? ` (estimate ${formatUsd(detect.estimate.costUsd)})`
    : ''
  const changed = `${formatCount(outcome.added, 'break')} added, ${formatCount(outcome.titled, 'scene')} titled`
  return `AI pass cost ${formatUsd(outcome.costUsd)}${estimated} · ${changed}`
}

/**
 * The AI structure pass (F-12.3) above the tree: the offer with what it would cost before
 * anything is sent, the chunk-by-chunk progress with Stop while it runs, and afterwards one
 * line saying what it spent and what it changed. Absent when the dial or the toggle keeps the
 * feature off, when the draft has nothing to send, and once the author keeps the draft as it is.
 */
function DetectPanel(): React.JSX.Element | null {
  const detect = useImportStore((s) => s.detect)
  const startDetect = useImportStore((s) => s.startDetect)
  const skipDetect = useImportStore((s) => s.skipDetect)
  const cancelDetect = useImportStore((s) => s.cancelDetect)
  if (detect === null || detect.status === 'skipped') return null

  const total = detect.progress?.total ?? detect.estimate.chunks
  const done = Math.min((detect.progress?.done ?? 0) + 1, Math.max(total, 1))

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-5 py-2 text-xs">
      {detect.status === 'offer' || detect.status === 'failed' ? (
        <>
          {detect.status === 'offer' ? (
            <>
              <span className="text-fg-muted">Let the AI check the chapters and scenes?</span>
              <span data-testid="import-detect-estimate" className="text-fg-subtle tabular-nums">
                {estimateLine(detect)}
              </span>
            </>
          ) : (
            <span data-testid="import-detect-error" className="text-danger">
              {`${detect.error?.message ?? ''} ${detect.error?.nextStep ?? ''}`.trim()}
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            data-testid="import-detect"
            onClick={() => void startDetect()}
            className={DETECT_BUTTON}
          >
            {detect.status === 'offer' ? 'Detect structure' : 'Try again'}
          </button>
          {detect.status === 'offer' ? (
            <button
              type="button"
              data-testid="import-detect-skip"
              onClick={skipDetect}
              className={ACTION}
            >
              Keep this draft
            </button>
          ) : null}
        </>
      ) : null}

      {detect.status === 'running' ? (
        <>
          <span data-testid="import-detect-progress" className={AI_WAIT_CLASS}>
            {`Checking chunk ${done} of ${total} · ${formatUsd(detect.progress?.costUsd ?? 0)} so far`}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="import-detect-cancel"
            onClick={cancelDetect}
            className={ACTION}
          >
            Stop
          </button>
        </>
      ) : null}

      {detect.status === 'done' ? (
        <span data-testid="import-detect-cost" className="text-fg-muted">
          {outcomeLine(detect)}
        </span>
      ) : null}
    </div>
  )
}

/** Words per node id: every scene counted once, chapters and parts as the sum below them. */
function wordMap(draft: ImportDraft): Record<string, number> {
  const words: Record<string, number> = {}
  for (const part of draft.parts) {
    let partWords = 0
    for (const chapter of part.chapters) {
      let chapterWords = 0
      for (const scene of chapter.scenes) {
        const own = sceneWords(scene)
        words[scene.id] = own
        chapterWords += own
      }
      words[chapter.id] = chapterWords
      partWords += chapterWords
    }
    words[part.id] = partWords
  }
  return words
}
