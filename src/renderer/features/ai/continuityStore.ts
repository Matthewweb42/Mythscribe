import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import type { AiUsage } from '@shared/ai'
import type { ContinuityFinding } from '@shared/continuity'
import type { AiContinuityResult } from '@shared/ipc/contract'
import { applyFixToPassage } from '@renderer/features/editor/applyFix'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useAiActivityStore } from './aiActivityStore'

/** The on-demand check in flight: which scene, and the id Stop cancels it by. */
export interface ContinuityCheck {
  nodeId: string
  requestId: string
}

/** What the last on-demand check answered, for the line under the button. */
export interface ContinuityOutcome {
  nodeId: string
  /** Open findings of the scene after the check. */
  found: number
  /** References the prompt carried; 0 means nothing to check against, and no request was made. */
  references: number
  truncated: boolean
  /** Findings main dropped (a citation did not hold, or it was dismissed before). */
  dropped: number
  model: string
  costUsd: number
  usage: AiUsage
  cached: boolean
}

/**
 * The one owner of the project's open continuity findings in the renderer (F-13.4), normalized
 * by id in the order `continuity:list` answers (reading order of the scenes, oldest first within
 * one). Main owns the truth: `load` reads the list when the project opens and opens the one
 * `continuity:changed` subscription, and every event re-reads the list, so a background run adds
 * to the count without anything else moving. `check` is `Check this scene`: it flushes the
 * autosave (main reads the saved row), sends `ai:continuity` tracked in the activity store
 * (F-5.10: `stop` cancels it and a `CANCELLED` reply is silent), and replaces that scene's
 * findings with the answer. `apply` puts a finding's fix in the text through the same path as an
 * editor's-notes fix (`applyFixToPassage`: AI-origin marked from the proposal, F-14.6)
 * and records `applied` (main settles the run's proposal, F-14.5, with its last open finding);
 * `settle` with `dismissed` is "Changed in the
 * story". A settled finding leaves the store, since only open ones are held.
 */
interface ContinuityState {
  byId: Record<string, ContinuityFinding>
  /** Every open finding's id, in the order received. */
  ids: string[]
  loaded: boolean
  /** Whether the assistant panel shows the findings view instead of the chat. Session state. */
  viewOpen: boolean
  /** The on-demand check in flight, if any. */
  running: ContinuityCheck | null
  outcome: ContinuityOutcome | null
  /** Why the last check failed, with the next step; null once another starts. */
  error: string | null
  /** Findings whose quote was no longer in the scene when Apply looked for it. */
  gone: Record<string, true>
  load: () => Promise<void>
  /** Forgets the project's findings and stops a check in flight (project close). */
  clear: () => void
  setViewOpen: (open: boolean) => void
  /** Asks for a check of `nodeId`; ignored while one is in flight. */
  check: (nodeId: string) => void
  /** Cancels the check in flight. */
  stop: () => void
  /** Records a finding as dismissed ("changed in the story") or applied, and drops it here. */
  settle: (id: string, status: 'dismissed' | 'applied') => Promise<void>
  /** Replaces the finding's passage with its fix in `editor` (the finding's own scene), then settles it applied. */
  apply: (id: string, editor: Editor) => Promise<void>
}

let counter = 0
/** Bumped by every load() and clear() so an answer for a superseded read or a closed project is dropped. */
let generation = 0
/** The subscription to main's finding writes; one for the renderer, opened by the first load. */
let unsubscribe: (() => void) | null = null

const nextRequestId = (): string => `cn-${Date.now().toString(36)}-${++counter}`

function normalized(findings: readonly ContinuityFinding[]): {
  byId: Record<string, ContinuityFinding>
  ids: string[]
} {
  const byId: Record<string, ContinuityFinding> = {}
  const ids: string[] = []
  for (const finding of findings) {
    if (finding.status !== 'open' || byId[finding.id] !== undefined) continue
    byId[finding.id] = finding
    ids.push(finding.id)
  }
  return { byId, ids }
}

/** Reads the list and replaces what is held; a superseded or failed read changes nothing. */
async function refetch(): Promise<void> {
  const mine = ++generation
  const findings = await ipc().invoke('continuity:list', undefined)
  if (mine !== generation) return
  const next = normalized(findings)
  const gone: Record<string, true> = {}
  for (const id of Object.keys(useContinuityStore.getState().gone)) {
    if (next.byId[id] !== undefined) gone[id] = true
  }
  useContinuityStore.setState({ ...next, gone, loaded: true })
}

/** The scene's findings replaced by `findings`, in the scene's place in the order (or at the end). */
function withScene(
  state: Pick<ContinuityState, 'byId' | 'ids'>,
  nodeId: string,
  findings: readonly ContinuityFinding[]
): Pick<ContinuityState, 'byId' | 'ids'> {
  const fresh = normalized(findings)
  const at = state.ids.findIndex((id) => state.byId[id]?.nodeId === nodeId)
  const kept = state.ids.filter(
    (id) => state.byId[id]?.nodeId !== nodeId && fresh.byId[id] === undefined
  )
  const before =
    at === -1 ? kept.length : state.ids.slice(0, at).filter((id) => kept.includes(id)).length
  const byId: Record<string, ContinuityFinding> = { ...fresh.byId }
  for (const id of kept) {
    const finding = state.byId[id]
    if (finding !== undefined) byId[id] = finding
  }
  return { byId, ids: [...kept.slice(0, before), ...fresh.ids, ...kept.slice(before)] }
}

function drop(id: string): void {
  const { byId, ids, gone } = useContinuityStore.getState()
  if (byId[id] === undefined) return
  const nextById = { ...byId }
  delete nextById[id]
  const nextGone = { ...gone }
  delete nextGone[id]
  useContinuityStore.setState({
    byId: nextById,
    ids: ids.filter((other) => other !== id),
    gone: nextGone
  })
}

function settleCheck(requestId: string, result: AiContinuityResult): void {
  const state = useContinuityStore.getState()
  // Stopped or the project closed meanwhile: main stored what it found and says so by event.
  if (state.running?.requestId !== requestId) return
  if (!result.ok) {
    useContinuityStore.setState({
      running: null,
      error: result.code === 'CANCELLED' ? null : `${result.message} ${result.nextStep}`.trim()
    })
    return
  }
  const { nodeId } = state.running
  const next = withScene(state, nodeId, result.findings)
  useContinuityStore.setState({
    ...next,
    running: null,
    outcome: {
      nodeId,
      found: next.ids.filter((id) => next.byId[id]?.nodeId === nodeId).length,
      references: result.references,
      truncated: result.truncated,
      dropped: result.dropped,
      model: result.model,
      costUsd: result.costUsd,
      usage: result.usage,
      cached: result.cached
    }
  })
}

function failCheck(requestId: string, message: string): void {
  if (useContinuityStore.getState().running?.requestId !== requestId) return
  useContinuityStore.setState({ running: null, error: message })
}

export const useContinuityStore = create<ContinuityState>((set, get) => ({
  byId: {},
  ids: [],
  loaded: false,
  viewOpen: false,
  running: null,
  outcome: null,
  error: null,
  gone: {},

  async load() {
    unsubscribe ??= ipc().on('continuity:changed', () => {
      // A failed re-read keeps the list as it was; the next event reads again.
      refetch().catch(() => undefined)
    })
    await refetch()
  },

  clear() {
    generation++
    const { running } = get()
    if (running !== null) void useAiActivityStore.getState().cancel(running.requestId)
    set({
      byId: {},
      ids: [],
      loaded: false,
      viewOpen: false,
      running: null,
      outcome: null,
      error: null,
      gone: {}
    })
  },

  setViewOpen(open) {
    if (get().viewOpen !== open) set({ viewOpen: open })
  },

  check(nodeId) {
    if (get().running !== null) return
    const requestId = nextRequestId()
    set({ running: { nodeId, requestId }, outcome: null, error: null })
    // Main reads the saved row, so the author's unsaved typing is written first.
    useDocumentStore
      .getState()
      .flush()
      .then(() =>
        useAiActivityStore
          .getState()
          .track('continuity', requestId, ipc().invoke('ai:continuity', { nodeId, requestId }))
      )
      .then(
        (result) => settleCheck(requestId, result),
        (err: unknown) => failCheck(requestId, describeError(err))
      )
  },

  stop() {
    const { running } = get()
    if (running === null) return
    // The button frees now, so the author can ask again at once; the cancelled reply finds no check.
    void useAiActivityStore.getState().cancel(running.requestId)
    set({ running: null })
  },

  async settle(id, status) {
    const finding = get().byId[id]
    if (finding === undefined) return
    try {
      await ipc().invoke('continuity:settle', { id, status })
    } catch (err) {
      toast.error(describeError(err))
      return
    }
    drop(id)
  },

  async apply(id, editor) {
    const finding = get().byId[id]
    if (finding === undefined || get().gone[id] === true || editor.isDestroyed) return
    const { fix, proposalId } = finding
    if (fix === null || proposalId === null) return
    const outcome = applyFixToPassage(editor, finding.quote, fix, proposalId)
    // A rewrite in progress owns the editor's target: nothing changed.
    if (outcome === 'busy') return
    if (outcome === 'gone') {
      set({ gone: { ...get().gone, [id]: true } })
      return
    }
    // Main settles the run's proposal (F-14.5) with its last open finding.
    await get().settle(id, 'applied')
  }
}))

/** The open findings in the order received. */
export function useContinuityFindings(): ContinuityFinding[] {
  const byId = useContinuityStore((s) => s.byId)
  const ids = useContinuityStore((s) => s.ids)
  const findings: ContinuityFinding[] = []
  for (const id of ids) {
    const finding = byId[id]
    if (finding !== undefined) findings.push(finding)
  }
  return findings
}

/** Empties the store, drops the subscription, and restarts the id counter. For tests only. */
export function resetContinuityStore(): void {
  unsubscribe?.()
  unsubscribe = null
  generation++
  counter = 0
  useContinuityStore.setState({
    byId: {},
    ids: [],
    loaded: false,
    viewOpen: false,
    running: null,
    outcome: null,
    error: null,
    gone: {}
  })
}
