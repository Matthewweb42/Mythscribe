import { create } from 'zustand'
import {
  defaultProjectSession,
  withPosition,
  type ProjectSession,
  type SessionPosition,
  type SessionSelection
} from '@shared/session'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useOutlineViewStore } from '@renderer/features/outline/outlineViewStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { registerPendingSave } from './pendingSaves'

/** How long after the last move the debounced `session:set` fires (F-1.7). */
export const SESSION_SAVE_DELAY_MS = 750

/**
 * Resume where you left off (F-1.7): the one owner of the project's session. It holds only what
 * no other store owns (the caret and scroll per document, the notes column's "Scene details"
 * state); the selection, the folded folders, the tag filter, the sidebar tab, the folder view,
 * and focus mode stay with their own stores, and the session reads them when it writes. `load`
 * fetches the stored session, waits for the tree, the story bible, and the tag bank, then puts
 * back whatever still exists (stale ids are dropped silently) and only then starts listening, so
 * the restore itself and the loads never count as moves. Every move after that schedules one
 * debounced write; the pending-save registry flushes it before a close, an open, or a quit.
 * Nothing waits on a write, so typing is never blocked.
 */
interface SessionState {
  /** True from a restored `load` until `clear`: only then are moves recorded. */
  live: boolean
  sceneDetailsOpen: boolean
  /** Caret and scroll per document and stacked folder, most recent first. */
  positions: SessionPosition[]
  /** The document whose editor takes the focus at its restored caret once it is ready. */
  caretFocusId: string | null
  /** Fetches and restores the project's session once `ready` (the tree and the lists it checks ids against) settles. */
  load: (ready: Promise<unknown>) => Promise<void>
  /** Stops recording and drops any pending write; the project is gone. */
  clear: () => void
  setSceneDetailsOpen: (open: boolean) => void
  recordSelection: (id: string, selection: SessionSelection) => void
  recordScroll: (id: string, scrollTop: number) => void
  /** Where `id` was, or null when it has no entry. */
  positionOf: (id: string) => SessionPosition | null
  /** True once, for the document restored on open; any later call answers false. */
  takeCaretFocus: (id: string) => boolean
}

let timer: ReturnType<typeof setTimeout> | null = null
let dirty = false
/** Bumped by every load() and clear() so a superseded load or a write after close is dropped. */
let generation = 0
let unregister: (() => void) | null = null
let unsubscribers: (() => void)[] = []

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/** The session as it stands, read from the stores that own each piece. */
export function snapshotSession(): ProjectSession {
  const tree = useTreeStore.getState()
  const own = useSessionStore.getState()
  return {
    selectedNodeId: tree.selectedId,
    selectedEntityId: useEntityStore.getState().selectedId,
    sidebarTab: useLayoutStore.getState().layout.sidebar.tab,
    collapsed: Object.keys(tree.collapsed).filter((id) => tree.collapsed[id] === true),
    tagFilter: tree.tagFilter,
    folderView: useOutlineViewStore.getState().folderView,
    sceneDetailsOpen: own.sceneDetailsOpen,
    focus: useFocusStore.getState().active,
    positions: own.positions
  }
}

async function write(): Promise<void> {
  cancelTimer()
  if (!dirty) return
  dirty = false
  const mine = generation
  try {
    await ipc().invoke('session:set', snapshotSession())
  } catch (err) {
    if (mine !== generation) return // the project closed meanwhile; nothing to report
    dirty = true // the next move or flush tries again
    throw err
  }
}

function schedule(): void {
  if (!useSessionStore.getState().live) return
  dirty = true
  cancelTimer()
  timer = setTimeout(() => {
    write().catch((err: unknown) => toast.error(describeError(err)))
  }, SESSION_SAVE_DELAY_MS)
}

/** Puts back what the stored session names and still exists. */
function restore(session: ProjectSession): void {
  const tree = useTreeStore.getState()
  const node = session.selectedNodeId === null ? undefined : tree.byId[session.selectedNodeId]
  const collapsed: Record<string, boolean> = {}
  for (const id of session.collapsed) if (tree.byId[id]?.kind === 'folder') collapsed[id] = true
  const tagFilter =
    session.tagFilter !== null && useTagStore.getState().byId[session.tagFilter] !== undefined
      ? session.tagFilter
      : null
  useTreeStore.setState({ collapsed, tagFilter })
  if (node?.sectionType === null) tree.select(node.id)
  const entity = session.selectedEntityId
  if (entity !== null && useEntityStore.getState().byId[entity] !== undefined)
    useEntityStore.getState().select(entity)
  if (session.sidebarTab !== null) useLayoutStore.getState().setSidebarTab(session.sidebarTab)
  useOutlineViewStore.getState().setFolderView(session.folderView)
  useSessionStore.setState({
    sceneDetailsOpen: session.sceneDetailsOpen,
    positions: session.positions.filter((p) => tree.byId[p.id] !== undefined),
    caretFocusId:
      node?.kind === 'document' && useEntityStore.getState().selectedId === null ? node.id : null
  })
  const focus = useFocusStore.getState()
  if (session.focus && !focus.active) void focus.enter()
}

/** Starts recording the moves the other stores own. */
function listen(): void {
  unsubscribers = [
    useTreeStore.subscribe((s, prev) => {
      if (
        s.selectedId !== prev.selectedId ||
        s.collapsed !== prev.collapsed ||
        s.tagFilter !== prev.tagFilter
      )
        schedule()
    }),
    useEntityStore.subscribe((s, prev) => {
      if (s.selectedId !== prev.selectedId) schedule()
    }),
    useLayoutStore.subscribe((s, prev) => {
      if (s.layout.sidebar.tab !== prev.layout.sidebar.tab) schedule()
    }),
    useOutlineViewStore.subscribe((s, prev) => {
      if (s.folderView !== prev.folderView) schedule()
    }),
    useFocusStore.subscribe((s, prev) => {
      if (s.active !== prev.active) schedule()
    })
  ]
}

function stopListening(): void {
  for (const off of unsubscribers) off()
  unsubscribers = []
}

const initial = {
  live: false,
  sceneDetailsOpen: false,
  positions: [] as SessionPosition[],
  caretFocusId: null
}

export const useSessionStore = create<SessionState>((set, get) => ({
  ...initial,

  async load(ready) {
    get().clear()
    const mine = generation
    let session = defaultProjectSession()
    try {
      session = await ipc().invoke('session:get', undefined)
    } catch (err) {
      toast.error(describeError(err))
    }
    try {
      await ready
    } catch {
      // The load that failed has toasted on its own; restore what can be checked.
    }
    if (mine !== generation) return
    restore(session)
    set({ live: true })
    unregister = registerPendingSave(() => write())
    listen()
  },

  clear() {
    generation++
    cancelTimer()
    dirty = false
    stopListening()
    unregister?.()
    unregister = null
    set({ ...initial })
  },

  setSceneDetailsOpen(open) {
    if (get().sceneDetailsOpen === open) return
    set({ sceneDetailsOpen: open })
    schedule()
  },

  recordSelection(id, selection) {
    if (!get().live) return
    const current = get().positionOf(id)
    const same =
      current?.selection?.anchor === selection.anchor && current.selection.head === selection.head
    if (same && get().positions[0]?.id === id) return
    set({
      positions: withPosition(get().positions, {
        id,
        scrollTop: current?.scrollTop ?? 0,
        selection
      })
    })
    schedule()
  },

  recordScroll(id, scrollTop) {
    if (!get().live) return
    const current = get().positionOf(id)
    const top = Math.max(0, Math.round(scrollTop))
    if (current?.scrollTop === top && get().positions[0]?.id === id) return
    set({
      positions: withPosition(get().positions, {
        id,
        scrollTop: top,
        selection: current?.selection ?? null
      })
    })
    schedule()
  },

  positionOf(id) {
    return get().positions.find((p) => p.id === id) ?? null
  },

  takeCaretFocus(id) {
    const match = get().caretFocusId === id
    if (get().caretFocusId !== null) set({ caretFocusId: null })
    return match
  }
}))

/** Drops the timer, the listeners, and the registration, then empties the store. For tests only. */
export function resetSessionStore(): void {
  useSessionStore.getState().clear()
}
