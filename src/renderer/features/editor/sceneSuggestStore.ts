import { create } from 'zustand'
import type { AiUsage } from '@shared/ai'
import type { AiSuggestNotesResult, AiSuggestSynopsisResult } from '@shared/ipc/contract'
import { NOTES_SUGGEST_INSTRUCTION_MAX } from '@shared/sceneSuggest'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'
import { useNotesStore } from './notesStore'
import { patchSceneMeta } from './sceneMetaStore'

/** What a suggestion cost, for its cost line (F-5.9). */
export interface SuggestionCost {
  proposalId: string
  model: string
  costUsd: number
  usage: AiUsage
  cached: boolean
  /** The scene was head-cut before it was sent. */
  truncated: boolean
}

/** A suggestion's state: on its way (with the id Cancel stops), back, or an expected failure. */
export type Suggestion<T> =
  | { status: 'pending'; requestId: string }
  | ({ status: 'ready'; value: T } & SuggestionCost)
  | { status: 'error'; message: string; nextStep: string }

export type SuggestionKind = 'synopsis' | 'notes'

/**
 * The side-panel suggestions (F-5.20) in the notes column, per node: a suggested synopsis and
 * suggested key points for the notes. Each is a proposal (F-14.5) nothing writes into the panel
 * until the author accepts it: Accept puts the synopsis in the Synopsis box through the
 * scene-metadata autosave store; Add to notes appends the chosen points to the notes, one
 * "• " paragraph each (the notes schema has no lists and no AI-origin mark, so the points carry
 * no provenance once added; decided by Claude, unconfirmed), settling `accepted` for every point
 * or `acceptedPart` for some; Dismiss settles `rejected`. Started from the Suggest buttons in the
 * notes column, the assistant's actions menu, or a routed chat turn (F-5.19). One request per
 * node and kind at a time; asking again replaces (and rejects) a suggestion still on screen.
 */
interface SceneSuggestState {
  synopsis: Record<string, Suggestion<string>>
  notes: Record<string, Suggestion<string[]>>
  suggestSynopsis: (nodeId: string) => void
  /** `instruction` is the author's focus ("what should I remember about Tomas?"), or null. */
  suggestNotes: (nodeId: string, instruction: string | null) => void
  cancel: (kind: SuggestionKind, nodeId: string) => void
  /** Writes the suggested synopsis into the node's metadata and settles the proposal accepted. */
  acceptSynopsis: (nodeId: string) => Promise<void>
  /** Appends the points at `picked` (indexes) to the node's notes and settles the proposal. */
  addNotes: (nodeId: string, picked: readonly number[]) => Promise<void>
  /** Drops the suggestion; a ready one settles rejected, a pending one is cancelled. */
  dismiss: (kind: SuggestionKind, nodeId: string) => void
}

let counter = 0
const nextRequestId = (kind: SuggestionKind): string =>
  `${kind}-${Date.now().toString(36)}-${++counter}`

function put(kind: 'synopsis', nodeId: string, value: Suggestion<string> | null): void
function put(kind: 'notes', nodeId: string, value: Suggestion<string[]> | null): void
function put(
  kind: SuggestionKind,
  nodeId: string,
  value: Suggestion<string> | Suggestion<string[]> | null
): void {
  useSceneSuggestStore.setState((s) => {
    const next: Record<string, unknown> = { ...s[kind] }
    if (value === null) delete next[nodeId]
    else next[nodeId] = value
    return { [kind]: next }
  })
}

/** The pending request of `kind` for `nodeId` is still `requestId` (not stopped, dismissed, or replaced). */
function stillPending(kind: SuggestionKind, nodeId: string, requestId: string): boolean {
  const current = useSceneSuggestStore.getState()[kind][nodeId]
  return current?.status === 'pending' && current.requestId === requestId
}

function costOf(
  result: Extract<AiSuggestSynopsisResult | AiSuggestNotesResult, { ok: true }>
): SuggestionCost {
  return {
    proposalId: result.proposalId,
    model: result.model,
    costUsd: result.costUsd,
    usage: result.usage,
    cached: result.cached,
    truncated: result.truncated
  }
}

/**
 * Settles what came back for `requestId`: a reply nobody waits for any more rejects its
 * proposal; a cancellation clears in silence; another failure shows with its next step.
 */
function land<T>(
  kind: SuggestionKind,
  nodeId: string,
  requestId: string,
  result: AiSuggestSynopsisResult | AiSuggestNotesResult,
  ready: (ok: Extract<AiSuggestSynopsisResult | AiSuggestNotesResult, { ok: true }>) => T,
  write: (value: Suggestion<T> | null) => void
): void {
  if (!stillPending(kind, nodeId, requestId)) {
    if (result.ok) void proposalStore.settle(result.proposalId, 'rejected')
    return
  }
  if (result.ok) write({ status: 'ready', value: ready(result), ...costOf(result) })
  else if (result.code === 'CANCELLED') write(null)
  else write({ status: 'error', message: result.message, nextStep: result.nextStep })
}

/** Starts one suggestion request after the document's unsaved typing is written (main reads the saved scene). */
function request<T>(
  kind: SuggestionKind,
  nodeId: string,
  send: (requestId: string) => Promise<AiSuggestSynopsisResult | AiSuggestNotesResult>,
  ready: (ok: Extract<AiSuggestSynopsisResult | AiSuggestNotesResult, { ok: true }>) => T,
  write: (value: Suggestion<T> | null) => void
): void {
  const state = useSceneSuggestStore.getState()
  if (state[kind][nodeId]?.status === 'pending') return
  state.dismiss(kind, nodeId)
  const requestId = nextRequestId(kind)
  write({ status: 'pending', requestId })
  useDocumentStore
    .getState()
    .flush()
    .then(() => send(requestId))
    .then(
      (result) => land(kind, nodeId, requestId, result, ready, write),
      (err: unknown) => {
        if (stillPending(kind, nodeId, requestId)) write(null)
        toast.error(describeError(err))
      }
    )
}

/** What starts each added point in the notes: the notes schema has no lists, so a bullet character. */
export const NOTE_POINT_PREFIX = '• '

/**
 * `doc` with `points` appended, one paragraph each starting with `NOTE_POINT_PREFIX`. An empty
 * document (one empty paragraph) is replaced rather than left as a blank line above them.
 */
export function appendNotePoints(doc: TiptapNodeT, points: readonly string[]): TiptapNodeT {
  const added: TiptapNodeT[] = points.map((point) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: `${NOTE_POINT_PREFIX}${point}` }]
  }))
  const blocks = doc.content ?? []
  const empty = blocks.length === 0 || (blocks.length === 1 && isEmptyParagraph(blocks[0]))
  return { ...doc, type: 'doc', content: empty ? added : [...blocks, ...added] }
}

function isEmptyParagraph(node: TiptapNodeT | undefined): boolean {
  return node?.type === 'paragraph' && (node.content ?? []).length === 0
}

export const useSceneSuggestStore = create<SceneSuggestState>((set, get) => ({
  synopsis: {},
  notes: {},

  suggestSynopsis(nodeId) {
    request(
      'synopsis',
      nodeId,
      (requestId) =>
        useAiActivityStore
          .getState()
          .track('synopsis', requestId, ipc().invoke('ai:suggestSynopsis', { nodeId, requestId })),
      (ok) => ('synopsis' in ok ? ok.synopsis : ''),
      (value) => put('synopsis', nodeId, value)
    )
  },

  suggestNotes(nodeId, instruction) {
    const trimmed = instruction?.trim().slice(0, NOTES_SUGGEST_INSTRUCTION_MAX) ?? ''
    const focus = trimmed === '' ? null : trimmed
    request(
      'notes',
      nodeId,
      (requestId) =>
        useAiActivityStore
          .getState()
          .track(
            'notesSuggest',
            requestId,
            ipc().invoke('ai:suggestNotes', { nodeId, requestId, instruction: focus })
          ),
      (ok) => ('points' in ok ? ok.points : []),
      (value) => put('notes', nodeId, value)
    )
  },

  cancel(kind, nodeId) {
    const current = get()[kind][nodeId]
    if (current?.status !== 'pending') return
    void useAiActivityStore.getState().cancel(current.requestId)
  },

  async acceptSynopsis(nodeId) {
    const current = get().synopsis[nodeId]
    if (current?.status !== 'ready') return
    put('synopsis', nodeId, null)
    try {
      await patchSceneMeta(nodeId, (meta) => ({ ...meta, synopsis: current.value }))
    } catch (err) {
      toast.error(describeError(err))
      return
    }
    void proposalStore.settle(current.proposalId, 'accepted')
  },

  async addNotes(nodeId, picked) {
    const current = get().notes[nodeId]
    if (current?.status !== 'ready') return
    const points = current.value.filter((_, index) => picked.includes(index))
    if (points.length === 0) return
    put('notes', nodeId, null)
    try {
      // The author's unsaved notes go first, so the read below is what the column shows; the
      // column's editor is then rebuilt on the stored notes (nothing is pending to lose).
      const notes = useNotesStore.getState()
      await notes.flush()
      const stored = (await ipc().invoke('notes:get', { id: nodeId })).notes ?? EMPTY_DOC
      await ipc().invoke('notes:save', {
        id: nodeId,
        notes: appendNotePoints(stored, points)
      })
      if (useNotesStore.getState().docs[nodeId] !== undefined) {
        await useNotesStore.getState().reload([nodeId])
      }
    } catch (err) {
      toast.error(describeError(err))
      return
    }
    const status = points.length === current.value.length ? 'accepted' : 'acceptedPart'
    void proposalStore.settle(current.proposalId, status)
  },

  dismiss(kind, nodeId) {
    const current = get()[kind][nodeId]
    if (current === undefined) return
    if (current.status === 'pending') void useAiActivityStore.getState().cancel(current.requestId)
    if (current.status === 'ready') void proposalStore.settle(current.proposalId, 'rejected')
    set((s) => {
      const next = { ...s[kind] }
      delete next[nodeId]
      return { [kind]: next }
    })
  }
}))

/** Empties the store and restarts the id counter. For tests only. */
export function resetSceneSuggestStore(): void {
  useSceneSuggestStore.setState({ synopsis: {}, notes: {} })
  counter = 0
}
