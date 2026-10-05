import { useEffect, useState } from 'react'
import {
  DEFAULT_ZOOM,
  UI_SCALES,
  UI_SCALE_FACTORS,
  UI_SCALE_LABELS,
  ZOOM_MAX,
  ZOOM_MIN,
  formatZoom
} from '@shared/zoom'
import { AccentPicker } from '@renderer/features/account/AccentPicker'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { ThemePicker } from './ThemePicker'
import { useViewStore } from './viewStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'
const RADIO =
  'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border border-line px-2 py-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent aria-checked:border-accent aria-checked:bg-surface-raised'

/** What the interface size moves, and what it does not. */
const UI_SCALE_NOTE =
  'Sets the size of everything around the manuscript: the sidebar, the panels, the toolbar, and ' +
  'the dialogs. The page is inside the window, so it grows with them and the document zoom ' +
  'below multiplies on top.'

/** What the document zoom moves; the shortcuts are named because they are the usual way in. */
const DOCUMENT_ZOOM_NOTE =
  'Scales the manuscript — its text and the width of the column together — and nothing else. ' +
  'Ctrl+= , Ctrl+- , Ctrl+0 and Ctrl with the mouse wheel do the same from anywhere in the app. ' +
  'It is app-wide and separate from this project’s font size, which is under Editor.'

/** What the sheet is for; the menu item is named because it is the quicker way to flip it. */
const PAGE_EDGES_NOTE =
  'Draws the writing column as a sheet on the desk, with its margins and a visible edge, so you ' +
  'can see where the page ends and zoom it to the size you want. One continuous sheet, not ' +
  'pages. Also under View › Page edges.'

/** What reopening covers; the window's size and place come back either way. */
const REOPEN_NOTE =
  'Opens the project you had open when you last quit. Closing the project with File › Close ' +
  'project starts the next launch on the welcome screen instead. The window always comes back ' +
  'at the size and place you left it.'

/**
 * The Appearance tab of the Settings dialog (F-7.8, F-7.10, F-7.11, F-7.9): the theme and the
 * Supporter accent (moved here from the Account tab with F-7.8, beside the theme it colours),
 * then the interface size, the document zoom, and the page edges, then the startup choice,
 * with a sentence each saying what they move — the first two are easy to confuse, and confusing them is how an author ends up
 * with an unreadable window. App-scoped, so it is there on the welcome screen too, where the
 * writing surface is not. Main owns the values and applies the interface size to the window
 * itself, so these controls only ask.
 */
export function AppearanceSettingsTab(): React.JSX.Element {
  const editorZoom = useViewStore((s) => s.editorZoom)
  const uiScale = useViewStore((s) => s.uiScale)
  const loaded = useViewStore((s) => s.loaded)
  const load = useViewStore((s) => s.load)
  const zoomDocument = useViewStore((s) => s.zoomDocument)
  const setUiScale = useViewStore((s) => s.setUiScale)
  const pageEdges = useViewStore((s) => s.pageEdges)
  const setPageEdges = useViewStore((s) => s.setPageEdges)

  // F-7.9: main reads this once, at launch, so nothing else in the renderer mirrors it.
  const [reopenLastProject, setReopenLastProject] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    ipc()
      .invoke('startup:get', undefined)
      .then((startup) => {
        if (live) setReopenLastProject(startup.reopenLastProject)
      })
      .catch((err: unknown) => toast.error(describeError(err)))
    return () => {
      live = false
    }
  }, [])
  const changeReopen = async (on: boolean): Promise<void> => {
    try {
      const startup = await ipc().invoke('startup:setReopenLastProject', { on })
      setReopenLastProject(startup.reopenLastProject)
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  // `App` loads the settings at start; this only covers the tab being opened before that first
  // answer arrived.
  useEffect(() => {
    if (!loaded) void load().catch((err: unknown) => toast.error(describeError(err)))
  }, [loaded, load])

  return (
    <div className="flex flex-col gap-4 text-sm">
      <ThemePicker />
      <AccentPicker />

      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <span className="text-xs text-fg-muted">Interface size</span>
        <div role="radiogroup" aria-label="Interface size" className="flex gap-2">
          {UI_SCALES.map((scale) => (
            <button
              key={scale}
              type="button"
              role="radio"
              data-testid={`appearance-ui-scale-${scale}`}
              aria-checked={scale === uiScale}
              onClick={() => void setUiScale(scale)}
              className={RADIO}
            >
              <span className="text-sm font-medium">{UI_SCALE_LABELS[scale]}</span>
              <span className="text-xs text-fg-muted">{formatZoom(UI_SCALE_FACTORS[scale])}</span>
            </button>
          ))}
        </div>
        <p className="m-0 text-xs text-fg-muted">{UI_SCALE_NOTE}</p>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <span className="text-xs text-fg-muted">Document zoom</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={editorZoom <= ZOOM_MIN}
            onClick={() => void zoomDocument('out')}
            className={BUTTON}
          >
            −
          </button>
          <span data-testid="appearance-document-zoom" className="min-w-16 text-center">
            {formatZoom(editorZoom)}
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={editorZoom >= ZOOM_MAX}
            onClick={() => void zoomDocument('in')}
            className={BUTTON}
          >
            +
          </button>
          <button
            type="button"
            disabled={editorZoom === DEFAULT_ZOOM}
            onClick={() => void zoomDocument('reset')}
            className={BUTTON}
          >
            Reset
          </button>
        </div>
        <p className="m-0 text-xs text-fg-muted">{DOCUMENT_ZOOM_NOTE}</p>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="appearance-page-edges"
            checked={pageEdges}
            onChange={(event) => void setPageEdges(event.target.checked)}
          />
          <span>Show page edges</span>
        </label>
        <p className="m-0 text-xs text-fg-muted">{PAGE_EDGES_NOTE}</p>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <span className="text-xs text-fg-muted">Startup</span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="appearance-reopen-last-project"
            disabled={reopenLastProject === null}
            checked={reopenLastProject ?? false}
            onChange={(event) => void changeReopen(event.target.checked)}
          />
          <span>Reopen the last project on launch</span>
        </label>
        <p className="m-0 text-xs text-fg-muted">{REOPEN_NOTE}</p>
      </div>
    </div>
  )
}
