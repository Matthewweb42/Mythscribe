import { useEffect } from 'react'
import { create } from 'zustand'
import type {
  CardNotRight,
  ClaimView,
  KnowsGrid,
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
 * and pushes the status and the notices whole. F-16.20: the active draft's card lines by scene
 * (`cardLines`, what the Outline and the cork board show in grey), read on open and again when a
 * reading moved a scene. Loaded on a v2 open; reset in tests.
 *
 * F-16.22: the Book's who-knows-what grids by as-of scene (`knows`, `useKnowsGrid`), read while
 * shown like the sheets and read again on any `memory:changed` (a reading, a knew-before mark,
 * *Split*, *Not a secret*), and the author's answers on secrets: *Knew before the book* and its
 * *Remove*, *Split*, *Not a secret* (their Dismissed rows join the list at once).
 */

/** A scene's memory as stored here: its lines by id. */
export type SceneEntry = Omit<SceneMemory, 'claims'> & { claimIds: string[] }

interface MemoryState {
  claims: Record<string, ClaimView>
  scenes: Record<string, SceneEntry>
  /** By `sheetKey(recordId, asOf)`. */
  sheets: Record<string, SheetMemory>
  /** F-16.22: the who-knows-what grids, by `knowsKey(asOf)`. */
  knows: Record<string, KnowsGrid>
  status: MemoryStatus | null
  notices: MemoryNotice[]
  /** F-16.20: each scene's card line (the AI's one-line map of it), by node. */
  cardLines: Record<string, string>
  /**
   * The *Rebuild memory* dialog (F-16.19): closed, opened to start one (price first), or opened on
   * what the last one changed (the activity bar's Open, the Book tab's *See what changed*).
   */
  rebuildOpen: 'start' | 'summary' | null
  setRebuildOpen: (open: 'start' | 'summary' | null) => void
  /** The status, the notices and the card lines (what a v2 open loads). */
  load: () => Promise<void>
  loadCardLines: () => Promise<void>
  loadScene: (nodeId: string) => Promise<void>
  loadSheet: (recordId: string, asOf: string | null) => Promise<void>
  loadKnows: (asOf: string | null) => Promise<void>
  /** Counts a view showing the scene and reads it; answers the release. */
  watchScene: (nodeId: string) => () => void
  watchSheet: (recordId: string, asOf: string | null) => () => void
  watchKnows: (asOf: string | null) => () => void
  /**
   * F-16.22: *Knew before the book* (`knew: true`) or its *Remove*; main's `memory:changed` reads
   * the grids, scenes and sheets again. Answers whether main took it.
   */
  knewBefore: (secretId: string, recordId: string, knew: boolean) => Promise<boolean>
  /** F-16.22: *Split* on a merged reveal; answers the new secret's or thread's id, or null. */
  splitTopic: (topicQuoteId: string) => Promise<string | null>
  /** F-16.22: *Not a secret* / *Not a thread* on an AI-made topic; answers whether it went. */
  topicNotRight: (recordId: string) => Promise<boolean>
  /**
   * *Read now* (F-16.16): pending saves flushed first, then the scene read ahead of the queue.
   * Answers main's result, or null when the call itself failed (toasted).
   */
  readNow: (nodeId: string) => Promise<ReadNowResult | null>
  /** A notice's button; answers whether main took it. */
  answerNotice: (id: string, action: MemoryNoticeAction) => Promise<boolean>
  /** *Not right* on an AI line; the line goes from what is shown at once. */
  notRight: (claimId: string, choice: NotRightChoice) => Promise<NotRightResult | null>
  /**
   * *Not right* on a value the scene's card gives; main's `memory:changed` reads the scene again.
   * Answers whether main took it.
   */
  cardNotRight: (input: CardNotRight) => Promise<boolean>
  /** Opens the subscriptions (idempotent); call it where a v2 project opens. */
  subscribe: () => void
  clear: () => void
}

export const sheetKey = (recordId: string, asOf: string | null): string =>
  `${recordId}|${asOf ?? ''}`

/** A grid's key: its as-of scene, or the end of the book. */
export const knowsKey = (asOf: string | null): string => asOf ?? ''

let generation = 0
let counter = 0
const nextRequestId = (): string => `mem-${Date.now().toString(36)}-${++counter}`
const sceneWatchers = new Map<string, number>()
const sheetWatchers = new Map<string, { recordId: string; asOf: string | null; count: number }>()
const knowsWatchers = new Map<string, { asOf: string | null; count: number }>()
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

/** Whether a shown scene's memory names any of these records (its secrets and holders too). */
function namesAny(entry: SceneEntry, recordIds: ReadonlySet<string>): boolean {
  return (
    entry.here.some((chip) => recordIds.has(chip.recordId)) ||
    entry.mentioned.some((chip) => recordIds.has(chip.recordId)) ||
    entry.trueNow.some((line) => recordIds.has(line.recordId)) ||
    entry.secrets.touched.some(
      ({ secret }) =>
        recordIds.has(secret.recordId) || secret.cells.some((cell) => recordIds.has(cell.knowerId))
    ) ||
    entry.secrets.tension.some(
      (line) => recordIds.has(line.secretId) || recordIds.has(line.recordId)
    )
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
    // The grids hold every secret and knower: any change may move them.
    for (const grid of knowsWatchers.values()) get().loadKnows(grid.asOf).catch(report)
  }

  return {
    claims: {},
    scenes: {},
    sheets: {},
    knows: {},
    status: null,
    notices: [],
    cardLines: {},
    rebuildOpen: null,

    setRebuildOpen(open) {
      if (get().rebuildOpen !== open) set({ rebuildOpen: open })
    },

    async load() {
      const mine = generation
      const [status, notices, cardLines] = await Promise.all([
        ipc().invoke('memory:status', undefined),
        ipc().invoke('memory:notices', undefined),
        ipc().invoke('memory:cardLines', undefined)
      ])
      if (mine === generation) set({ status, notices, cardLines })
    },

    async loadCardLines() {
      const mine = generation
      const cardLines = await ipc().invoke('memory:cardLines', undefined)
      if (mine === generation) set({ cardLines })
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

    async loadKnows(asOf) {
      const mine = generation
      const key = knowsKey(asOf)
      const grid = await ipc().invoke('memory:knows', { asOf })
      if (mine !== generation || !knowsWatchers.has(key)) return
      set({ knows: { ...get().knows, [key]: grid } })
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

    watchKnows(asOf) {
      const key = knowsKey(asOf)
      const was = knowsWatchers.get(key)
      knowsWatchers.set(key, { asOf, count: (was?.count ?? 0) + 1 })
      if (was === undefined) get().loadKnows(asOf).catch(report)
      let released = false
      return () => {
        if (released) return
        released = true
        const entry = knowsWatchers.get(key)
        if (entry !== undefined && entry.count > 1) {
          knowsWatchers.set(key, { ...entry, count: entry.count - 1 })
          return
        }
        knowsWatchers.delete(key)
        const knows = { ...get().knows }
        delete knows[key]
        set({ knows })
      }
    },

    async knewBefore(secretId, recordId, knew) {
      try {
        await ipc().invoke('memory:knewBefore', { secretId, recordId, knew })
        return true
      } catch (err) {
        report(err)
        return false
      }
    },

    async splitTopic(topicQuoteId) {
      const mine = generation
      try {
        const result = await ipc().invoke('memory:splitTopic', { topicQuoteId })
        if (mine === generation) useDismissedStore.getState().add(result.dismissed)
        return result.recordId
      } catch (err) {
        report(err)
        return null
      }
    },

    async topicNotRight(recordId) {
      const mine = generation
      try {
        const result = await ipc().invoke('memory:topicNotRight', { recordId })
        if (mine === generation) {
          for (const row of result.dismissed) useDismissedStore.getState().add(row)
        }
        return true
      } catch (err) {
        report(err)
        return false
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

    async cardNotRight(input) {
      try {
        const row = await ipc().invoke('memory:cardNotRight', input)
        useDismissedStore.getState().add(row)
        return true
      } catch (err) {
        report(err)
        return false
      }
    },

    subscribe() {
      if (unsubscribers.length > 0) return
      unsubscribers = [
        ipc().on('memory:changed', ({ nodeIds, recordIds }) => {
          // A reading (or an edit beside a card) may have moved a scene's card line.
          if (nodeIds.length > 0) get().loadCardLines().catch(report)
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
      knowsWatchers.clear()
      set({
        claims: {},
        scenes: {},
        sheets: {},
        knows: {},
        status: null,
        notices: [],
        cardLines: {},
        rebuildOpen: null
      })
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

/** F-16.22: the who-knows-what grid as of a scene (null: the end of the book) while shown. */
export function useKnowsGrid(asOf: string | null): KnowsGrid | undefined {
  useEffect(() => useMemoryStore.getState().watchKnows(asOf), [asOf])
  return useMemoryStore((s) => s.knows[knowsKey(asOf)])
}
