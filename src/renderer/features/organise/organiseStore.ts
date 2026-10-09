import { create } from 'zustand'
import { DEFAULT_ASSISTANT_MODE, type AssistantMode } from '@shared/aiSettings'
import type { AiUsage } from '@shared/ai'
import {
  candidatesKey,
  needsAsk,
  worthOffering,
  type OrganiseAction,
  type OrganiseCandidates,
  type OrganiseChange,
  type OrganisePlan,
  type OrganiseRequest
} from '@shared/organise'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import type { ReviewDecision } from '@renderer/features/review/reviewDeckModel'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { applyOrganiseAction } from './organiseApply'

/**
 * Organise (F-9.10): one run at a time, its plan, and where each change stands. The plan screen
 * (`OrganiseDialog`, one decision at a time on the review deck since 2026-10-08) reads it; the
 * Organise button, the quiet offer, and the chat (agent.v4's organise request) start it. The run
 * follows the chat mode it was started in (F-5.21): in Ask every change waits for the author's
 * Accept and is applied with "Apply accepted" (or on reaching the end); in Auto every change that can be undone is
 * applied as soon as the plan is in, each with Undo, and one Undo takes the whole reorganisation
 * back, while merges, deletions, and new categories still wait for Apply (`needsAsk`); in Plan
 * the screen only describes. F-9.15: every story-bible change is logged in Changes under the
 * plan's run, and its Undo here is the log's (one owner); notes and binder changes keep an undo
 * that lives in memory for the session, like the chat's.
 *
 * The local pass (`organise:candidates`) is kept here too: the quiet offer shows it after an
 * upload is applied or as duplicates build up, until the author waves that set of findings away.
 */

export type OrganiseChangeStatus = 'pending' | 'applying' | 'applied' | 'undone' | 'failed'

export interface OrganiseChangeView {
  change: OrganiseChange
  status: OrganiseChangeStatus
  /** The author's decision on the review deck; every change starts pending (nothing is kept unasked). */
  decision: ReviewDecision
  /** Why applying or undoing it failed, or why it was skipped. */
  error: string | null
}

export type OrganisePhase = 'idle' | 'running' | 'ready' | 'failed'

interface OrganiseState {
  /** Whether the plan screen is showing. */
  open: boolean
  phase: OrganisePhase
  request: OrganiseRequest | null
  /** The chat mode the run was started in. */
  mode: AssistantMode
  plan: OrganisePlan | null
  views: Record<string, OrganiseChangeView>
  /** Change ids in the plan's order. */
  order: string[]
  requestId: string | null
  proposalId: string | null
  costUsd: number
  usage: AiUsage | null
  model: string | null
  cached: boolean
  error: string | null
  /** True while changes are being applied or undone. */
  busy: boolean
  /** The change whose edit form is open (the deck's Edit), or null. */
  editingId: string | null
  /** The local pass's findings, or null before the first look. */
  candidates: OrganiseCandidates | null
  /** The findings key the author waved away; the offer stays hidden while it is the same. */
  dismissedKey: string | null

  /** Opens the plan screen and asks the AI for a plan (the chat mode decides how it lands). */
  start: (request: OrganiseRequest) => Promise<void>
  /** Stops the run in flight (`ai:cancel`). */
  stop: () => void
  /** Closes the plan screen and settles the run's proposal. */
  close: () => void
  /** Records the author's decision on changes still pending (the review deck). */
  decide: (ids: readonly string[], decision: ReviewDecision) => void
  /** Opens (or, with null, closes) a change's edit form. */
  setEditing: (id: string | null) => void
  /** Replaces a pending change with the author's adjusted version (another keeper, a new name). */
  editChange: (id: string, action: OrganiseAction) => void
  /** Applies every accepted change still pending, in the plan's order (new categories first). */
  applyAccepted: () => Promise<void>
  undo: (id: string) => Promise<void>
  /** Takes back every applied change that can be undone, newest first. */
  undoAll: () => Promise<void>
  /** Runs the local pass again. */
  refreshCandidates: () => Promise<void>
  /** Hides the offer until the findings change. */
  dismissOffer: () => void
  clear: () => void
}

/** Undo of each applied change, by change id; kept out of the store (functions are not state). */
const undos = new Map<string, () => Promise<void>>()
/** A proposed category's plan id → the id it got once created, for the run. */
let categoryIds = new Map<string, string>()
/** F-9.15: the Changes log run of the current plan (its first request id). */
let runKey = ''
/** Bumped by every start() and clear(), so a superseded run's answer is dropped. */
let generation = 0
let counter = 0
const nextRequestId = (): string => `org-${Date.now().toString(36)}-${++counter}`

const empty = {
  open: false,
  phase: 'idle' as OrganisePhase,
  request: null,
  mode: DEFAULT_ASSISTANT_MODE,
  plan: null,
  views: {},
  order: [],
  requestId: null,
  proposalId: null,
  costUsd: 0,
  usage: null,
  model: null,
  cached: false,
  error: null,
  busy: false,
  editingId: null
}

/** The changes a pass applies: the given ids, new categories first, then the plan's order. */
function applyOrder(order: readonly string[], views: Record<string, OrganiseChangeView>): string[] {
  const isCategory = (id: string): boolean => views[id]?.change.action.kind === 'category'
  return [...order.filter(isCategory), ...order.filter((id) => !isCategory(id))]
}

export const useOrganiseStore = create<OrganiseState>((set, get) => {
  const patchView = (id: string, patch: Partial<OrganiseChangeView>): void => {
    set((s) => {
      const view = s.views[id]
      return view === undefined ? {} : { views: { ...s.views, [id]: { ...view, ...patch } } }
    })
  }

  /** Applies the given changes one after the other; a change whose prerequisite did not land is skipped. */
  const applyIds = async (ids: readonly string[]): Promise<void> => {
    const { proposalId } = get()
    if (proposalId === null) return
    set({ busy: true })
    try {
      for (const id of applyOrder(ids, get().views)) {
        const view = get().views[id]
        if (view?.status !== 'pending') continue
        const missing = view.change.requires.find((need) => get().views[need]?.status !== 'applied')
        if (missing !== undefined) {
          patchView(id, { error: 'Needs the new category above; apply it first.' })
          continue
        }
        patchView(id, { status: 'applying', error: null })
        try {
          // F-9.15: the plan's changes are one run of the Changes log.
          const undo = await applyOrganiseAction(view.change.action, categoryIds, proposalId, {
            source: 'organise',
            run: runKey
          })
          if (undo !== null) undos.set(id, undo)
          patchView(id, { status: 'applied' })
        } catch (err) {
          patchView(id, { status: 'failed', error: describeError(err) })
        }
      }
    } finally {
      set({ busy: false })
    }
  }

  return {
    ...empty,
    candidates: null,
    dismissedKey: null,

    async start(request) {
      const running = get().requestId
      if (get().phase === 'running' && running !== null) {
        void useAiActivityStore.getState().cancel(running)
      }
      settleRun(get())
      const mine = ++generation
      undos.clear()
      categoryIds = new Map()
      const requestId = nextRequestId()
      runKey = requestId
      const mode = useAiSettingsStore.getState().settings?.chatMode ?? DEFAULT_ASSISTANT_MODE
      set({ ...empty, open: true, phase: 'running', request, mode, requestId })
      let result
      try {
        // Main lists what is saved: the notes and words typed just before asking go first.
        await useNotesStore.getState().flush()
        await useDocumentStore.getState().flush()
        result = await useAiActivityStore.getState().track(
          'organise',
          requestId,
          ipc().invoke('organise:plan', {
            instruction: request.instruction,
            scope: request.scope,
            requestId
          })
        )
      } catch (err) {
        if (mine === generation)
          set({ phase: 'failed', error: describeError(err), requestId: null })
        return
      }
      if (mine !== generation) {
        if (result.ok) void proposalStore.settle(result.proposalId, 'rejected', null)
        return
      }
      if (!result.ok) {
        if (result.code === 'CANCELLED') set({ ...empty })
        else {
          set({
            phase: 'failed',
            error: `${result.message} ${result.nextStep}`.trim(),
            requestId: null
          })
        }
        return
      }
      const views: Record<string, OrganiseChangeView> = {}
      for (const change of result.plan.changes) {
        views[change.id] = { change, status: 'pending', decision: 'pending', error: null }
      }
      set({
        phase: 'ready',
        plan: result.plan,
        views,
        order: result.plan.changes.map((change) => change.id),
        requestId: null,
        proposalId: result.proposalId,
        costUsd: result.costUsd,
        usage: result.usage,
        model: result.model,
        cached: result.cached
      })
      if (mode === 'auto') {
        // Auto: what can be undone lands now; merges, deletions, and new categories still ask.
        await applyIds(
          result.plan.changes
            .filter((change) => !needsAsk(change.action) && change.requires.length === 0)
            .map((change) => change.id)
        )
      }
      void get().refreshCandidates()
    },

    stop() {
      const { requestId, phase } = get()
      if (phase === 'running' && requestId !== null) {
        void useAiActivityStore.getState().cancel(requestId)
      }
    },

    close() {
      if (get().busy) return
      get().stop()
      settleRun(get())
      generation++
      set({ ...empty })
    },

    decide(ids, decision) {
      if (get().mode === 'plan') return
      set((s) => ({
        views: Object.fromEntries(
          Object.entries(s.views).map(([id, view]) => [
            id,
            ids.includes(id) && view.status === 'pending' ? { ...view, decision } : view
          ])
        )
      }))
    },

    setEditing(id) {
      set({ editingId: id !== null && get().views[id]?.status === 'pending' ? id : null })
    },

    editChange(id, action) {
      const view = get().views[id]
      if (view?.status !== 'pending' || view.change.action.kind !== action.kind) return
      patchView(id, { change: { ...view.change, action }, error: null })
      set({ editingId: null })
    },

    async applyAccepted() {
      const { phase, mode, busy, order, views } = get()
      if (phase !== 'ready' || mode === 'plan' || busy) return
      await applyIds(
        order.filter((id) => views[id]?.status === 'pending' && views[id].decision === 'accepted')
      )
      void get().refreshCandidates()
    },

    async undo(id) {
      const undo = undos.get(id)
      if (undo === undefined || get().busy) return
      set({ busy: true })
      try {
        await undo()
        undos.delete(id)
        patchView(id, { status: 'undone', error: null })
      } catch (err) {
        patchView(id, { error: describeError(err) })
      } finally {
        set({ busy: false })
      }
    },

    async undoAll() {
      if (get().busy) return
      const applied = [...get().order].reverse().filter((id) => undos.has(id))
      for (const id of applied) await get().undo(id)
      void get().refreshCandidates()
    },

    async refreshCandidates() {
      try {
        set({ candidates: await ipc().invoke('organise:candidates', undefined) })
      } catch {
        // The offer is a nicety: with no project open (or a failed read) it simply does not show.
      }
    },

    dismissOffer() {
      const candidates = get().candidates
      if (candidates !== null) set({ dismissedKey: candidatesKey(candidates) })
    },

    clear() {
      generation++
      undos.clear()
      categoryIds = new Map()
      set({ ...empty, candidates: null, dismissedKey: null })
    }
  }
})

/** Settles a finished run's proposal once: accepted when anything of it stayed applied. */
function settleRun(state: Pick<OrganiseState, 'proposalId' | 'views'>): void {
  if (state.proposalId === null) return
  const views = Object.values(state.views)
  const applied = views.filter((view) => view.status === 'applied').length
  const status = applied === 0 ? 'rejected' : applied === views.length ? 'accepted' : 'acceptedPart'
  void proposalStore.settle(state.proposalId, status, null)
}

/** Whether the quiet offer should show for these findings (and not while a plan is open). */
export function offerShowing(
  state: Pick<OrganiseState, 'candidates' | 'dismissedKey' | 'open'>
): boolean {
  const { candidates } = state
  if (state.open || candidates === null || !worthOffering(candidates)) return false
  return candidatesKey(candidates) !== state.dismissedKey
}

/** Back to a fresh store: no run, no findings, no undo. For tests and project close. */
export function resetOrganiseStore(): void {
  useOrganiseStore.getState().clear()
}
