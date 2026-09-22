import { create } from 'zustand'
import { defaultViewSettings, formatZoom, type UiScale, type ZoomStep } from '@shared/zoom'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer's mirror of the app-wide view settings (F-7.10). Main owns both values — it steps
 * the document zoom, applies the interface size to the window, and answers the pair — so this
 * store only asks and holds what came back. The document zoom is the renderer's to *apply*: the
 * editing surface multiplies the project's font size and column width by it (`editor/column.ts`),
 * which is why it lives in a store rather than in the window's zoom factor. The interface size
 * needs nothing here; the window is already scaled when main answers. App-wide, not per project,
 * so `load()` runs once at app start and there is no per-project clear.
 */
interface ViewState {
  /** The defaults until `load` resolves, so the shell renders before app-state.json is read. */
  editorZoom: number
  uiScale: UiScale
  /** False until the first answer arrives; the Appearance tab waits on it. */
  loaded: boolean
  load: () => Promise<void>
  /** Steps the document zoom and announces where it landed (the shortcuts and the menu run this). */
  zoomDocument: (step: ZoomStep) => Promise<void>
  /** Sets the interface size; main resizes every window before it answers. */
  setUiScale: (scale: UiScale) => Promise<void>
}

/** Bumped by every load and reset so a response from a superseded request is dropped. */
let generation = 0

export const useViewStore = create<ViewState>((set) => ({
  ...defaultViewSettings(),
  loaded: false,

  async load() {
    const mine = ++generation
    const view = await ipc().invoke('view:get', undefined)
    if (mine !== generation) return
    set({ ...view, loaded: true })
  },

  async zoomDocument(step) {
    const mine = generation
    try {
      const view = await ipc().invoke('view:zoomDocument', { step })
      if (mine !== generation) return
      set({ ...view, loaded: true })
      // A toast (F-7.6), not the status bar: the zoom works on the welcome screen too, where
      // there is no status bar.
      toast.info(`Document zoom ${formatZoom(view.editorZoom)}`)
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async setUiScale(scale) {
    const mine = generation
    try {
      const view = await ipc().invoke('view:setUiScale', { scale })
      if (mine !== generation) return
      set({ ...view, loaded: true })
    } catch (err) {
      toast.error(describeError(err))
    }
  }
}))

/** Restores the defaults and invalidates in-flight requests. For tests only. */
export function resetViewStore(): void {
  generation++
  useViewStore.setState({ ...defaultViewSettings(), loaded: false })
}

/**
 * The multiplier an editing surface applies (100 % until the first answer arrives). Chrome — the
 * Settings preview, the notes pane — does not call this: it stays unzoomed.
 */
export function useEditorZoom(): number {
  return useViewStore((s) => s.editorZoom)
}
