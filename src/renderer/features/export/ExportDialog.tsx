import { useId, useMemo } from 'react'
import {
  defaultExportFormatting,
  EXPORT_FONT_SIZE_MAX,
  EXPORT_FONT_SIZE_MIN,
  EXPORT_FONTS,
  EXPORT_FORMAT_LABELS,
  EXPORT_FORMATS,
  EXPORT_LINE_SPACINGS,
  EXPORT_PAGE_SIZES,
  type ExportFont,
  type ExportFormatting,
  type ExportPageSize,
  type ExportProgress
} from '@shared/bookExport'
import type { NovelFormat } from '@shared/ipc/contract'
import { useEditorSettings } from '@renderer/features/editor/settingsStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useOpenDocument } from '@renderer/features/manuscript/useOpenDocument'
import { StatsFrame } from '@renderer/features/stats/StatsFrame'
import {
  buildExportOptions,
  chapterGroups,
  useExportStore,
  type ExportScopeKind
} from './exportStore'

const FIELD = 'rounded-md border border-line bg-bg px-2 py-1 text-sm disabled:opacity-50'
const FIELDSET = 'm-0 flex flex-col gap-1.5 border-0 p-0 text-sm'
const LEGEND = 'mb-1 p-0 text-sm font-semibold'
const OPTION = 'flex items-center gap-1.5'

const FONT_SIZES = Array.from(
  { length: EXPORT_FONT_SIZE_MAX - EXPORT_FONT_SIZE_MIN + 1 },
  (_, i) => EXPORT_FONT_SIZE_MIN + i
)
const SPACING_LABELS: Record<(typeof EXPORT_LINE_SPACINGS)[number], string> = {
  1: 'Single',
  1.5: '1.5',
  2: 'Double'
}
const FONT_LABELS: Record<ExportFont, string> = { serif: 'Serif', sans: 'Sans-serif' }
const PAGE_LABELS: Record<ExportPageSize, string> = { letter: 'Letter', a4: 'A4' }
const SCENE_BREAK_MAX = 20

/** What the progress bar says for the step main last reported (or the start of a run). */
function stageLabel(progress: ExportProgress | null): string {
  if (progress === null || progress.stage === 'collect') return 'Collecting…'
  if (progress.stage === 'render') return `Rendering ${progress.done} of ${progress.total}…`
  return 'Writing file…'
}

/**
 * File › Export… (F-12.1), shell dialog `export`: the format (PDF, DOCX, EPUB, Markdown), what
 * goes in (the whole manuscript, ticked chapters grouped under their parts, or the open
 * document), front and end matter, and the formatting; then Export, which shows main's progress
 * and closes on success (the toast names the file). The choices last for the session.
 */
export function ExportDialog({
  format: novelFormat,
  onClose
}: {
  format: NovelFormat
  onClose: () => void
}): React.JSX.Element {
  const settings = useEditorSettings(novelFormat)
  const openDoc = useOpenDocument()
  const byId = useTreeStore((s) => s.byId)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const rootIds = useTreeStore((s) => s.rootIds)
  const groups = useMemo(
    () => chapterGroups({ byId, childrenOf, rootIds }),
    [byId, childrenOf, rootIds]
  )
  const chapterSet = useMemo(
    () => new Set(groups.flatMap((group) => group.chapters.map((c) => c.id))),
    [groups]
  )

  const store = useExportStore()
  const defaults = defaultExportFormatting(settings.sceneBreak)
  const formatting = store.formatting ?? defaults
  const options = buildExportOptions(store, defaults, {
    chapterIds: chapterSet,
    openDocumentId: openDoc?.id ?? null
  })
  const running = store.status === 'running'
  const markdown = store.format === 'md'
  const singleDocument = store.scope === 'document'
  const edit = (patch: Partial<ExportFormatting>): void =>
    store.setFormatting({ ...formatting, ...patch })

  const ids = {
    font: useId(),
    size: useId(),
    spacing: useId(),
    page: useId(),
    sceneBreak: useId(),
    chapters: useId()
  }

  const onExport = async (): Promise<void> => {
    if (options === null) return
    if (await useExportStore.getState().run(options)) onClose()
  }

  const scopeOption = (
    kind: ExportScopeKind,
    label: string,
    disabled = false
  ): React.JSX.Element => (
    <label className={OPTION}>
      <input
        type="radio"
        name="export-scope"
        checked={store.scope === kind}
        disabled={disabled || running}
        onChange={() => store.setScope(kind)}
      />
      {label}
    </label>
  )

  return (
    <StatsFrame
      title="Export"
      widthClassName="w-[min(560px,94vw)]"
      onClose={onClose}
      action={
        <button
          type="button"
          disabled={options === null || running}
          aria-busy={running}
          onClick={() => void onExport()}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent"
        >
          Export
        </button>
      }
    >
      <fieldset className={FIELDSET}>
        <legend className={LEGEND}>Format</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {EXPORT_FORMATS.map((id) => (
            <label key={id} className={OPTION}>
              <input
                type="radio"
                name="export-format"
                checked={store.format === id}
                disabled={running}
                onChange={() => store.setFormat(id)}
              />
              {EXPORT_FORMAT_LABELS[id]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={FIELDSET}>
        <legend className={LEGEND}>Include</legend>
        {scopeOption('manuscript', 'Whole manuscript')}
        {scopeOption('chapters', 'Selected chapters', groups.length === 0)}
        {store.scope === 'chapters' ? (
          <div
            id={ids.chapters}
            role="group"
            aria-label="Chapters"
            className="ml-5 flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-line px-2 py-1.5"
          >
            {groups.map((group) => (
              <div
                key={group.partId ?? `loose-${group.chapters[0]?.id}`}
                className="flex flex-col gap-1"
              >
                {group.partTitle !== null ? (
                  <span className="text-xs font-medium text-fg-muted">
                    {group.partTitle || 'Untitled'}
                  </span>
                ) : null}
                {group.chapters.map((chapter) => (
                  <label
                    key={chapter.id}
                    className={`${OPTION} ${group.partTitle !== null ? 'ml-3' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={store.chapterIds.includes(chapter.id)}
                      disabled={running}
                      onChange={(event) => store.toggleChapter(chapter.id, event.target.checked)}
                    />
                    {chapter.title || 'Untitled'}
                  </label>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        {scopeOption(
          'document',
          openDoc ? `Current document (${openDoc.title || 'Untitled'})` : 'Current document',
          openDoc === null
        )}
        {openDoc === null ? (
          <p className="m-0 ml-5 text-xs text-fg-muted">Open a document to export it alone.</p>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <label className={OPTION}>
            <input
              type="checkbox"
              checked={store.includeFront && !singleDocument}
              disabled={singleDocument || running}
              onChange={(event) => store.setIncludeFront(event.target.checked)}
            />
            Front matter
          </label>
          <label className={OPTION}>
            <input
              type="checkbox"
              checked={store.includeEnd && !singleDocument}
              disabled={singleDocument || running}
              onChange={(event) => store.setIncludeEnd(event.target.checked)}
            />
            End matter
          </label>
        </div>
      </fieldset>

      <fieldset className={FIELDSET}>
        <legend className={LEGEND}>Formatting</legend>
        {markdown ? (
          <p className="m-0 text-xs text-fg-muted">
            Markdown has no fonts or pages; only the scene break applies.
          </p>
        ) : null}
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
          <label htmlFor={ids.font}>Font</label>
          <select
            id={ids.font}
            value={formatting.font}
            disabled={markdown || running}
            onChange={(event) => {
              const font = EXPORT_FONTS.find((f) => f === event.target.value)
              if (font !== undefined) edit({ font })
            }}
            className={`${FIELD} w-40`}
          >
            {EXPORT_FONTS.map((font) => (
              <option key={font} value={font}>
                {FONT_LABELS[font]}
              </option>
            ))}
          </select>
          <label htmlFor={ids.size}>Size</label>
          <select
            id={ids.size}
            value={formatting.fontSize}
            disabled={markdown || running}
            onChange={(event) => edit({ fontSize: Number(event.target.value) })}
            className={`${FIELD} w-40`}
          >
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} pt
              </option>
            ))}
          </select>
          <label htmlFor={ids.spacing}>Line spacing</label>
          <select
            id={ids.spacing}
            value={formatting.lineSpacing}
            disabled={markdown || running}
            onChange={(event) => {
              const spacing = EXPORT_LINE_SPACINGS.find((s) => String(s) === event.target.value)
              if (spacing !== undefined) edit({ lineSpacing: spacing })
            }}
            className={`${FIELD} w-40`}
          >
            {EXPORT_LINE_SPACINGS.map((spacing) => (
              <option key={spacing} value={spacing}>
                {SPACING_LABELS[spacing]}
              </option>
            ))}
          </select>
          <label htmlFor={ids.page}>Page size</label>
          <select
            id={ids.page}
            value={formatting.pageSize}
            disabled={markdown || running}
            onChange={(event) => {
              const pageSize = EXPORT_PAGE_SIZES.find((p) => p === event.target.value)
              if (pageSize !== undefined) edit({ pageSize })
            }}
            className={`${FIELD} w-40`}
          >
            {EXPORT_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {PAGE_LABELS[size]}
              </option>
            ))}
          </select>
          <label htmlFor={ids.sceneBreak}>Scene break</label>
          <input
            id={ids.sceneBreak}
            type="text"
            value={formatting.sceneBreak}
            maxLength={SCENE_BREAK_MAX}
            disabled={running}
            onChange={(event) => edit({ sceneBreak: event.target.value })}
            className={`${FIELD} w-40`}
          />
        </div>
        <label className={OPTION}>
          <input
            type="checkbox"
            checked={formatting.chapterNewPage}
            disabled={markdown || running}
            onChange={(event) => edit({ chapterNewPage: event.target.checked })}
          />
          Start chapters on a new page
        </label>
        <label className={OPTION}>
          <input
            type="checkbox"
            checked={formatting.indentParagraphs}
            disabled={markdown || running}
            onChange={(event) => edit({ indentParagraphs: event.target.checked })}
          />
          Indent paragraphs
        </label>
      </fieldset>

      {running ? (
        <div className="flex flex-col gap-1 text-xs text-fg-muted">
          <progress
            data-testid="export-progress"
            aria-label="Export progress"
            className="w-full"
            {...(store.progress !== null && store.progress.total > 0
              ? { value: store.progress.done, max: store.progress.total }
              : {})}
          />
          <span>{stageLabel(store.progress)}</span>
        </div>
      ) : null}
      {store.status === 'error' && store.error !== null ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {store.error}
        </p>
      ) : null}
    </StatsFrame>
  )
}
