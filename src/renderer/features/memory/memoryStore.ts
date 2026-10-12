import { useEffect } from 'react'
import { create } from 'zustand'
import type {
  ClaimView,
  MemoryNotice,
  MemoryNoticeAction,
  MemoryStatus,
  NotRightChoice,
  NotRightResult,
  ReadNowResult,
  SceneMemory,
  SheetLineView,
  SheetMemory
} from '@shared/memory/views'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * Story memory v2's reading in the renderer (F-16.16, F-16.18, F-16.19): the one owner of what
 * the reader shows, normalised: `claims` by id (each scene's lines in text order), `scenes` by
 * node (the This scene panel's Here, Mentioned, True now, card and typed-vs-text, holding its
 * claims by id), `sheets` by record and as-of scene (a sheet's "From the book"), the footer's
 * `status` and Needs a look's `notices`.
 *
 * Scenes and sheets are read on demand by the views that show them (`useSceneMemory`,
 * `useSheetMemory`), counted while shown, and dropped when nothing shows them. Main says what
 * moved: `memory:changed` (a reading, *Not right*, typed details: the shown scenes and sheets it
 * names are read again), `names:changed` (Mentioned), a roster `record:changed` (everything shown),
 * and pushes the status and the notices whole. Loaded on a v2 open; reset in tests.
 */

/** A scene's memory as stored here: its lines by id. */
export type SceneEntry = Omit<SceneMemory, 'claims'> & { claimIds: string[] }

interface MemoryState {
  claims: Record<string, ClaimView>
  scenes: Record<string, SceneEntry>
  /** By `sheetKey(recordId, asOf)`. */
  sheets: Record<string, SheetMemory>
  status: MemoryStatus | null
  notices: MemoryNotice[]
  /**
   * The *Rebuild memory* dialog (F-16.19): closed, opened to start one (price first), or opened on
   * what the last one changed (the activity bar's Open, the Book tab's *See what changed*).
   */
  rebuildOpen: 'start' | 'summary' | null
  setRebuildOpen: (open: 'start' | 'summary' | null) => void
  /** The status and the notices (what a v2 open loads). */
  load: () => Promise<void>
  loadScene: (nodeId: string) => Promise<void>
  loadSheet: (recordId: string, asOf: string | null) => Promise<void>
  /** Counts a view showing the scene and reads it; answers the release. */
  watchScene: (nodeId: string) => () => void
  watchSheet: (recordId: string, asOf: string | null) => () => void
  /**
   * *Read now* (F-16.16): pending saves flushed first, then the scene read ahead of the queue.
   * Answers main's result, or null when the call itself failed (toasted).
   */
  readNow: (nodeId: string) => Promise<ReadNowResult | null>
  /** A notice's button; answers whether main took it. */
  answerNotice: (id: string, action: MemoryNoticeAction) => Promise<boolean>
  /** *Not right* on an AI line; the line goes from what is shown at once. */
  notRight: (claimId: string, choice: NotRightChoice) => Promise<NotRightResult | null>
  /** Opens the subscriptions (idempotent); call it where a v2 project opens. */
  subscribe: () => void
  clear: () => void
}

export const sheetKey = (recordId: string, asOf: string | null): string =>
  `${recordId}|${asOf ?? ''}`

let generation = 0
let counter = 0
const nextRequestId = (): string => `mem-${Date.now().toString(36)}-${++counter}`
const sceneWatchers = new Map<string, number>()
const sheetWatchers = new Map<string, { recordId: string; asOf: string | null; count: number }>()
let unsubscribers: (() => void)[] = []

const report = (err: unknown): void => {
  toast.error(describeError(err))
}

/** A sheet without one line (and without it among the values beside another). */
function withoutLine(sheet: SheetMemory, claimId: string): SheetMemory {
  const lines = (group: SheetLineView[]): SheetLineView[] =>
    group
      .filter((line) => line.value.claimId !== claimId)
      .map((line) => ({ ...line, also: line.also.filter((also) => also.claimId !== claimId) }))
  return {
    ...sheet,
    fixed: lines(sheet.fixed),
    lasting: lines(sheet.lasting),
    transient: lines(sheet.transient),
    accumulating: lines(sheet.accumulating),
    others: sheet.others.filter((line) => line.claimId !== claimId)
  }
}

/** Whether a shown scene's memory names any of these records. */
function namesAny(entry: SceneEntry, recordIds: ReadonlySet<string>): boolean {
  return (
    entry.here.some((chip) => recordIds.has(chip.recordId)) ||
    entry.mentioned.some((chip) => recordIds.has(chip.recordId)) ||
    entry.trueNow.some((line) => recordIds.has(line.recordId))
  )
}

export const useMemoryStore = create<MemoryState>((set, get) => {
  /** Reads again every shown scene and sheet that `pick` chooses. */
  const refresh = (
    scenes: (nodeId: string, entry: SceneEntry | undefined) => boolean,
    sheets: (recordId: string) => boolean
  ): void => {
    for (const nodeId of sceneWatchers.keys()) {
      if (scenes(nodeId, get().scenes[nodeId])) get().loadScene(nodeId).catch(report)
    }
    for (const sheet of sheetWatchers.values()) {
      if (sheets(sheet.recordId)) get().loadSheet(sheet.recordId, sheet.asOf).catch(report)
    }
  }

  return {
    claims: {},
    scenes: {},
    sheets: {},
    status: null,
    notices: [],
    rebuildOpen: null,

    setRebuildOpen(open) {
      if (get().rebuildOpen !== open) set({ rebuildOpen: open })
    },

    async load() {
      const mine = generation
      const [status, notices] = await Promise.all([
        ipc().invoke('memory:status', undefined),
        ipc().invoke('memory:notices', undefined)
      ])
      if (mine === generation) set({ status, notices })
    },

    async loadScene(nodeId) {
      const mine = generation
      const memory = await ipc().invoke('memory:scene', { nodeId })
      if (mine !== generation || !sceneWatchers.has(nodeId)) return
      const { claims: lines, ...rest } = memory
      const claims = { ...get().claims }
      for (const id of get().scenes[nodeId]?.claimIds ?? []) delete claims[id]
      for (const line of lines) claims[line.id] = line
      set({
        claims,
        scenes: { ...get().scenes, [nodeId]: { ...rest, claimIds: lines.map((line) => line.id) } }
      })
    },

    async loadSheet(recordId, asOf) {
      const mine = generation
      const key = sheetKey(recordId, asOf)
      const sheet = await ipc().invoke('memory:sheet', { recordId, asOf })
      if (mine !== generation || !sheetWatchers.has(key)) return
      set({ sheets: { ...get().sheets, [key]: sheet } })
    },

    watchScene(nodeId) {
      sceneWatchers.set(nodeId, (sceneWatchers.get(nodeId) ?? 0) + 1)
      if (sceneWatchers.get(nodeId) === 1) get().loadScene(nodeId).catch(report)
      let released = false
      return () => {
        if (released) return
        released = true
        const left = (sceneWatchers.get(nodeId) ?? 1) - 1
        if (left > 0) {
          sceneWatchers.set(nodeId, left)
          return
        }
        sceneWatchers.delete(nodeId)
        const entry = get().scenes[nodeId]
        if (entry === undefined) return
        const claims = { ...get().claims }
        for (const id of entry.claimIds) delete claims[id]
        const scenes = { ...get().scenes }
        delete scenes[nodeId]
        set({ claims, scenes })
      }
    },

    watchSheet(recordId, asOf) {
      const key = sheetKey(recordId, asOf)
      const was = sheetWatchers.get(key)
      sheetWatchers.set(key, { recordId, asOf, count: (was?.count ?? 0) + 1 })
      if (was === undefined) get().loadSheet(recordId, asOf).catch(report)
      let released = false
      return () => {
        if (released) return
        released = true
        const entry = sheetWatchers.get(key)
        if (entry !== undefined && entry.count > 1) {
          sheetWatchers.set(key, { ...entry, count: entry.count - 1 })
          return
        }
        sheetWatchers.delete(key)
        const sheets = { ...get().sheets }
        delete sheets[key]
        set({ sheets })
      }
    },

    async readNow(nodeId) {
      try {
        await flushPendingSaves()
        return await ipc().invoke('memory:readNow', { nodeId, requestId: nextRequestId() })
      } catch (err) {
        report(err)
        return null
      }
    },

    async answerNotice(id, action) {
      const mine = generation
      try {
        const notices = await ipc().invoke('memory:answerNotice', { id, action })
        if (mine !== generation) return true
        set({ notices })
        // *Keep mine* wrote a Dismissed row.
        if (action === 'keepMine' || id.startsWith('detail:')) {
          useDismissedStore.getState().load().catch(report)
        }
        return true
      } catch (err) {
        report(err)
        return false
      }
    },

    async notRight(claimId, choice) {
      const mine = generation
      let result: NotRightResult
      try {
        result = await ipc().invoke('memory:notRight', {
          claimId,
          choice,
          requestId: nextRequestId()
        })
      } catch (err) {
        report(err)
        return null
      }
      if (mine !== generation || !result.ok) return result
      if (result.dismissed !== null) useDismissedStore.getState().add(result.dismissed)
      if (result.outcome !== 'moved') {
        // The line goes from every shown scene and sheet at once; main's `memory:changed` reads
        // them again.
        const claims = { ...get().claims }
        delete claims[claimId]
        const scenes = Object.fromEntries(
          Object.entries(get().scenes).map(([nodeId, entry]) => [
            nodeId,
            {
              ...entry,
              claimIds: entry.claimIds.filter((id) => id !== claimId),
              trueNow: entry.trueNow.filter((line) => line.claimId !== claimId)
            }
          ])
        )
        const sheets = Object.fromEntries(
          Object.entries(get().sheets).map(([key, sheet]) => [key, withoutLine(sheet, claimId)])
        )
        set({ claims, scenes, sheets })
      }
      return result
    },

    subscribe() {
      if (unsubscribers.length > 0) return
      unsubscribers = [
        ipc().on('memory:changed', ({ nodeIds, recordIds }) => {
          const nodes = new Set(nodeIds)
          const records = new Set(recordIds)
          refresh(
            (nodeId, entry) =>
              nodes.has(nodeId) || (entry !== undefined && namesAny(entry, records)),
            (recordId) => records.has(recordId)
          )
        }),
        ipc().on('names:changed', ({ nodeIds }) => {
          const nodes = new Set(nodeIds)
          refresh(
            (nodeId) => nodes.has(nodeId),
            () => false
          )
        }),
        ipc().on('record:changed', ({ roster }) => {
          if (!roster) return
          refresh(
            () => true,
            () => true
          )
        }),
        ipc().on('memory:statusChanged', (status) => set({ status })),
        ipc().on('memory:noticesChanged', (notices) => set({ notices }))
      ]
    },

    clear() {
      generation++
      sceneWatchers.clear()
      sheetWatchers.clear()
      set({ claims: {}, scenes: {}, sheets: {}, status: null, notices: [], rebuildOpen: null })
    }
  }
})

/** Closes the subscriptions and empties the store. For tests and project close. */
export function resetMemoryStore(): void {
  for (const stop of unsubscribers) stop()
  unsubscribers = []
  useMemoryStore.getState().clear()
}

/** A scene's memory while the calling view shows it (read on mount, released on unmount). */
export function useSceneMemory(nodeId: string | null): SceneEntry | undefined {
  useEffect(() => {
    if (nodeId === null) return
    return useMemoryStore.getState().watchScene(nodeId)
  }, [nodeId])
  return useMemoryStore((s) => (nodeId === null ? undefined : s.scenes[nodeId]))
}

/** A record's sheet "From the book, as of" while the calling view shows it. */
export function useSheetMemory(recordId: string, asOf: string | null): SheetMemory | undefined {
  useEffect(() => useMemoryStore.getState().watchSheet(recordId, asOf), [recordId, asOf])
  return useMemoryStore((s) => s.sheets[sheetKey(recordId, asOf)])
}
