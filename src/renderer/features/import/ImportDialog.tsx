import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { docToText } from '@shared/docText'
import {
  IMPORT_PLACEMENTS,
  IMPORT_PLACEMENT_LABEL,
  IMPORT_TITLE_MAX,
  ImportPlacement,
  draftSummary,
  sceneFirstLine,
  sceneWords,
  type ImportAiMarks,
  type ImportChapter,
  type ImportDraft,
  type ImportSummary
} from '@shared/import'
import type { TiptapNodeT } from '@shared/tiptap'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import { findNode } from './draftEdits'
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

/** One paragraph of a scene as the review pane shows it; empty paragraphs read as a blank line. */
const paragraphText = (node: TiptapNodeT): string => docToText({ type: 'doc', content: [node] })

const ACTION =
  'shrink-0 rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'
const ICON_ACTION =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded border border-line text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'
const INDENT = ['pl-2', 'pl-6', 'pl-10'] as const

/** True while the AI pass runs: every edit in the tree is refused until it answers. */
const useDetectRunning = (): boolean => useImportStore((s) => s.detect?.status === 'running')

/**
 * The import review dialog (F-12.2): main's structure draft, shown as the parts, chapters, and
 * scenes it would create, with everything the author needs to correct a heuristic before
 * anything is written — rename, exclude, reorder, nest, move a scene between chapters, merge,
 * split, and send a chapter to the front or back matter. Import writes the draft as it stands;
 * Cancel drops it. The dialog holds review edits that exist nowhere else, so a backdrop click
 * does *not* close it (Escape and Cancel do, deliberately).
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
  const cancel = useImportStore((s) => s.cancel)
  const commit = useImportStore((s) => s.commit)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panel.current?.focus()
  }, [])

  // Both walk every paragraph, so they are computed once per draft rather than once per render.
  const summary = useMemo(() => draftSummary(draft), [draft])
  const words = useMemo(() => wordMap(draft), [draft])
  const chapterAt = useMemo(() => chapterOrder(draft), [draft])

  const selected = sceneId === null ? null : findNode(draft, sceneId)
  const scene = selected?.kind === 'scene' ? selected.scene : null
  const nothingToImport = summary.scenes + summary.matter === 0

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
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
        className="flex h-[80vh] w-[1000px] max-w-[95vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel outline-none"
      >
        <div className="shrink-0 border-b border-line px-5 pt-4 pb-3">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Import “{draft.source.name}”
          </h2>
          <p className="mt-1 mb-0 text-sm text-fg-muted" data-testid="import-question">
            Does this look right? Rename, reorder, or leave anything out before you import.
          </p>
          <p className="mt-1 mb-0 text-xs text-fg-subtle" data-testid="import-summary">
            {summaryLine(summary)}
          </p>
        </div>
        <DetectPanel />
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            <ul className="m-0 flex list-none flex-col p-0">
              {draft.parts.map((part, partIndex) => (
                <li key={part.id} className="m-0 list-none p-0">
                  <Row
                    id={part.id}
                    title={part.title}
                    depth={0}
                    kindLabel="part"
                    excluded={part.excluded}
                    dimmed={part.excluded}
                    words={words[part.id] ?? 0}
                  >
                    <MoveButtons
                      id={part.id}
                      title={part.title}
                      canUp={partIndex > 0}
                      canDown={partIndex < draft.parts.length - 1}
                    />
                  </Row>
                  <ul className="m-0 flex list-none flex-col p-0">
                    {part.chapters.map((chapter, chapterIndex) => (
                      <li key={chapter.id} className="m-0 list-none p-0">
                        <ChapterRow
                          chapter={chapter}
                          words={words[chapter.id] ?? 0}
                          dimmed={part.excluded || chapter.excluded}
                          canUp={chapterIndex > 0}
                          canDown={chapterIndex < part.chapters.length - 1}
                          canNestPrev={partIndex > 0}
                          canNestNext={partIndex < draft.parts.length - 1}
                        />
                        <ul className="m-0 flex list-none flex-col p-0">
                          {chapter.scenes.map((sc, sceneIndex) => {
                            const flat = chapterAt[chapter.id] ?? 0
                            return (
                              <li key={sc.id} className="m-0 list-none p-0">
                                <Row
                                  id={sc.id}
                                  title={sc.title}
                                  depth={2}
                                  kindLabel="scene"
                                  excluded={sc.excluded}
                                  dimmed={part.excluded || chapter.excluded || sc.excluded}
                                  words={words[sc.id] ?? 0}
                                  preview={sceneFirstLine(sc)}
                                  active={sc.id === sceneId}
                                  ai={sc.ai}
                                >
                                  <MoveButtons
                                    id={sc.id}
                                    title={sc.title}
                                    canUp={sceneIndex > 0}
                                    canDown={sceneIndex < chapter.scenes.length - 1}
                                  />
                                  <SceneActions
                                    id={sc.id}
                                    title={sc.title}
                                    canMerge={sceneIndex > 0}
                                    canPrevChapter={flat > 0}
                                    canNextChapter={flat < Object.keys(chapterAt).length - 1}
                                    canSplit={sc.paragraphs.length > 1}
                                  />
                                </Row>
                              </li>
                            )
                          })}
                        </ul>
                      </li>
                    ))}
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
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
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
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface RowProps {
  id: string
  title: string
  depth: 0 | 1 | 2
  /** Reads in the accessible names of the row's controls: "Exclude chapter Chapter One". */
  kindLabel: string
  excluded: boolean
  /** True when this node or a container above it is left out; the row greys either way. */
  dimmed: boolean
  words: number
  preview?: string
  /** The scene whose paragraphs the right pane shows. */
  active?: boolean
  /** What the AI pass (F-12.3) did to this node, if anything: the row badges it and offers Reject. */
  ai?: ImportAiMarks
  children?: ReactNode
}

/** One line of the review tree: the title (click to rename), a preview, the words, the actions, Exclude. */
function Row({
  id,
  title,
  depth,
  kindLabel,
  excluded,
  dimmed,
  words,
  preview,
  active,
  ai,
  children
}: RowProps): React.JSX.Element {
  const renaming = useImportStore((s) => s.renamingId === id)
  const running = useDetectRunning()
  const startRename = useImportStore((s) => s.startRename)
  const setExcluded = useImportStore((s) => s.setExcluded)
  const reject = useImportStore((s) => s.rejectSuggestion)

  return (
    <div
      data-testid="import-node"
      data-import-id={id}
      data-excluded={dimmed ? 'true' : undefined}
      className={`flex items-center gap-2 py-0.5 pr-3 text-sm ${INDENT[depth]} ${
        active ? 'bg-accent/10' : 'hover:bg-surface'
      } ${dimmed ? 'text-fg-subtle line-through' : ''}`}
    >
      {renaming ? (
        <RenameInput id={id} title={title} />
      ) : (
        <button
          type="button"
          title="Rename"
          disabled={running}
          onClick={() => startRename(id)}
          // The title keeps at least 6rem (up to 12rem) and the preview gives way first: a badged
          // row (F-12.3) carries an AI chip and a Reject button, which otherwise squeezed the
          // title to one letter while the preview kept a few.
          className={`min-w-24 max-w-48 shrink truncate rounded px-1 text-left hover:bg-surface-raised disabled:hover:bg-transparent ${
            depth === 2 ? '' : 'font-medium'
          }`}
        >
          {title}
        </button>
      )}
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
      ) : (
        <span className="flex-1" />
      )}
      <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{words.toLocaleString()}</span>
      {children}
      {ai?.break === true ? (
        <button
          type="button"
          data-testid="import-reject"
          disabled={running}
          aria-label={`Reject the ${kindLabel} the AI added, ${title}`}
          onClick={() => reject(id)}
          className={ACTION}
        >
          Reject
        </button>
      ) : null}
      <label className="flex shrink-0 items-center gap-1 text-xs text-fg-muted">
        <input
          type="checkbox"
          data-testid="import-exclude"
          disabled={running}
          aria-label={`Exclude ${kindLabel} ${title}`}
          checked={excluded}
          onChange={(event) => setExcluded(id, event.target.checked)}
        />
        Exclude
      </label>
    </div>
  )
}

/** The chapter's own row: placement, nesting, and the shared move buttons. */
function ChapterRow({
  chapter,
  words,
  dimmed,
  canUp,
  canDown,
  canNestPrev,
  canNestNext
}: {
  chapter: ImportChapter
  words: number
  dimmed: boolean
  canUp: boolean
  canDown: boolean
  canNestPrev: boolean
  canNestNext: boolean
}): React.JSX.Element {
  const setPlacement = useImportStore((s) => s.setPlacement)
  const nest = useImportStore((s) => s.nest)
  const running = useDetectRunning()
  return (
    <Row
      id={chapter.id}
      title={chapter.title}
      depth={1}
      kindLabel="chapter"
      excluded={chapter.excluded}
      dimmed={dimmed}
      words={words}
      ai={chapter.ai}
    >
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
      <MoveButtons id={chapter.id} title={chapter.title} canUp={canUp} canDown={canDown} />
      <button
        type="button"
        disabled={!canNestPrev || running}
        aria-label={`Move ${chapter.title} to the previous part`}
        onClick={() => nest(chapter.id, 'prev')}
        className={ACTION}
      >
        ↰ part
      </button>
      <button
        type="button"
        disabled={!canNestNext || running}
        aria-label={`Move ${chapter.title} to the next part`}
        onClick={() => nest(chapter.id, 'next')}
        className={ACTION}
      >
        ↳ part
      </button>
    </Row>
  )
}

/** Move up / move down among the siblings; the same pair for a part, a chapter, and a scene. */
function MoveButtons({
  id,
  title,
  canUp,
  canDown
}: {
  id: string
  title: string
  canUp: boolean
  canDown: boolean
}): React.JSX.Element {
  const move = useImportStore((s) => s.move)
  const running = useDetectRunning()
  return (
    <>
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
    </>
  )
}

/** What a scene can do beyond moving among its siblings: change chapter, merge, split. */
function SceneActions({
  id,
  title,
  canMerge,
  canPrevChapter,
  canNextChapter,
  canSplit
}: {
  id: string
  title: string
  canMerge: boolean
  canPrevChapter: boolean
  canNextChapter: boolean
  canSplit: boolean
}): React.JSX.Element {
  const moveScene = useImportStore((s) => s.moveScene)
  const mergeScene = useImportStore((s) => s.mergeScene)
  const selectScene = useImportStore((s) => s.selectScene)
  const running = useDetectRunning()
  return (
    <>
      <button
        type="button"
        disabled={!canPrevChapter || running}
        aria-label={`Move ${title} to the previous chapter`}
        onClick={() => moveScene(id, 'prev')}
        className={ACTION}
      >
        ↰ ch.
      </button>
      <button
        type="button"
        disabled={!canNextChapter || running}
        aria-label={`Move ${title} to the next chapter`}
        onClick={() => moveScene(id, 'next')}
        className={ACTION}
      >
        ↳ ch.
      </button>
      <button
        type="button"
        disabled={!canMerge || running}
        aria-label={`Merge ${title} with the scene before it`}
        onClick={() => mergeScene(id)}
        className={ACTION}
      >
        Merge
      </button>
      <button
        type="button"
        disabled={!canSplit || running}
        aria-label={`Split ${title}`}
        onClick={() => selectScene(id)}
        className={ACTION}
      >
        Split…
      </button>
    </>
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
          <span data-testid="import-detect-progress" className="text-fg-muted">
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

/** Each chapter's place in reading order, so a scene knows whether it has a chapter either side. */
function chapterOrder(draft: ImportDraft): Record<string, number> {
  const order: Record<string, number> = {}
  let index = 0
  for (const part of draft.parts) {
    for (const chapter of part.chapters) order[chapter.id] = index++
  }
  return order
}
