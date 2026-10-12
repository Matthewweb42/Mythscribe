import { create } from 'zustand'
import { AI_DATA_SHARING, isFeatureAllowed, needsSwitchText } from '@shared/aiSettings'
import type { ContextEstimate, ContextProgress } from '@shared/contextLibrary'
import { applyFilingOps, writtenLines, type FilingReview } from '@shared/filing'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { type ReviewChatEntry, type ReviewChatState } from '@renderer/features/library/libraryStore'
import { decidedFilingReview } from '@renderer/features/library/uploadReview'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import type { ReviewDecision } from '@renderer/features/review/reviewDeckModel'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useFiledConflictStore } from '@renderer/features/thisScene/filedConflictStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { pageKey, usePageStore } from './pageStore'
import { useResearchStore } from './researchStore'

/**
 * Filing a Research page into Pinned (F-16.9, decision 6; story memory v2): the estimate, which
 * the author confirms (cost is visible before anything is sent), the AI pass with its progress
 * and Stop, the review on the deck with its chat, and Apply, after which one *Undo filing* stands
 * in the toast. The one owner of the filing under way; nothing reaches a record before `apply`.
 */
export type FilingFlow =
  | { stage: 'estimating'; nodeId: string }
  | { stage: 'confirm'; nodeId: string; estimate: ContextEstimate }
  | {
      stage: 'running'
      nodeId: string
      estimate: ContextEstimate
      requestId: string
      progress: ContextProgress | null
    }
  | {
      stage: 'review'
      review: FilingReview
      busy: boolean
      /** The author's decision per card; none means accepted (everything starts accepted). */
      decisions: Record<string, ReviewDecision>
    }
  | { stage: 'failed'; nodeId: string; message: string; nextStep: string }

/** The review chat beside the filing (F-9.9's, over a filing review): its Undo holds a filing. */
export interface FilingChatState extends Omit<ReviewChatState, 'undo'> {
  undo: { review: FilingReview; proposalId: string } | null
}

const emptyChat = (): FilingChatState => ({ entries: [], requestId: null, changed: [], undo: null })

interface FilingState {
  flow: FilingFlow | null
  chat: FilingChatState
  /** Starts filing a page: the estimate first. Refused with a toast while Use AI is off. */
  start: (nodeId: string) => Promise<void>
  /** The author accepted the estimate: the pass runs. */
  confirm: () => Promise<void>
  cancelRun: () => void
  /** Closes the estimate, the failure, or the review; nothing is written. */
  discard: () => void
  decide: (ids: readonly string[], decision: ReviewDecision) => void
  /** A conflict's pick: the upload's line (true) or Pinned's (false, the default). */
  pickLine: (itemId: string, lineId: string, use: boolean) => void
  /** Writes what the author kept, in one transaction. */
  apply: () => Promise<void>
  /** *Undo filing*: takes back the last filing where it is still as written. */
  undo: () => Promise<void>
  sendChat: (message: string) => Promise<void>
  cancelChat: () => void
  undoChat: () => void
  clear: () => void
}

let generation = 0
let counter = 0
let entryCounter = 0
let unsubscribe: (() => void) | null = null
const nextRequestId = (): string => `file-${Date.now().toString(36)}-${++counter}`

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

function chatEntry(
  role: ReviewChatEntry['role'],
  text: string,
  over: Partial<Pick<ReviewChatEntry, 'changes' | 'request' | 'failed'>> = {}
): ReviewChatEntry {
  return { id: ++entryCounter, role, text, changes: [], request: null, failed: false, ...over }
}

function settle(review: FilingReview, status: 'accepted' | 'acceptedPart' | 'rejected'): void {
  for (const id of review.proposalIds) void proposalStore.settle(id, status, null)
}

/** Reads the Pinned pages of `recordIds` again (main wrote them); a closed page is not loaded. */
function reloadPinned(recordIds: readonly string[]): Promise<void> {
  return usePageStore.getState().reload(recordIds.map((id) => pageKey({ kind: 'pinned', id })))
}

function onProgress(progress: ContextProgress): void {
  useFilingStore.setState((s) =>
    s.flow?.stage === 'running' ? { flow: { ...s.flow, progress } } : {}
  )
}

async function aiAllowed(): Promise<boolean> {
  const store = useAiSettingsStore.getState()
  if (store.settings === null) await store.load()
  const settings = useAiSettingsStore.getState().settings
  return settings !== null && isFeatureAllowed(settings, 'contextImport')
}

/** Whether Apply wrote everything the review held: every item and every line. */
function appliedWhole(review: FilingReview): boolean {
  return review.items.every(
    (item) => item.include && writtenLines(item).length === item.lines.length
  )
}

export const useFilingStore = create<FilingState>((set, get) => ({
  flow: null,
  chat: emptyChat(),

  async start(nodeId) {
    if (get().flow !== null) return
    if (!(await aiAllowed())) {
      toast.info(`${needsSwitchText(AI_DATA_SHARING.contextImport.label)} (Settings, AI tab).`)
      return
    }
    const mine = generation
    set({ flow: { stage: 'estimating', nodeId } })
    try {
      const estimate = await ipc().invoke('research:fileEstimate', { nodeId })
      if (mine !== generation || get().flow?.stage !== 'estimating') return
      set({ flow: { stage: 'confirm', nodeId, estimate } })
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
        nodeId: flow.nodeId,
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
          ipc().invoke('research:file', { nodeId: flow.nodeId, requestId })
        )
    } catch (err) {
      if (mine === generation) {
        set({
          flow: { stage: 'failed', nodeId: flow.nodeId, message: describeError(err), nextStep: '' }
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
                nodeId: flow.nodeId,
                message: result.message,
                nextStep: result.nextStep
              }
      })
      return
    }
    set({
      flow: { stage: 'review', review: result.review, busy: false, decisions: {} },
      chat: emptyChat()
    })
  },

  cancelRun() {
    const flow = get().flow
    if (flow?.stage === 'running') void useAiActivityStore.getState().cancel(flow.requestId)
  },

  discard() {
    const flow = get().flow
    if (flow === null || flow.stage === 'running') return
    if (flow.stage === 'review') {
      if (flow.busy) return
      settle(flow.review, 'rejected')
    }
    const requestId = get().chat.requestId
    if (requestId !== null) void useAiActivityStore.getState().cancel(requestId)
    set({ flow: null, chat: emptyChat() })
  },

  decide(ids, decision) {
    set((s) =>
      s.flow?.stage === 'review' && !s.flow.busy
        ? {
            flow: {
              ...s.flow,
              decisions: {
                ...s.flow.decisions,
                ...Object.fromEntries(ids.map((id) => [id, decision]))
              }
            }
          }
        : {}
    )
  },

  pickLine(itemId, lineId, use) {
    set((s) =>
      s.flow?.stage === 'review' && !s.flow.busy
        ? {
            flow: {
              ...s.flow,
              review: {
                ...s.flow.review,
                items: s.flow.review.items.map((item) =>
                  item.id !== itemId
                    ? item
                    : {
                        ...item,
                        lines: item.lines.map((line) =>
                          line.id === lineId && line.kind === 'conflict' ? { ...line, use } : line
                        )
                      }
                )
              }
            },
            chat: { ...s.chat, undo: null }
          }
        : {}
    )
  },

  async apply() {
    const flow = get().flow
    if (flow?.stage !== 'review' || flow.busy || get().chat.requestId !== null) return
    const mine = generation
    const review = decidedFilingReview(flow.review, flow.decisions)
    set({ flow: { ...flow, busy: true } })
    try {
      // Main rewrites Pinned pages: a sheet's unsaved typing is written first.
      await flushPendingSaves()
      const result = await ipc().invoke('research:applyFiling', { review })
      settle(review, appliedWhole(review) ? 'accepted' : 'acceptedPart')
      if (mine !== generation) return
      set({ flow: null, chat: emptyChat() })
      useResearchStore.getState().setFiled(review.docId, result.filedAt)
      await reloadPinned(result.recordIds)
      void useFiledConflictStore.getState().load()
      toast.successWithAction(
        `Filed ${plural(result.lines, 'line')} from “${review.docTitle}”: ` +
          `${plural(result.created, 'new record')}, ${plural(result.updated, 'record')} added to.`,
        { label: 'Undo filing', run: () => void get().undo() }
      )
    } catch (err) {
      if (mine === generation) {
        set((s) => (s.flow?.stage === 'review' ? { flow: { ...s.flow, busy: false } } : {}))
      }
      toast.error(describeError(err))
    }
  },

  async undo() {
    const mine = generation
    try {
      await flushPendingSaves()
      const result = await ipc().invoke('research:undoFiling', undefined)
      if (mine !== generation) return
      await useResearchStore.getState().load()
      await reloadPinned(result.recordIds)
      void useFiledConflictStore.getState().load()
      toast.success(
        result.kept === 0
          ? 'Filing undone.'
          : `Filing undone. ${plural(result.kept, 'change')} you made since stayed.`
      )
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async sendChat(message) {
    const flow = get().flow
    const text = message.trim()
    if (flow?.stage !== 'review' || flow.busy || get().chat.requestId !== null || text === '')
      return
    const mine = generation
    const requestId = nextRequestId()
    const history = get()
      .chat.entries.filter((entry) => !entry.failed)
      .map((entry) => ({ role: entry.role, content: entry.text }))
    set((s) => ({
      chat: { ...s.chat, requestId, entries: [...s.chat.entries, chatEntry('user', text)] }
    }))
    const fail = (reply: string): void =>
      set((s) => ({
        chat: {
          ...s.chat,
          requestId: null,
          entries: [...s.chat.entries, chatEntry('assistant', reply, { failed: true })]
        }
      }))
    let result
    try {
      result = await useAiActivityStore.getState().track(
        'reviewChat',
        requestId,
        ipc().invoke('research:reviewChat', {
          review: flow.review,
          message: text,
          history,
          requestId
        })
      )
    } catch (err) {
      if (mine === generation && get().chat.requestId === requestId) fail(describeError(err))
      return
    }
    const held = get()
    if (mine !== generation || held.chat.requestId !== requestId || held.flow?.stage !== 'review') {
      if (result.ok) void proposalStore.settle(result.proposalId, 'rejected', null)
      return
    }
    if (!result.ok) {
      fail(result.code === 'CANCELLED' ? 'Stopped.' : `${result.message} ${result.nextStep}`.trim())
      return
    }
    const before = held.flow.review
    const applied = applyFilingOps(before, result.ops)
    const landed = applied.changes.some((change) => !change.skipped)
    const reply =
      result.reply !== '' ? result.reply : landed ? 'Done.' : 'Nothing in the review changed.'
    // An include operation is a decision on the deck: the chat's word is the card's.
    const decisions = { ...held.flow.decisions }
    for (const item of applied.review.items) {
      const was = before.items.find((each) => each.id === item.id)
      if (was !== undefined && was.include !== item.include) {
        decisions[item.id] = item.include ? 'accepted' : 'skipped'
      }
    }
    set({
      flow: {
        ...held.flow,
        decisions,
        review: {
          ...applied.review,
          proposalIds: [...applied.review.proposalIds, result.proposalId]
        }
      },
      chat: {
        entries: [
          ...held.chat.entries,
          chatEntry('assistant', reply, {
            changes: applied.changes,
            request: {
              model: result.model,
              costUsd: result.costUsd,
              usage: result.usage,
              cached: result.cached
            }
          })
        ],
        requestId: null,
        changed: landed
          ? [...new Set(applied.changes.flatMap((change) => change.itemIds))]
          : held.chat.changed,
        undo: landed ? { review: before, proposalId: result.proposalId } : held.chat.undo
      }
    })
  },

  cancelChat() {
    const requestId = get().chat.requestId
    if (requestId !== null) void useAiActivityStore.getState().cancel(requestId)
  },

  undoChat() {
    const { flow, chat } = get()
    if (flow?.stage !== 'review' || flow.busy || chat.undo === null || chat.requestId !== null)
      return
    // The restored review never held the undone answer's proposal, so it is settled here.
    void proposalStore.settle(chat.undo.proposalId, 'rejected', null)
    set({
      flow: { ...flow, review: chat.undo.review },
      chat: {
        ...chat,
        changed: [],
        undo: null,
        entries: [...chat.entries, chatEntry('assistant', 'Undid the last change.')]
      }
    })
  },

  clear() {
    generation++
    const flow = get().flow
    if (flow?.stage === 'review') settle(flow.review, 'rejected')
    if (flow?.stage === 'running') void useAiActivityStore.getState().cancel(flow.requestId)
    const requestId = get().chat.requestId
    if (requestId !== null) void useAiActivityStore.getState().cancel(requestId)
    set({ flow: null, chat: emptyChat() })
  }
}))

/** Back to nothing under way, the progress subscription dropped. For tests and project close. */
export function resetFilingStore(): void {
  useFilingStore.getState().clear()
  unsubscribe?.()
  unsubscribe = null
}
