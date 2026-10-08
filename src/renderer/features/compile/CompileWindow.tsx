import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { ExportProgress } from '@shared/bookExport'
import {
  BUILTIN_COMPILE_FORMATS,
  COMPILE_FORMAT_NAME_MAX,
  COMPILE_OUTPUT_LABELS,
  COMPILE_OUTPUTS,
  type CompileFormat,
  formatNameTaken,
  isBuiltinFormatId,
  type CompileOutput
} from '@shared/compileFormat'
import { compileBook, type CompiledBook } from '@shared/compileModel'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useOpenDocument } from '@renderer/features/manuscript/useOpenDocument'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { BookDetailsDialog } from './BookDetailsDialog'
import { useBookDetailsStore } from './bookDetailsStore'
import {
  chapterGroups,
  COMPILE_TABS,
  formatProblem,
  resolveScope,
  type CompileTabId
} from './compileContents'
import { CompilePreview } from './CompilePreview'
import { useCompileWindowStore } from './compileWindowStore'
import { ContentsTab } from './ContentsTab'
import { HINT } from './fields'
import {
  HeadersFootersTab,
  MatterTab,
  MetadataTab,
  PageSetupTab,
  ReplacementsTab,
  SectionLayoutsTab,
  TypographyTab
} from './FormatTabs'

const BUTTON =
  'rounded-md border border-line px-3 py-1 text-sm hover:bg-surface disabled:opacity-50'

/** What the progress line says for the step main last reported (or the start of a run). */
function stageLabel(progress: ExportProgress | null): string {
  if (progress === null || progress.stage === 'collect') return 'Collecting…'
  if (progress.stage === 'render') return 'Rendering…'
  return 'Writing file…'
}

/**
 * File › Compile… (Compile v2, CV3; File › Export… opens it too), shell dialog `compileWindow`:
 * the format list on the left (built-in, then My formats: duplicate, rename, save, revert,
 * delete), the format's settings in tabs in the middle, the live page preview on the right, and
 * the output and Compile at the top. Built-in formats are read-only; duplicate one to change it.
 * The window keeps nothing itself: the compile window store owns the choices and the shown
 * format, so closing and reopening the window finds them as they were.
 */
export function CompileWindow({ onClose }: { onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const outputId = useId()
  const panelId = useId()
  const [tab, setTab] = useState<CompileTabId>('contents')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const store = useCompileWindowStore()
  const details = useBookDetailsStore((s) => s.details)
  const projectName = useProjectStore((s) => s.current?.name ?? '')
  const openDoc = useOpenDocument()
  const byId = useTreeStore((s) => s.byId)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const rootIds = useTreeStore((s) => s.rootIds)

  useEffect(() => {
    void useCompileWindowStore.getState().open()
    useBookDetailsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [])

  const builtin = isBuiltinFormatId(store.formatId)
  const draft = store.draft
  const output: CompileOutput = store.output ?? draft.defaultOutput
  const problem = formatProblem(draft)
  const running = store.status === 'running'

  const chapterSet = useMemo(
    () =>
      new Set(
        chapterGroups({ byId, childrenOf, rootIds }).flatMap((g) => g.chapters.map((c) => c.id))
      ),
    [byId, childrenOf, rootIds]
  )
  const openDocumentId = openDoc?.id ?? null
  const scope = useMemo(
    () =>
      resolveScope(store.scopeKind, store.chapterIds, { chapterIds: chapterSet, openDocumentId }),
    [store.scopeKind, store.chapterIds, chapterSet, openDocumentId]
  )

  const book: CompiledBook | null = useMemo(() => {
    if (store.source === null || details === null || problem !== null) return null
    return compileBook({
      source: store.source,
      format: draft,
      output,
      details,
      projectName,
      scope: scope ?? { kind: 'manuscript' },
      excluded: store.excluded
    })
  }, [store.source, details, problem, draft, output, projectName, scope, store.excluded])

  const confirmLeave = async (): Promise<boolean> =>
    !store.dirty ||
    dialogs.confirm({
      title: 'Discard changes?',
      message: `Your changes to "${draft.name}" are not saved.`,
      confirmLabel: 'Discard',
      danger: true
    })

  const onSelect = async (id: string): Promise<void> => {
    if (id === store.formatId) return
    if (!(await confirmLeave())) return
    store.selectFormat(id)
  }

  const run = (action: () => Promise<unknown>): void => {
    action().catch((err: unknown) => toast.error(describeError(err)))
  }

  const onRename = async (): Promise<void> => {
    const name = await dialogs.prompt({
      title: 'Rename format',
      initialValue: draft.name,
      confirmLabel: 'Rename',
      validate: (value) => {
        const trimmed = value.trim()
        if (trimmed === '') return 'Type a name'
        if (trimmed.length > COMPILE_FORMAT_NAME_MAX) return 'That name is too long'
        if (formatNameTaken(store.library, trimmed, store.formatId))
          return 'Another of your formats has that name'
        return null
      }
    })
    if (name === null) return
    await store.rename(name.trim())
  }

  const onDelete = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: 'Delete format?',
      message: `"${draft.name}" will be removed from My formats in every project.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (ok) await store.remove()
  }

  const onCompile = async (): Promise<void> => {
    if (scope === null) return
    if (await store.compile(scope)) onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !detailsOpen) {
      event.preventDefault()
      onClose()
    }
  }

  const edit = store.edit
  let panel: ReactNode
  switch (tab) {
    case 'contents':
      panel = <ContentsTab format={draft} edit={edit} readOnly={builtin} />
      break
    case 'layouts':
      panel = <SectionLayoutsTab format={draft} edit={edit} readOnly={builtin} />
      break
    case 'page':
      panel = <PageSetupTab format={draft} edit={edit} />
      break
    case 'headers':
      panel = <HeadersFootersTab format={draft} edit={edit} />
      break
    case 'typography':
      panel = <TypographyTab format={draft} edit={edit} />
      break
    case 'matter':
      panel = <MatterTab format={draft} edit={edit} />
      break
    case 'replacements':
      panel = <ReplacementsTab format={draft} edit={edit} />
      break
    case 'metadata':
      panel = <MetadataTab format={draft} edit={edit} />
      break
  }
  // Contents and Section layouts disable their own format fields (the rest stays usable).
  const ownReadOnly = tab === 'contents' || tab === 'layouts'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        data-testid="compile-window"
        className="flex h-[94vh] w-[96vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Compile
          </h2>
          <span className="flex items-center gap-1.5 text-sm">
            <label htmlFor={outputId}>Compile for</label>
            <select
              id={outputId}
              value={output}
              disabled={running}
              onChange={(event) => {
                const next = COMPILE_OUTPUTS.find((o) => o === event.target.value)
                if (next !== undefined) store.setOutput(next)
              }}
              className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
            >
              {COMPILE_OUTPUTS.map((o) => (
                <option key={o} value={o}>
                  {COMPILE_OUTPUT_LABELS[o]}
                </option>
              ))}
            </select>
          </span>
          <button type="button" className={BUTTON} onClick={() => setDetailsOpen(true)}>
            Book details…
          </button>
          <span className="flex-1" />
          <button
            type="button"
            disabled={running || problem !== null || scope === null || !store.ready}
            aria-busy={running}
            onClick={() => void onCompile()}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent"
          >
            Compile
          </button>
          <button
            type="button"
            aria-label="Close compile"
            title="Close"
            onClick={onClose}
            className="rounded-md p-1.5 text-fg-muted hover:bg-surface hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {running || store.status === 'error' || store.loadError !== null ? (
          <div className="flex flex-col gap-1 border-b border-line px-4 py-2 text-xs">
            {running ? (
              <>
                <progress
                  data-testid="compile-progress"
                  aria-label="Compile progress"
                  className="w-full"
                />
                <span className="text-fg-muted">{stageLabel(store.progress)}</span>
              </>
            ) : null}
            {store.status === 'error' && store.error !== null ? (
              <p role="alert" className="m-0 text-sm text-danger">
                {store.error}
              </p>
            ) : null}
            {store.loadError !== null ? (
              <p role="alert" className="m-0 text-sm text-danger">
                {store.loadError}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)]">
          <nav
            aria-label="Formats"
            className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-line p-3"
          >
            <FormatList
              title="Built-in"
              formats={BUILTIN_COMPILE_FORMATS}
              selectedId={store.formatId}
              onSelect={(id) => run(() => onSelect(id))}
            />
            <FormatList
              title="My formats"
              formats={store.library}
              selectedId={store.formatId}
              empty="None yet: duplicate a format to make one of your own."
              onSelect={(id) => run(() => onSelect(id))}
            />
          </nav>

          <div className="flex min-h-0 flex-col border-r border-line">
            <div className="flex flex-col gap-1.5 px-4 pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 data-testid="compile-format-name" className="m-0 text-sm font-semibold">
                  {draft.name}
                  {store.dirty ? ' (edited)' : ''}
                </h3>
                <span className="flex-1" />
                <button
                  type="button"
                  className={BUTTON}
                  disabled={running}
                  onClick={() => run(() => store.duplicate())}
                >
                  Duplicate
                </button>
                {!builtin ? (
                  <>
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={running}
                      onClick={() => run(onRename)}
                    >
                      Rename…
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={!store.dirty || problem !== null || running}
                      onClick={() => run(() => store.save())}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={!store.dirty || running}
                      onClick={() => store.revert()}
                    >
                      Revert
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={running}
                      onClick={() => run(onDelete)}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
              {draft.description ? <p className={HINT}>{draft.description}</p> : null}
              {builtin ? (
                <p className={HINT}>
                  Built-in formats are read-only. Duplicate this one to change it.
                </p>
              ) : null}
              {problem !== null ? (
                <p role="alert" className="m-0 text-xs text-danger">
                  {problem}
                </p>
              ) : null}
            </div>
            <div
              role="tablist"
              aria-label="Compile settings"
              className="mt-2 flex shrink-0 flex-wrap border-b border-line px-3"
            >
              {COMPILE_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`${panelId}-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={panelId}
                  onClick={() => setTab(t.id)}
                  className="border-b-2 border-transparent px-2.5 py-1.5 text-sm font-medium text-fg-muted hover:text-fg aria-selected:border-accent aria-selected:text-fg"
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id={panelId}
              aria-labelledby={`${panelId}-${tab}`}
              className="min-h-0 flex-1 overflow-y-auto p-4"
            >
              {ownReadOnly ? (
                panel
              ) : (
                <fieldset disabled={builtin} className="m-0 min-w-0 border-0 p-0">
                  {panel}
                </fieldset>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col p-3">
            <CompilePreview book={book} />
          </div>
        </div>
      </div>
      {detailsOpen ? <BookDetailsDialog onClose={() => setDetailsOpen(false)} /> : null}
    </div>
  )
}

function FormatList({
  title,
  formats,
  selectedId,
  empty,
  onSelect
}: {
  title: string
  formats: readonly CompileFormat[]
  selectedId: string
  empty?: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="m-0 text-xs font-semibold tracking-wide text-fg-muted uppercase">{title}</h3>
      {formats.length === 0 && empty !== undefined ? <p className={HINT}>{empty}</p> : null}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {formats.map((format) => (
          <li key={format.id} className="m-0 p-0">
            <button
              type="button"
              aria-pressed={format.id === selectedId}
              onClick={() => onSelect(format.id)}
              className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-surface aria-pressed:bg-surface aria-pressed:font-medium aria-pressed:text-fg"
            >
              {format.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
