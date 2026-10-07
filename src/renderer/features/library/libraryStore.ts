import { create } from 'zustand'
import { AI_DATA_SHARING, isFeatureAllowed, needsSwitchText } from '@shared/aiSettings'
import {
  CONTEXT_FILE_MAX_BYTES,
  reviewHasChanges,
  splitReviewEntity,
  writesField,
  type ContextAddResult,
  type ContextEstimate,
  type ContextFile,
  type ContextProgress,
  type ContextReview
} from '@shared/contextLibrary'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * Where an upload stands (F-9.8): the estimate being worked out, then shown for the author to
 * confirm, the AI pass running with its progress, the review the author edits before Apply, or a
 * failure with its next step. Null while nothing is being sorted. Nothing reaches the story bible
 * before `apply`.
 */
export type LibraryFlow =
  | { stage: 'estimating'; fileIds: string[] }
  | { stage: 'confirm'; fileIds: string[]; estimate: ContextEstimate }
  | {
      stage: 'running'
      fileIds: string[]
      estimate: ContextEstimate
      requestId: string
      progress: ContextProgress | null
    }
  | { stage: 'review'; review: ContextReview; busy: boolean }
  | { stage: 'failed'; fileIds: string[]; message: string; nextStep: string }

/**
 * The context library in the renderer (F-9.8): the uploaded files as main lists them, and the one
 * upload being sorted. Every entry point — the wizard step, the story-bible tabs' "Upload
 * context…", a drop on the window, and the Library tab — goes through `add`/`addDropped` and then
 * `sort`, so the estimate, the confirm, and the review are the same wherever the files came from.
 */
interface LibraryState {
  files: ContextFile[]
  loaded: boolean
  flow: LibraryFlow | null
  load: () => Promise<void>
  clear: () => void
  /** The OS dialog's picks, for the new-project wizard (no project yet, nothing stored). */
  choosePaths: () => Promise<string[]>
  /** Adds `paths`, or what the OS dialog picks; then offers to sort what is new or changed. */
  add: (paths?: string[]) => Promise<void>
  /** Replaces one stored file with a newer version the author picks ("Update…"). */
  update: (id: string) => Promise<void>
  /** Adds files dropped on the window. */
  addDropped: (files: readonly File[]) => Promise<void>
  /** Opens a stored original in the OS's app for it. */
  open: (id: string) => Promise<void>
  /** Starts sorting: the estimate first, which the author confirms. Refused with a toast while AI is off. */
  sort: (fileIds: readonly string[]) => Promise<void>
  /** The author accepted the estimate: the pass runs. */
  confirm: () => Promise<void>
  /** Stops a running pass. */
  cancelRun: () => void
  /** Closes the estimate, the failure, or the review; nothing is written. */
  discard: () => void
  /** Edits the review under way (a pure change; ignored outside the review). */
  edit: (change: (review: ContextReview) => ContextReview) => void
  /** Splits a merged sheet back into one per name. */
  split: (itemId: string) => void
  /** Writes the review in one transaction. */
  apply: () => Promise<void>
}

let generation = 0
let counter = 0
let unsubscribe: (() => void) | null = null
const nextRequestId = (): string => `lib-${Date.now().toString(36)}-${++counter}`

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

function onProgress(progress: ContextProgress): void {
  useLibraryStore.setState((s) =>
    s.flow?.stage === 'running' ? { flow: { ...s.flow, progress } } : {}
  )
}

/** Settles the pass's proposals (F-14.5): what the author kept, or nothing. */
function settle(review: ContextReview, status: 'accepted' | 'acceptedPart' | 'rejected'): void {
  for (const id of review.proposalIds) void proposalStore.settle(id, status, null)
}

/** Whether the review was applied whole: every sheet, field, detail, picture, and note included. */
function appliedWhole(review: ContextReview): boolean {
  return (
    review.notes.include &&
    review.entities.every(
      (item) =>
        item.include &&
        item.includeDetails &&
        item.tag !== false &&
        item.fields.every(writesField) &&
        item.images.every((image) => image.include)
    )
  )
}

/**
 * Whether Use AI and the feature's toggle allow sorting. A project created a moment ago (the
 * wizard's step adds its files right away) may not have its AI settings loaded yet, so they are
 * loaded first rather than read as off.
 */
async function aiAllowed(): Promise<boolean> {
  const store = useAiSettingsStore.getState()
  if (store.settings === null) await store.load()
  const settings = useAiSettingsStore.getState().settings
  return settings !== null && isFeatureAllowed(settings, 'contextImport')
}

/** The files an add leaves to sort: the new or changed text, and images to match. */
function sortable(result: ContextAddResult): string[] {
  const states = new Map(result.files.map((file) => [file.id, file.state]))
  return result.changed.filter((id) => {
    const state = states.get(id)
    return state === 'new' || state === 'changed' || state === 'reference'
  })
}

export const useLibraryStore = create<LibraryState>((set, get) => {
  /** What every add does with main's answer: the list, a line about it, and the offer to sort. */
  const afterAdd = async (result: ContextAddResult): Promise<void> => {
    set({ files: result.files })
    for (const skipped of result.skipped) toast.warning(`${skipped.name}: ${skipped.reason}`)
    const added = result.changed.length
    if (added === 0) {
      if (result.unchanged > 0) toast.info('Those files are already in the Library, unchanged.')
      return
    }
    const ids = sortable(result)
    if (ids.length > 0 && !(await aiAllowed())) {
      toast.info(
        `Added ${plural(added, 'file')} to the Library. ` +
          `${needsSwitchText(AI_DATA_SHARING.contextImport.label)} (Settings, AI tab) to sort them into the story bible.`
      )
      return
    }
    toast.success(`Added ${plural(added, 'file')} to the Library.`)
    if (ids.length > 0) await get().sort(ids)
  }

  return {
    files: [],
    loaded: false,
    flow: null,

    async load() {
      const mine = ++generation
      const files = await ipc().invoke('library:list', undefined)
      if (mine === generation) set({ files, loaded: true })
    },

    clear() {
      generation++
      const flow = get().flow
      if (flow?.stage === 'review') settle(flow.review, 'rejected')
      if (flow?.stage === 'running') void useAiActivityStore.getState().cancel(flow.requestId)
      set({ files: [], loaded: false, flow: null })
    },

    async choosePaths() {
      return ipc().invoke('library:choose', undefined)
    },

    async add(paths) {
      const mine = generation
      const result = await ipc().invoke('library:add', paths === undefined ? {} : { paths })
      if (result === null || mine !== generation) return
      await afterAdd(result)
    },

    async update(id) {
      const mine = generation
      const result = await ipc().invoke('library:add', { replaceId: id })
      if (result === null || mine !== generation) return
      await afterAdd(result)
    },

    async addDropped(dropped) {
      const mine = generation
      const files: { name: string; data: Uint8Array<ArrayBuffer> }[] = []
      for (const file of dropped) {
        if (file.size > CONTEXT_FILE_MAX_BYTES) {
          toast.warning(`${file.name}: The file is larger than 25 MB.`)
          continue
        }
        files.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })
      }
      if (files.length === 0) return
      const result = await ipc().invoke('library:addData', { files })
      if (mine !== generation) return
      await afterAdd(result)
    },

    async open(id) {
      await ipc().invoke('library:open', { id })
    },

    async sort(fileIds) {
      if (fileIds.length === 0 || get().flow !== null) return
      if (!(await aiAllowed())) {
        toast.info(`${needsSwitchText(AI_DATA_SHARING.contextImport.label)} (Settings, AI tab).`)
        return
      }
      const mine = generation
      const ids = [...fileIds]
      set({ flow: { stage: 'estimating', fileIds: ids } })
      try {
        const estimate = await ipc().invoke('library:estimate', { fileIds: ids })
        if (mine !== generation || get().flow?.stage !== 'estimating') return
        set({ flow: { stage: 'confirm', fileIds: ids, estimate } })
        // Nothing to send (images only, or nothing changed since the last sort): no money is
        // asked for, so there is nothing to confirm.
        if (estimate.chunks === 0) await get().confirm()
      } catch (err) {
        if (mine === generation) set({ flow: null })
        toast.error(describeError(err))
      }
    },

    async confirm() {
      const flow = get().flow
      if (flow?.stage !== 'confirm') return
      unsubscribe ??= ipc().on('library:progress', onProgress)
      const mine = generation
      const requestId = nextRequestId()
      set({
        flow: {
          stage: 'running',
          fileIds: flow.fileIds,
          estimate: flow.estimate,
          requestId,
          progress: null
        }
      })
      let result
      try {
        result = await useAiActivityStore
          .getState()
          .track(
            'contextImport',
            requestId,
            ipc().invoke('library:process', { fileIds: flow.fileIds, requestId })
          )
      } catch (err) {
        if (mine === generation) {
          set({
            flow: {
              stage: 'failed',
              fileIds: flow.fileIds,
              message: describeError(err),
              nextStep: ''
            }
          })
        }
        return
      }
      const held = get().flow
      if (mine !== generation || held?.stage !== 'running' || held.requestId !== requestId) {
        if (result.ok) settle(result.review, 'rejected')
        return
      }
      if (!result.ok) {
        set({
          flow:
            result.code === 'CANCELLED'
              ? null
              : {
                  stage: 'failed',
                  fileIds: flow.fileIds,
                  message: result.message,
                  nextStep: result.nextStep
                }
        })
        return
      }
      if (!reviewHasChanges(result.review)) {
        // Nothing new for the story bible: the files are marked sorted and the author told so.
        set({ flow: { stage: 'review', review: result.review, busy: true } })
        try {
          const applied = await ipc().invoke('library:apply', { review: result.review })
          settle(result.review, 'rejected')
          if (mine === generation) set({ files: applied.files, flow: null })
          toast.info('Nothing new to add to the story bible from those files.')
        } catch (err) {
          if (mine === generation)
            set({ flow: { stage: 'review', review: result.review, busy: false } })
          toast.error(describeError(err))
        }
        return
      }
      set({ flow: { stage: 'review', review: result.review, busy: false } })
    },

    cancelRun() {
      const flow = get().flow
      if (flow?.stage !== 'running') return
      void useAiActivityStore.getState().cancel(flow.requestId)
    },

    discard() {
      const flow = get().flow
      if (flow === null || flow.stage === 'running') return
      if (flow.stage === 'review') {
        if (flow.busy) return
        settle(flow.review, 'rejected')
      }
      set({ flow: null })
    },

    edit(change) {
      set((s) =>
        s.flow?.stage === 'review' && !s.flow.busy
          ? { flow: { ...s.flow, review: change(s.flow.review) } }
          : {}
      )
    },

    split(itemId) {
      const entities = useEntityStore.getState()
      const existing = entities.ids.flatMap((id) => {
        const entity = entities.byId[id]
        return entity ? [entity] : []
      })
      get().edit((review) => splitReviewEntity(review, itemId, existing))
    },

    async apply() {
      const flow = get().flow
      if (flow?.stage !== 'review' || flow.busy) return
      const mine = generation
      const review = flow.review
      set({ flow: { ...flow, busy: true } })
      try {
        const result = await ipc().invoke('library:apply', { review })
        settle(review, appliedWhole(review) ? 'accepted' : 'acceptedPart')
        if (mine !== generation) return
        const entityStore = useEntityStore.getState()
        for (const entity of result.entities) entityStore.merge(entity)
        set({ files: result.files, flow: null })
        const parts = [
          `${plural(result.created, 'sheet')} created`,
          `${plural(result.updated, 'sheet')} updated`
        ]
        if (result.notes) parts.push('Project notes updated')
        toast.success(`Story bible: ${parts.join(', ')}.`)
      } catch (err) {
        if (mine === generation) {
          set((s) => (s.flow?.stage === 'review' ? { flow: { ...s.flow, busy: false } } : {}))
        }
        toast.error(describeError(err))
      }
    }
  }
})

/** Back to nothing loaded, the progress subscription dropped. For tests. */
export function resetLibraryStore(): void {
  generation++
  unsubscribe?.()
  unsubscribe = null
  useLibraryStore.setState({ files: [], loaded: false, flow: null })
}
