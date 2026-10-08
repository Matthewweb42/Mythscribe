import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CompiledBook } from '@shared/compileModel'
import { describeError } from '@renderer/lib/errors'
import { previewBook, previewIsWhole, previewStarts } from './compileContents'
import { HINT } from './fields'
import { isPagedOutput, layoutPreview, setPreviewZoom } from './pagedFrame'

/** How long the settings must rest before the preview lays out again. */
export const PREVIEW_DEBOUNCE_MS = 350

const ZOOMS = [
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
  { value: 1, label: '100%' }
] as const

type LayoutState =
  | { status: 'idle' }
  | { status: 'layout' }
  | { status: 'ready'; pages: number | null }
  | { status: 'error'; message: string }

/**
 * The compile window's live preview (Compile v2, CV3): the compiled book as it will print, laid
 * out in pages by the PDF's own engine (`layoutPreview`), from a chosen place for about
 * `PREVIEW_WORDS` words so a whole novel stays fast. Reflowable outputs (EPUB, HTML, text,
 * Markdown) show the web page. Re-laid out a moment after the settings change.
 */
export function CompilePreview({ book }: { book: CompiledBook | null }): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const startId = useId()
  const zoomId = useId()
  const [start, setStart] = useState(0)
  const [zoom, setZoom] = useState(0.75)
  const [state, setState] = useState<LayoutState>({ status: 'idle' })
  const zoomRef = useRef(zoom)

  const starts = useMemo(() => (book === null ? [] : previewStarts(book)), [book])
  const startItem = starts.some((s) => s.item === start) ? start : 0
  const shown = useMemo(
    () => (book === null ? null : previewBook(book, startItem)),
    [book, startItem]
  )

  useEffect(() => {
    const element = frame.current
    if (shown === null || element === null) return
    let stale = false
    const timer = setTimeout(() => {
      setState({ status: 'layout' })
      layoutPreview(element, shown, zoomRef.current, () => stale)
        .then((result) => {
          if (!stale && result !== null) setState({ status: 'ready', pages: result.pages })
        })
        .catch((err: unknown) => {
          if (!stale) setState({ status: 'error', message: describeError(err) })
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [shown])

  useEffect(() => {
    zoomRef.current = zoom
    if (frame.current !== null) setPreviewZoom(frame.current, zoom)
  }, [zoom])

  const paged = book !== null && isPagedOutput(book.output)
  let status = ''
  if (state.status === 'layout') status = 'Laying out…'
  else if (state.status === 'ready' && state.pages !== null)
    status = `${state.pages} ${state.pages === 1 ? 'page' : 'pages'}${
      book !== null && shown !== null && !previewIsWhole(book, shown)
        ? ' (a window of the book)'
        : ''
    }`
  else if (state.status === 'ready') status = 'Reflowable: the reader sets the page'

  return (
    <section aria-label="Preview" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={startId}>Preview from</label>
        <select
          id={startId}
          value={startItem}
          onChange={(event) => setStart(Number(event.target.value))}
          className="max-w-48 rounded-md border border-line bg-bg px-2 py-1 text-sm"
        >
          {starts.map((s) => (
            <option key={s.item} value={s.item}>
              {s.label}
            </option>
          ))}
        </select>
        {paged ? (
          <>
            <label htmlFor={zoomId}>Zoom</label>
            <select
              id={zoomId}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
            >
              {ZOOMS.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <span role="status" className="text-xs text-fg-muted">
          {status}
        </span>
      </div>
      {state.status === 'error' ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {state.message}
        </p>
      ) : null}
      {book === null ? <p className={HINT}>Loading…</p> : null}
      <iframe
        ref={frame}
        title="Compile preview"
        data-testid="compile-window-preview"
        data-state={state.status}
        data-pages={state.status === 'ready' && state.pages !== null ? state.pages : undefined}
        className="min-h-0 w-full flex-1 rounded-md border border-line bg-white"
      />
    </section>
  )
}
