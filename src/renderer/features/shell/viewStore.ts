import { create } from 'zustand'
import { extrasUnlocked } from '@shared/appAccess'
import { nextTheme, resolveTheme, type CustomTheme, type CustomThemeInput } from '@shared/themes'
import { defaultViewSettings, formatZoom, type UiScale, type ZoomStep } from '@shared/zoom'
import { useAppAccessStore } from '@renderer/features/account/appAccessStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer's mirror of the app-wide view settings (F-7.10, F-7.11). Main owns the values —
 * it steps the document zoom, applies the interface size to the window, keeps the page-edges
 * choice, and answers the set — so this store only asks and holds what came back. The document
 * zoom and the page edges are the renderer's to *apply*: the editing surface multiplies the
 * project's font size and column width by the zoom and draws itself as a sheet
 * (`editor/column.ts`), which is why they live in a store rather than in the window. The
 * interface size needs nothing here; the window is already scaled when main answers. App-wide,
 * not per project, so `load()` runs once at app start and there is no per-project clear. The
 * theme (F-7.8) is the same: main keeps the choice and the custom themes, App.tsx paints them. So is
 * the assistant's name (F-7.13), which every surface that names the assistant reads.
 */
interface ViewState {
  /** The defaults until `load` resolves, so the shell renders before app-state.json is read. */
  editorZoom: number
  uiScale: UiScale
  pageEdges: boolean
  /** The chosen theme (F-7.8), kept even while locked; `resolveTheme` says what is painted. */
  theme: string
  customThemes: CustomTheme[]
  /** The assistant's name (F-7.13); "Ms Scribe" until `load` resolves. */
  assistantName: string
  /** False until the first answer arrives; the Appearance tab waits on it. */
  loaded: boolean
  load: () => Promise<void>
  /** Steps the document zoom and announces where it landed (the shortcuts and the menu run this). */
  zoomDocument: (step: ZoomStep) => Promise<void>
  /** Sets the interface size; main resizes every window before it answers. */
  setUiScale: (scale: UiScale) => Promise<void>
  /** Shows or hides the page edges (F-7.11) silently; the Appearance switch runs this. */
  setPageEdges: (on: boolean) => Promise<void>
  /** Flips the page edges and announces the new state (the View menu runs this). */
  togglePageEdges: () => Promise<void>
  /** Chooses a theme silently (the Appearance picker runs this). */
  setTheme: (theme: string) => Promise<void>
  /** Moves to the next available theme and announces it (View › Switch theme runs this). */
  switchTheme: () => Promise<void>
  /** Creates or replaces a custom theme and selects it; true when main took it. */
  saveCustomTheme: (theme: CustomThemeInput) => Promise<boolean>
  /** Deletes a custom theme; when it was current, main falls back to its base. */
  deleteCustomTheme: (id: string) => Promise<void>
  /** Renames the assistant (F-7.13); blank goes back to the default. Main rebuilds the menu. */
  setAssistantName: (name: string) => Promise<void>
}

/** Whether the paid themes (Sepia, custom themes) are on; unknown counts as locked. */
function licensed(): boolean {
  return extrasUnlocked(useAppAccessStore.getState().access)
}

/** Bumped by every load and reset so a response from a superseded request is dropped. */
let generation = 0

export const useViewStore = create<ViewState>((set, get) => ({
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
  },

  async setPageEdges(on) {
    const mine = generation
    try {
      const view = await ipc().invoke('view:setPageEdges', { on })
      if (mine !== generation) return
      set({ ...view, loaded: true })
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async togglePageEdges() {
    const mine = generation
    try {
      const view = await ipc().invoke('view:setPageEdges', { on: !get().pageEdges })
      if (mine !== generation) return
      set({ ...view, loaded: true })
      // A menu item with no check mark: the toast says which way it went, welcome screen included.
      toast.info(view.pageEdges ? 'Page edges shown' : 'Page edges hidden')
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async setTheme(theme) {
    const mine = generation
    try {
      const view = await ipc().invoke('view:setTheme', { theme })
      if (mine !== generation) return
      set({ ...view, loaded: true })
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async switchTheme() {
    const mine = generation
    const unlocked = licensed()
    const { theme, customThemes } = get()
    try {
      const view = await ipc().invoke('view:setTheme', {
        theme: nextTheme({ theme, customThemes }, unlocked)
      })
      if (mine !== generation) return
      set({ ...view, loaded: true })
      // A menu item with no check mark, like Page edges: the toast names where it landed.
      toast.info(`Theme: ${resolveTheme(view, unlocked).label}`)
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async saveCustomTheme(theme) {
    const mine = generation
    try {
      const view = await ipc().invoke('view:saveCustomTheme', { theme })
      if (mine !== generation) return false
      set({ ...view, loaded: true })
      return true
    } catch (err) {
      toast.error(describeError(err))
      return false
    }
  },

  async deleteCustomTheme(id) {
    const mine = generation
    try {
      const view = await ipc().invoke('view:deleteCustomTheme', { id })
      if (mine !== generation) return
      set({ ...view, loaded: true })
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async setAssistantName(name) {
    const mine = generation
    try {
      const view = await ipc().invoke('view:setAssistantName', { name })
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

/**
 * Whether an editing surface draws itself as a sheet (F-7.11). The same surfaces as the zoom;
 * chrome never asks.
 */
export function usePageEdges(): boolean {
  return useViewStore((s) => s.pageEdges)
}

/**
 * The assistant's name (F-7.13) for a component: the panel heading, the toggles, the menus, and
 * every help text that names it re-render when the author renames it.
 */
export function useAssistantName(): string {
  return useViewStore((s) => s.assistantName)
}

/** The assistant's name outside a component (a toast, a label built in a store). */
export function currentAssistantName(): string {
  return useViewStore.getState().assistantName
}
