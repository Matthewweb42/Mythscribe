import { create } from 'zustand'
import type { CloudProvider } from '@shared/cloudSync'
import type {
  InlineTagReplacement,
  SwitchoverConsent,
  SwitchoverFailure,
  SwitchoverPlan,
  SwitchoverResult
} from '@shared/memory/switchover'
import { useCloudSyncStore } from '@renderer/features/project/cloudSyncStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The story-memory switch-over (F-16.15; F-16.31 part A, plan `Switchover.md` §3): Help › Switch to
 * the new story memory… or Settings › AI › Story memory, in every build, while a v1 project is
 * open. The intro says what changes and recommends *Try it on a copy first* (P1's flow: the copy is
 * made and opened, then switched); *Switch this project…* runs the safety step first (pending saves,
 * the Google Drive working copy copied back, a kept backup, a dated copy beside the project), then
 * the dry run, the consent screen with each inline tag's words, and the conversion of the project
 * itself, after which main closes it and the project store opens the same folder again on v2 (no
 * restart). A step that fails shows where it failed (`failure`), with nothing changed. App-wide (it
 * outlives the project switch it causes), so the dialog is mounted outside the project screen.
 */

/**
 * `copying` is the test copy being made (or, for a test copy already open, read for its dry run);
 * `safety` is the backup and the dated copy being made, then the dry run read.
 */
export type SwitchoverPhase =
  | 'idle'
  | 'intro'
  | 'copying'
  | 'safety'
  | 'plan'
  | 'consent'
  | 'converting'
  | 'done'

/** What the flow switches: the open project itself, or a test copy of it. */
export type SwitchoverTarget = 'project' | 'copy'

/** A ticked merge's key: the two planned records, keep first. */
export const mergeKey = (keep: string, merge: string): string => `${keep}|${merge}`

/** What the safety step made: the kept backup and the dated copy beside the project. */
export interface SwitchoverSafety {
  backup: string
  datedCopy: string
}

interface SwitchoverState {
  phase: SwitchoverPhase
  /** Null while the intro reads whether the open project is a test copy. */
  target: SwitchoverTarget | null
  /**
   * The author's own project: the folder the flow started from, or the one a test copy was made
   * from. A test copy's final screen names it and *Open my project* opens it.
   */
  source: string | null
  /** The test copy's folder, once made (or the open copy's). */
  copy: string | null
  /** The cloud folder the project lives in, for the progress and the final screen's wording. */
  cloud: CloudProvider | null
  safety: SwitchoverSafety | null
  plan: SwitchoverPlan | null
  /** The consent rows with the author's edits. */
  rows: InlineTagReplacement[]
  /** The rows' replacements as main proposed them, for a row left blank. */
  defaults: Record<string, string>
  /** Ticked merges (`mergeKey`); none by default. */
  ticked: string[]
  result: SwitchoverResult | null
  /** A step that failed (nothing changed), shown in the phase it failed in, with *Try again*. */
  failure: SwitchoverFailure | null
  /** Anything else that went wrong (a channel's error), shown as one line. */
  error: string | null
  /** Starts the flow on the intro; nothing is made or changed yet. */
  open: () => Promise<void>
  /** *Try it on a copy first*: the test copy is made and opened, then its dry run. */
  tryCopy: () => Promise<void>
  /** *Switch this project…* (the safety step, then the dry run) or *Switch this copy…*. */
  switchThis: () => Promise<void>
  /** *Try again* on a failure: the step that failed, run again. */
  retry: () => Promise<void>
  toConsent: () => Promise<void>
  back: () => void
  setReplacement: (key: string, text: string) => void
  toggleMerge: (keep: string, merge: string) => void
  convert: () => Promise<void>
  /** A test copy's final screen: closes the dialog and opens the project the copy was made from. */
  openMyProject: () => Promise<void>
  close: () => void
}

const EMPTY = {
  phase: 'idle' as SwitchoverPhase,
  target: null,
  source: null,
  copy: null,
  cloud: null,
  safety: null,
  plan: null,
  rows: [],
  defaults: {},
  ticked: [],
  result: null,
  failure: null,
  error: null
}

/** Bumped by every open and close, so an answer for a flow the author left is dropped. */
let generation = 0

/** The cloud folder the open project lives in (the status bar's), or null for a plain folder. */
const cloudNow = (): CloudProvider | null => useCloudSyncStore.getState().status?.provider ?? null

export const useSwitchoverStore = create<SwitchoverState>((set, get) => {
  /** The dry run of the open project (or copy), then `plan`; an error goes back to the intro. */
  const loadPlan = async (mine: number): Promise<void> => {
    try {
      const plan = await ipc().invoke('switchover:plan', undefined)
      if (mine === generation) set({ phase: 'plan', plan })
    } catch (err) {
      if (mine === generation) set({ phase: 'intro', error: describeError(err) })
    }
  }

  return {
    ...EMPTY,

    async open() {
      if (get().phase !== 'idle') return
      const mine = ++generation
      const current = useProjectStore.getState().current
      set({ ...EMPTY, phase: 'intro', source: current?.path ?? null, cloud: cloudNow() })
      try {
        const trial = await ipc().invoke('switchover:trial', undefined)
        if (mine !== generation) return
        // A test copy already open (the author closed the dialog in it): only *Switch this copy…*,
        // and its final screen names the project it was made from.
        set(
          trial === null
            ? { target: 'project' }
            : { target: 'copy', source: trial.source, copy: current?.path ?? null }
        )
      } catch (err) {
        if (mine === generation) set({ target: 'project', error: describeError(err) })
      }
    },

    async tryCopy() {
      const state = get()
      if (state.phase !== 'intro' || state.target !== 'project') return
      const mine = generation
      set({ phase: 'copying', failure: null, error: null })
      let copy: string
      try {
        copy = await useProjectStore.getState().openSwitchoverCopy()
      } catch (err) {
        if (mine === generation) set({ phase: 'intro', error: describeError(err) })
        return
      }
      if (mine !== generation) return
      // The copy is open from here on: a failed dry run leaves the intro offering *Switch this copy…*.
      set({ target: 'copy', copy, cloud: cloudNow() })
      await loadPlan(mine)
    },

    async switchThis() {
      const state = get()
      if (state.phase !== 'intro' || state.target === null) return
      const mine = generation
      if (state.target === 'copy') {
        set({ phase: 'copying', failure: null, error: null })
        await loadPlan(mine)
        return
      }
      set({ phase: 'safety', failure: null, error: null, cloud: cloudNow() })
      try {
        // The scene open behind the dialog may hold an unsaved edit: it is in the backup and the
        // dated copy, which main makes from the project as it reads after this.
        await flushPendingSaves()
        const outcome = await ipc().invoke('switchover:safety', undefined)
        if (mine !== generation) return
        if (!outcome.ok) {
          set({ phase: 'intro', failure: outcome })
          return
        }
        set({ safety: { backup: outcome.backup, datedCopy: outcome.datedCopy } })
      } catch (err) {
        if (mine === generation) set({ phase: 'intro', error: describeError(err) })
        return
      }
      await loadPlan(mine)
    },

    async retry() {
      const { phase } = get()
      if (phase === 'intro') await get().switchThis()
      else if (phase === 'consent') await get().convert()
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
      if (get().phase === 'consent') set({ phase: 'plan', error: null, failure: null })
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
      const { rows, defaults, ticked, plan, target } = get()
      if (plan === null || get().phase !== 'consent') return
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
      set({ phase: 'converting', error: null, failure: null })
      let result: SwitchoverResult
      try {
        // The scene open behind the dialog may hold an unsaved edit: it is written before the
        // conversion reads it, and nothing is pending when main closes the project.
        await flushPendingSaves()
        const outcome = await ipc().invoke('switchover:convert', { consent, projectId })
        if (!outcome.ok) {
          // A step failed and nothing changed: what failed, and the next step.
          if (mine === generation) set({ phase: 'consent', failure: outcome })
          return
        }
        result = outcome
      } catch (err) {
        if (mine === generation) set({ phase: 'consent', error: describeError(err) })
        return
      }
      if (mine !== generation) return
      // Converted: main closed the project. A failure from here on is the reopen's, never the
      // conversion's, so the done screen says so rather than offering Convert again.
      set({ result })
      try {
        await useProjectStore.getState().open(result.folder)
        if (mine === generation) set({ phase: 'done' })
      } catch (err) {
        if (mine !== generation) return
        const what = target === 'copy' ? 'The copy is converted' : 'Your project is switched'
        set({
          phase: 'done',
          error: `${what}, but it did not open again: ${describeError(err)} Open it from File › Open project….`
        })
      }
    },

    async openMyProject() {
      const { source } = get()
      get().close()
      if (source === null) return
      try {
        await useProjectStore.getState().open(source)
      } catch (err) {
        toast.error(describeError(err))
      }
    },

    close() {
      const { phase, target, safety } = get()
      generation += 1
      set({ ...EMPTY })
      // Left after the safety step on the project itself: nothing changed, and the copies made a
      // moment ago stay (decision SW-D11's way back needs no undo here).
      if (target === 'project' && safety !== null && (phase === 'plan' || phase === 'consent')) {
        toast.info(
          `Nothing was changed. The backup and the dated copy made a moment ago stay where they are: ${safety.backup} · ${safety.datedCopy}`
        )
      }
    }
  }
})

/** Tests: back to a fresh store. */
export function resetSwitchoverStore(): void {
  generation += 1
  useSwitchoverStore.setState({ ...EMPTY })
}
