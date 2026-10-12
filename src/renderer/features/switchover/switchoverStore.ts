import { create } from 'zustand'
import type {
  InlineTagReplacement,
  SwitchoverConsent,
  SwitchoverPlan,
  SwitchoverResult
} from '@shared/memory/switchover'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The story-memory switch-over on a copy (F-16.15, plan P1 §6.1): Help › Try the story-memory
 * switch-over on a copy… (unpackaged builds only). The flow: pending saves are written, main
 * makes and opens the test copy; the dry run; the consent screen with each inline tag's words,
 * editable; the conversion, after which main closes the copy and this store opens it again on
 * v2. App-wide (it outlives the project switch it causes), so the dialog is mounted outside the
 * project screen.
 */

export type SwitchoverPhase = 'idle' | 'copying' | 'plan' | 'consent' | 'converting' | 'done'

/** A ticked merge's key: the two planned records, keep first. */
export const mergeKey = (keep: string, merge: string): string => `${keep}|${merge}`

interface SwitchoverState {
  /** Whether this build offers the flow (`switchover:available`); false until main says. */
  available: boolean
  phase: SwitchoverPhase
  /** The test copy's folder, once made. */
  copy: string | null
  plan: SwitchoverPlan | null
  /** The consent rows with the author's edits. */
  rows: InlineTagReplacement[]
  /** The rows' replacements as main proposed them, for a row left blank. */
  defaults: Record<string, string>
  /** Ticked merges (`mergeKey`); none by default. */
  ticked: string[]
  result: SwitchoverResult | null
  error: string | null
  /** Never throws: a build that cannot say does not offer the flow. */
  loadAvailable: () => Promise<void>
  start: () => Promise<void>
  toConsent: () => Promise<void>
  back: () => void
  setReplacement: (key: string, text: string) => void
  toggleMerge: (keep: string, merge: string) => void
  convert: () => Promise<void>
  close: () => void
}

const EMPTY = {
  phase: 'idle' as SwitchoverPhase,
  copy: null,
  plan: null,
  rows: [],
  defaults: {},
  ticked: [],
  result: null,
  error: null
}

/** Bumped by every close, so an answer for a flow the author left is dropped. */
let generation = 0

export const useSwitchoverStore = create<SwitchoverState>((set, get) => ({
  available: false,
  ...EMPTY,

  async loadAvailable() {
    // A developer item: when main cannot say, the Help menu simply does not offer it.
    try {
      const { available } = await ipc().invoke('switchover:available', undefined)
      set({ available })
    } catch {
      set({ available: false })
    }
  },

  async start() {
    if (get().phase !== 'idle') return
    const mine = ++generation
    set({ ...EMPTY, phase: 'copying' })
    try {
      await flushPendingSaves()
      const made = await ipc().invoke('switchover:trialCopy', undefined)
      if (mine !== generation) return
      useProjectStore.setState({ current: made.info })
      const plan = await ipc().invoke('switchover:plan', undefined)
      if (mine !== generation) return
      set({ phase: 'plan', copy: made.folder, plan })
    } catch (err) {
      if (mine !== generation) return
      set({ ...EMPTY, error: describeError(err) })
      throw err
    }
  },

  async toConsent() {
    const mine = generation
    set({ error: null })
    try {
      const rows = await ipc().invoke('switchover:consent', undefined)
      if (mine !== generation) return
      set({
        phase: 'consent',
        rows,
        defaults: Object.fromEntries(rows.map((row) => [row.key, row.replacement]))
      })
    } catch (err) {
      if (mine === generation) set({ error: describeError(err) })
    }
  },

  back() {
    if (get().phase === 'consent') set({ phase: 'plan', error: null })
  },

  setReplacement(key, text) {
    set({ rows: get().rows.map((row) => (row.key === key ? { ...row, replacement: text } : row)) })
  },

  toggleMerge(keep, merge) {
    const key = mergeKey(keep, merge)
    const ticked = get().ticked
    set({ ticked: ticked.includes(key) ? ticked.filter((each) => each !== key) : [...ticked, key] })
  },

  async convert() {
    const { rows, defaults, ticked, plan } = get()
    if (plan === null) return
    const mine = generation
    const consent: SwitchoverConsent = {
      replacements: rows.map((row) => ({
        key: row.key,
        text: row.replacement.trim() === '' ? (defaults[row.key] ?? row.tag) : row.replacement
      })),
      merges: plan.merges
        .filter((pair) => ticked.includes(mergeKey(pair.keep, pair.merge)))
        .map((pair) => ({ keep: pair.keep, merge: pair.merge }))
    }
    set({ phase: 'converting', error: null })
    try {
      const result = await ipc().invoke('switchover:convert', consent)
      if (mine !== generation) return
      // Main closed the copy; it opens again here, now on v2.
      await useProjectStore.getState().open(result.folder)
      if (mine !== generation) return
      set({ phase: 'done', result })
    } catch (err) {
      if (mine === generation) set({ phase: 'consent', error: describeError(err) })
    }
  },

  close() {
    generation += 1
    set({ ...EMPTY })
  }
}))

/** Tests: back to a fresh store. */
export function resetSwitchoverStore(): void {
  generation += 1
  useSwitchoverStore.setState({ available: false, ...EMPTY })
}
