import { create } from 'zustand'
import { categoryFieldIds } from '@shared/categories'
import type { EntityFields } from '@shared/entities'
import type { Entity, EntityUpdateInput } from '@shared/ipc/contract'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { IpcRequestError } from '@renderer/lib/ipc'
import { getCategory } from './categoryStore'
import { useEntityStore } from './entityStore'

/** How long after the last keystroke the debounced `entity:update` fires (F-9.3). */
export const ENTITY_DRAFT_SAVE_DELAY_MS = 500

/** What the open entity page holds: the author's latest text, before it is written. */
export interface EntityDraft {
  id: string
  /** As typed, untrimmed; an empty name is never sent, so the stored one stands. */
  name: string
  /** Every structured field the author has touched; `''` means "remove this field". */
  fields: EntityFields
  /** The blank page, as typed; `''` is written back as no page at all. */
  body: string
}

/** What the editor's status line shows: nothing, `Saving…`, or `Saved`. */
export type EntityDraftStatus = 'idle' | 'dirty' | 'saving' | 'saved'

/** One part of the draft the editor changed; `fields` is merged over the draft's own map. */
export interface EntityDraftPatch {
  name?: string
  fields?: EntityFields
  body?: string
}

interface EntityDraftState {
  /** The open entity's draft, or null while no entity page is open. */
  draft: EntityDraft | null
  status: EntityDraftStatus
  /** Starts a draft from the stored row; a dirty draft of another entity is written first. */
  open: (entity: Entity) => void
  /** Applies an edit and (re)starts the debounce. Ignored when nothing is open. */
  edit: (patch: EntityDraftPatch) => void
  /** Writes what differs from the stored row now. Never rejects: it reports its own failures. */
  flush: () => Promise<void>
  /** Flushes, unregisters from the pending-save registry, and drops the draft. */
  close: () => void
  /**
   * F-9.18: the open sheet changed in main without this page (its other view was written by the
   * sheet sync, or a change was undone): the draft takes the row, unless it holds an edit not yet
   * written, which wins (main drops a sync the author has edited past).
   */
  adopt: (entity: Entity) => void
}

let timer: ReturnType<typeof setTimeout> | null = null
/** The write on the wire, so a flush (and the close/quit path) waits for it instead of racing it. */
let inflight: Promise<void> | null = null
let unregister: (() => void) | null = null

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/**
 * The patch that turns the stored row into the draft: only the parts that really differ, so a
 * page opened and closed without an edit writes nothing. An empty field value is kept on purpose
 * (main reads `''` as "remove this field"); an empty name is dropped, because the stored name is
 * the better answer to a cleared name box.
 */
export function draftPatch(
  draft: EntityDraft,
  stored: Entity
): Omit<EntityUpdateInput, 'id'> | null {
  const patch: Omit<EntityUpdateInput, 'id'> = {}
  const name = draft.name.trim()
  if (name.length > 0 && name !== stored.name) patch.name = name
  const fields: EntityFields = {}
  // F-9.18: the sheet's own fields are written like its category's.
  const ids = [
    ...categoryFieldIds(getCategory(stored.kind)),
    ...stored.extraFields.map((f) => f.id)
  ]
  for (const id of ids) {
    const next = draft.fields[id] ?? ''
    if (next !== (stored.fields[id] ?? '')) fields[id] = next
  }
  if (Object.keys(fields).length > 0) patch.fields = fields
  const body = draft.body.length > 0 ? draft.body : null
  if (body !== stored.body) patch.body = body
  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * Writes the pending difference, if any. A rename clash reverts the name box to the stored name
 * (the author sees which name won); any other failure keeps the draft as it is, so the words are
 * still on screen and the next keystroke tries again.
 */
async function write(fallback: EntityDraft | null): Promise<void> {
  // The page may have closed while an earlier write was on the wire; `fallback` is the draft as
  // it was when the flush was asked for, so a close never drops the last keystrokes.
  const draft = useEntityDraftStore.getState().draft ?? fallback
  if (draft === null) return
  const stored = useEntityStore.getState().byId[draft.id]
  if (!stored) return // deleted, or the project closed, while the draft was open
  const patch = draftPatch(draft, stored)
  if (patch === null) {
    if (useEntityDraftStore.getState().status === 'dirty') {
      useEntityDraftStore.setState({ status: 'idle' })
    }
    return
  }
  useEntityDraftStore.setState({ status: 'saving' })
  try {
    await useEntityStore.getState().update(draft.id, patch)
    const current = useEntityDraftStore.getState()
    if (current.draft?.id !== draft.id) return // another entity opened while this was in flight
    if (current.status === 'saving') useEntityDraftStore.setState({ status: 'saved' })
  } catch (err) {
    toast.error(describeError(err))
    useEntityDraftStore.setState((s) => {
      if (s.draft?.id !== draft.id) return {}
      const clash = err instanceof IpcRequestError && err.code === 'ALREADY_EXISTS'
      return {
        draft: clash ? { ...s.draft, name: stored.name } : s.draft,
        status: 'dirty'
      }
    })
  }
}

/** Waits for the write on the wire, then writes what is still pending. */
async function flushNow(): Promise<void> {
  cancelTimer()
  const snapshot = useEntityDraftStore.getState().draft
  while (inflight !== null) await inflight.catch(() => undefined)
  inflight = write(snapshot)
  try {
    await inflight
  } finally {
    inflight = null
  }
}

/**
 * The open entity page's unsaved edits (F-9.3). One draft at a time — the editor is a full page,
 * so only one entity is open — written back through the entity store after a short debounce,
 * when the page closes, and when the project closes (the pending-save registry). There is no
 * Save button: `status` is the whole feedback, and only the parts that changed are ever sent.
 */
export const useEntityDraftStore = create<EntityDraftState>((set, get) => ({
  draft: null,
  status: 'idle',

  open(entity) {
    const previous = get().draft
    if (previous !== null && previous.id !== entity.id) void flushNow()
    unregister ??= registerPendingSave(flushNow)
    cancelTimer()
    set({
      draft: {
        id: entity.id,
        name: entity.name,
        fields: { ...entity.fields },
        body: entity.body ?? ''
      },
      status: 'idle'
    })
  },

  edit(patch) {
    const draft = get().draft
    if (draft === null) return
    set({
      draft: {
        ...draft,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.body === undefined ? {} : { body: patch.body }),
        ...(patch.fields === undefined ? {} : { fields: { ...draft.fields, ...patch.fields } })
      },
      status: 'dirty'
    })
    cancelTimer()
    timer = setTimeout(() => {
      timer = null
      void flushNow()
    }, ENTITY_DRAFT_SAVE_DELAY_MS)
  },

  async flush() {
    await flushNow()
  },

  adopt(entity) {
    const draft = get().draft
    if (draft?.id !== entity.id) return
    if (
      timer !== null ||
      inflight !== null ||
      get().status === 'dirty' ||
      get().status === 'saving'
    )
      return
    const body = entity.body ?? ''
    const same =
      draft.name === entity.name &&
      draft.body === body &&
      JSON.stringify(draft.fields) === JSON.stringify(entity.fields)
    if (same) return
    set({ draft: { id: entity.id, name: entity.name, fields: { ...entity.fields }, body } })
  },

  close() {
    cancelTimer()
    if (get().draft !== null) void flushNow()
    unregister?.()
    unregister = null
    set({ draft: null, status: 'idle' })
  }
}))

/** Drops the timer, the in-flight write, and the registration, then empties the store. For tests only. */
export function resetEntityDraftStore(): void {
  cancelTimer()
  inflight = null
  unregister?.()
  unregister = null
  useEntityDraftStore.setState({ draft: null, status: 'idle' })
}
