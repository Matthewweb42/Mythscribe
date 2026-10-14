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
 * switch-over on a copy… (unpackaged builds only). The flow: the project store settles the open
 * project (pending saves, the cloud copy) and has main make and open the test copy; the dry run;
 * the consent screen with each inline tag's words, editable; pending saves again, then the
 * conversion, after which main closes the copy and the project store opens it again on v2.
 * App-wide (it outlives the project switch it causes), so the dialog is mounted outside the
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
      const copy = await useProjectStore.getState().openSwitchoverCopy()
      if (mine !== generation) return
      const plan = await ipc().invoke('switchover:plan', undefined)
      if (mine !== generation) return
      set({ phase: 'plan', copy, plan })
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
    // F-16.31 (decision SW-D5): Convert names the project it is for, so a dialog left open across
    // a project switch never converts another book.
    const projectId = useProjectStore.getState().current?.id
    if (projectId === undefined) {
      set({ error: 'No project is open.' })
      return
    }
    set({ phase: 'converting', error: null })
    let result: SwitchoverResult
    try {
      // The scene open behind the dialog may hold an unsaved edit: it is written into the copy
      // before the conversion reads it, and nothing is pending when main closes the copy.
      await flushPendingSaves()
      const outcome = await ipc().invoke('switchover:convert', { consent, projectId })
      if (!outcome.ok) {
        // A step failed and nothing changed: what failed and the next step (Switch-over slice 3
        // gives it its own block).
        if (mine === generation) {
          set({ phase: 'consent', error: `${outcome.message} Next: ${outcome.nextStep}` })
        }
        return
      }
      result = outcome
    } catch (err) {
      if (mine === generation) set({ phase: 'consent', error: describeError(err) })
      return
    }
    if (mine !== generation) return
    // Converted: main closed the copy. A failure from here on is the reopen's, never the
    // conversion's, so the done screen says so rather than offering Convert again.
    set({ result })
    try {
      await useProjectStore.getState().open(result.folder)
      if (mine === generation) set({ phase: 'done' })
    } catch (err) {
      if (mine === generation) {
        set({
          phase: 'done',
          error: `The copy is converted, but it did not open again: ${describeError(err)} Open it from File › Open project….`
        })
      }
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
