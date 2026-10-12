import { create } from 'zustand'
import type { Label, LabelKind, LabelLink } from '@shared/storyLabels'
import { ipc } from '@renderer/lib/ipc'

/**
 * The author's labels in the renderer (F-16.7, story memory v2; answer 2): the one owner of the
 * labels in her order, of which scene or Research document carries which (`byNode`), of the
 * label each surface is filtered by, and of whether the Labels dialog is open. The AI never
 * touches any of it. Loaded on a v2 open; every action merges what main answers.
 */

/** Where a label filter applies: the Manuscript tree, the Research tree, the Outline. */
export const LABEL_SURFACES = ['manuscript', 'research', 'outline'] as const
export type LabelSurface = (typeof LABEL_SURFACES)[number]

type Filters = Record<LabelSurface, string | null>

const NO_FILTERS: Filters = { manuscript: null, research: null, outline: null }

interface LabelState {
  /** In the author's order (`position`). */
  labels: Label[]
  /** Node id → the ids of the labels it carries, in label order. */
  byNode: Record<string, string[]>
  loaded: boolean
  /** The label each surface shows only the carriers of; null shows everything. */
  filter: Filters
  /** The Labels dialog (create, rename, colour, kind, order, delete) is open. */
  managing: boolean
  load: () => Promise<void>
  clear: () => void
  create: (input: { name: string; kind: LabelKind; colour?: string }) => Promise<Label>
  update: (
    id: string,
    patch: { name?: string; kind?: LabelKind; colour?: string }
  ) => Promise<Label>
  remove: (id: string) => Promise<void>
  /** Moves a label one place up or down. */
  move: (id: string, direction: -1 | 1) => Promise<void>
  assign: (labelId: string, nodeId: string) => Promise<void>
  unassign: (labelId: string, nodeId: string) => Promise<void>
  setFilter: (surface: LabelSurface, labelId: string | null) => void
  openManager: () => void
  closeManager: () => void
}

/** Groups links by node, each node's labels in the labels' order. */
export function linksByNode(
  links: readonly LabelLink[],
  labels: readonly Label[]
): Record<string, string[]> {
  const order = new Map(labels.map((label, index) => [label.id, index]))
  const byNode: Record<string, string[]> = {}
  for (const link of links) {
    if (!order.has(link.labelId)) continue
    byNode[link.nodeId] = [...(byNode[link.nodeId] ?? []), link.labelId]
  }
  for (const ids of Object.values(byNode)) {
    ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  }
  return byNode
}

/** Bumped by `clear`, so an answer for a project that closed is dropped. */
let generation = 0

export const useLabelStore = create<LabelState>((set, get) => {
  /** A node's labels as main answered them. */
  const setNode = (nodeId: string, labels: readonly Label[]): void => {
    const byNode = { ...get().byNode }
    if (labels.length === 0) delete byNode[nodeId]
    else byNode[nodeId] = labels.map((label) => label.id)
    set({ byNode })
  }

  /** A new list from main: links to gone labels drop, filters on gone labels clear, order follows. */
  const setLabels = (labels: Label[]): void => {
    const known = new Set(labels.map((label) => label.id))
    const byNode: Record<string, string[]> = {}
    for (const [nodeId, ids] of Object.entries(get().byNode)) {
      const kept = ids.filter((id) => known.has(id))
      if (kept.length > 0) byNode[nodeId] = kept
    }
    const filter = { ...get().filter }
    for (const surface of LABEL_SURFACES) {
      const id = filter[surface]
      if (id !== null && !known.has(id)) filter[surface] = null
    }
    const links = Object.entries(byNode).flatMap(([nodeId, ids]) =>
      ids.map((labelId) => ({ labelId, nodeId }))
    )
    set({ labels, byNode: linksByNode(links, labels), filter })
  }

  return {
    labels: [],
    byNode: {},
    loaded: false,
    filter: NO_FILTERS,
    managing: false,

    async load() {
      const mine = generation
      const [labels, links] = await Promise.all([
        ipc().invoke('label:list', undefined),
        ipc().invoke('label:links', undefined)
      ])
      if (mine !== generation) return
      set({ labels, byNode: linksByNode(links, labels), loaded: true })
    },

    clear() {
      generation++
      set({ labels: [], byNode: {}, loaded: false, filter: NO_FILTERS, managing: false })
    },

    async create(input) {
      const mine = generation
      const made = await ipc().invoke('label:create', input)
      if (mine === generation) setLabels([...get().labels, made])
      return made
    },

    async update(id, patch) {
      const mine = generation
      const updated = await ipc().invoke('label:update', { id, ...patch })
      if (mine === generation) {
        setLabels(get().labels.map((label) => (label.id === id ? updated : label)))
      }
      return updated
    },

    async remove(id) {
      const mine = generation
      const labels = await ipc().invoke('label:delete', { id })
      if (mine === generation) setLabels(labels)
    },

    async move(id, direction) {
      const ids = get().labels.map((label) => label.id)
      const from = ids.indexOf(id)
      const to = from + direction
      if (from === -1 || to < 0 || to >= ids.length) return
      ids.splice(from, 1)
      ids.splice(to, 0, id)
      const mine = generation
      const labels = await ipc().invoke('label:reorder', { ids })
      if (mine === generation) setLabels(labels)
    },

    async assign(labelId, nodeId) {
      const mine = generation
      const labels = await ipc().invoke('label:assign', { labelId, nodeId })
      if (mine === generation) setNode(nodeId, labels)
    },

    async unassign(labelId, nodeId) {
      const mine = generation
      const labels = await ipc().invoke('label:unassign', { labelId, nodeId })
      if (mine === generation) setNode(nodeId, labels)
    },

    setFilter(surface, labelId) {
      set({ filter: { ...get().filter, [surface]: labelId } })
    },

    openManager() {
      set({ managing: true })
    },

    closeManager() {
      set({ managing: false })
    }
  }
})

/** The label a surface is filtered by, or undefined (none, or a label since deleted). */
export function filterLabelOf(
  state: Pick<LabelState, 'labels' | 'filter'>,
  surface: LabelSurface
): Label | undefined {
  const id = state.filter[surface]
  return id === null ? undefined : state.labels.find((label) => label.id === id)
}

/** Empties the store and drops any answer in flight. For tests and project close. */
export function resetLabelStore(): void {
  useLabelStore.getState().clear()
}
