import type { SceneRefView, ThreadMemoryView, ThreadStepView } from '@shared/memory/views'
import { NOT_IN_BOOK_NOW, scopeText } from '../knows/knowsView'

/**
 * The words of the threads (F-16.23; design §2.5 and §2.7, plan P2b §5.2): a thread's status as of
 * a scene, a step's line, and the scoped absence lines ("No scene shows this thread yet (checked
 * up to 14.2)"), made here and in `knowsView.ts` only (P2b rule 9). Nothing here reaches a prompt.
 * Pure.
 */

/** Where the thread was revealed (its defining quote, else a merged one), or null. */
const revealOf = (thread: ThreadMemoryView): SceneRefView | null =>
  thread.defining ?? thread.merged[0] ?? null

/**
 * A thread's status as of the scene (P2b-D22): "open since 2.1 · last 7.3" ("open since 2.1" while
 * nothing came after the opening), "resolved in 20.1". Before a step that counts, never an absence
 * stated as fact (P2b rule 9): "revealed in 1.1 · no opening step read yet" (or "· none of its
 * steps counts yet" beside muted ones, "· its first step comes later"); with no reveal, "not
 * opened (checked up to 14.2)".
 */
export function threadStatusText(
  thread: ThreadMemoryView,
  checkedUpTo: SceneRefView | null
): string {
  if (thread.status === 'resolved' && thread.resolved !== null) {
    return `resolved in ${thread.resolved.ref}`
  }
  if (thread.status === 'open' && thread.opened !== null) {
    const last =
      thread.last !== null && thread.last.nodeId !== thread.opened.nodeId
        ? ` · last ${thread.last.ref}`
        : ''
    return `open since ${thread.opened.ref}${last}`
  }
  const reveal = revealOf(thread)
  const pending =
    thread.steps.length > 0
      ? 'none of its steps counts yet'
      : thread.later > 0
        ? 'its first step comes later'
        : null
  if (reveal !== null) return `revealed in ${reveal.ref} · ${pending ?? 'no opening step read yet'}`
  return pending ?? `not opened ${scopeText(checkedUpTo)}`
}

/**
 * Whether a thread shows the scoped "No scene shows this thread yet": only with no reveal, no step
 * as of the scene and none later (the author's thread no scene has touched, plan P2b §5.2).
 */
export const showsNoSteps = (thread: ThreadMemoryView): boolean =>
  revealOf(thread) === null && thread.steps.length === 0 && thread.later === 0

/** A step's line: "advances 7.3: Johanna writes to Ashby". */
export function stepText(step: ThreadStepView): string {
  return `${step.step} ${step.ref}: ${step.value}`
}

/** Why a step is listed muted (remembered, rumoured, supposed, dreamt): it moves no status. */
export function mutedStepNote(step: ThreadStepView): string | null {
  if (step.counted) return null
  if (step.voice === 'rumour') return 'rumoured'
  if (step.mode === 'memory') return 'remembered'
  if (step.mode === 'dream') return 'dreamt'
  if (step.mode === 'hypothetical') return 'only supposed'
  return 'not counted'
}

/** A thread with no step as of the scene, scoped: "No scene shows this thread yet (checked up to 14.2)". */
export const noStepsText = (checkedUpTo: SceneRefView | null): string =>
  `No scene shows this thread yet ${scopeText(checkedUpTo)}`

/**
 * A named record's sheet with no step naming it as of the scene, scoped: "No scene shows a thread
 * step naming Mara (checked up to 1.2)".
 */
export const noStepsNamingText = (name: string, checkedUpTo: SceneRefView | null): string =>
  `No scene shows a thread step naming ${name} ${scopeText(checkedUpTo)}`

/** The Book's Threads with none listed, scoped: "No plot thread found (checked up to 1.2)". */
export const noThreadsText = (checkedUpTo: SceneRefView | null): string =>
  `No plot thread found ${scopeText(checkedUpTo)}`

/**
 * A sidebar row's note for a thread, as of the end of the book: its status; an AI-made thread the
 * Threads do not hold says where it may still be; nothing until they have loaded.
 */
export function threadSummary(
  thread: ThreadMemoryView | undefined,
  checkedUpTo: SceneRefView | null,
  aiMade = false
): string {
  if (thread === undefined) return aiMade ? NOT_IN_BOOK_NOW : ''
  return threadStatusText(thread, checkedUpTo)
}
