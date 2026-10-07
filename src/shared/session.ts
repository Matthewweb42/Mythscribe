import { z } from 'zod'
import { SidebarTabId } from './sidebarTabs'

/** Settings-table key under which the project's session (F-1.7) is stored as JSON. */
export const SESSION_KEY = 'session'

/** How many documents (and stacked folders) keep their caret and scroll position, most recent first. */
export const SESSION_POSITIONS_MAX = 200
/** How many collapsed folders the session remembers; more than any real tree has. */
export const SESSION_COLLAPSED_MAX = 5_000

/** The ProseMirror selection of a document: where it started and where the caret is. */
export const SessionSelection = z.object({
  anchor: z.number().int().min(0),
  head: z.number().int().min(0)
})
export type SessionSelection = z.infer<typeof SessionSelection>

/**
 * Where the author was in one document or stacked folder (F-1.7): the scroll offset of its
 * scroller in px and, for a single document, the selection (null for a stack, or a document
 * whose caret was never placed).
 */
export const SessionPosition = z.object({
  id: z.string().min(1),
  scrollTop: z.number().min(0).default(0),
  selection: SessionSelection.nullable().default(null)
})
export type SessionPosition = z.infer<typeof SessionPosition>

/**
 * The project's session (F-1.7, decided by Claude, unconfirmed): where the author was when the
 * project last closed, kept in the project's own database so it travels with the folder. Every
 * field defaults, so a row written by an older build keeps parsing; ids that no longer exist are
 * dropped by the renderer when it restores.
 */
export const ProjectSession = z.object({
  /** The tree document or folder in the main pane. */
  selectedNodeId: z.string().nullable().default(null),
  /** The entity page over the main pane (F-9.3), if one was open. */
  selectedEntityId: z.string().nullable().default(null),
  /** The sidebar tab; null leaves the app-wide layout's tab alone. */
  sidebarTab: SidebarTabId.nullable().default(null),
  /** The folders folded shut in the Manuscript tree. */
  collapsed: z.array(z.string()).max(SESSION_COLLAPSED_MAX).default([]),
  /** The Manuscript tab's tag filter (F-4.10). */
  tagFilter: z.string().nullable().default(null),
  /** How a selected folder shows (F-11.1). */
  folderView: z.enum(['stacked', 'cork']).default('stacked'),
  /** The notes column's "Scene details" disclosure. */
  sceneDetailsOpen: z.boolean().default(false),
  /** Focus mode (F-6.1) was on. */
  focus: z.boolean().default(false),
  /** Caret and scroll per document, most recent first. */
  positions: z.array(SessionPosition).max(SESSION_POSITIONS_MAX).default([])
})
export type ProjectSession = z.infer<typeof ProjectSession>
export type ProjectSessionInput = z.input<typeof ProjectSession>

export function defaultProjectSession(): ProjectSession {
  return {
    selectedNodeId: null,
    selectedEntityId: null,
    sidebarTab: null,
    collapsed: [],
    tagFilter: null,
    folderView: 'stacked',
    sceneDetailsOpen: false,
    focus: false,
    positions: []
  }
}

/**
 * Reads a stored session leniently: unparsable JSON or a value that no longer fits the schema
 * answers with the defaults, except that an over-long position list is cut to its most recent
 * entries rather than thrown away.
 */
export function parseStoredSession(json: unknown): ProjectSession {
  const parsed = ProjectSession.safeParse(json)
  if (parsed.success) return parsed.data
  if (typeof json === 'object' && json !== null && 'positions' in json) {
    const { positions } = json
    if (Array.isArray(positions) && positions.length > SESSION_POSITIONS_MAX) {
      const retry = ProjectSession.safeParse({
        ...json,
        positions: positions.slice(0, SESSION_POSITIONS_MAX)
      })
      if (retry.success) return retry.data
    }
  }
  return defaultProjectSession()
}

/**
 * Puts `entry` first in `positions` (replacing the document's older entry) and keeps at most
 * `SESSION_POSITIONS_MAX`. Pure, so the cap is testable without the store.
 */
export function withPosition(
  positions: readonly SessionPosition[],
  entry: SessionPosition
): SessionPosition[] {
  const rest = positions.filter((p) => p.id !== entry.id)
  return [entry, ...rest].slice(0, SESSION_POSITIONS_MAX)
}
