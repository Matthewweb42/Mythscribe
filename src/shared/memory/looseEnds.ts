import type { ReadingOrder } from './asOf'
import { dismissedKey, type LooseEndKind } from './dismissed'
import type { RecordOrigin } from './records'
import { stepRank } from './topics'
import type { LooseEnd, LooseEndsView, SceneRefView } from './views'

/**
 * Loose ends (F-16.29; design §2.7's Needs a look bullet, plan P4 §1.2, P4-D19), pure, local and
 * free: what the book leaves hanging behind the furthest drafted scene, each with the question
 * *Ask Ms Scribe* sends. The window is max(8 scenes, a quarter of the readable scenes):
 * - **threads** the author made, or with at least two counted steps, not resolved, whose last touch
 *   (a counted step or a live reveal) lies a window or more behind the horizon, the earlier of the
 *   furthest drafted scene and "checked up to" (claims exist only for read scenes, so the scope
 *   stays honest); a thread nothing has touched yet is not one;
 * - **characters** named in at least 3 scenes, not dead as of their last naming, last named a
 *   window or more before the furthest drafted scene (the name scan is local and current, so this
 *   works with Use AI off);
 * - **planned cards** (no words) placed before the furthest drafted scene with no link (the
 *   author's or a live AI-made one) to a drafted scene.
 * Absence is never a fact (P2b rule 9): the `ask` texts are worded positively, and the scoped line
 * ("nothing since, checked up to 18.2") is the renderer's alone.
 */

/** The most loose ends shown; the rest are counted (`more`). */
export const LOOSE_ENDS_MAX = 10
/** The smallest window, in scenes (design §2.7). */
export const LOOSE_WINDOW_MIN = 8
/** A character counts once named in this many scenes. */
export const LOOSE_CHARACTER_SCENES = 3

/** The window: max(8 scenes, a quarter of the readable scenes, rounded up). */
export const looseWindow = (readable: number): number =>
  Math.max(LOOSE_WINDOW_MIN, Math.ceil(readable / 4))

/** A thread as loose ends read it: its counted steps and its live reveals, in readable scenes. */
export interface LooseThread {
  recordId: string
  label: string
  origin: RecordOrigin
  /** Counted steps (`stepCounts`): where, and which. */
  steps: readonly { nodeId: string; step: 'opens' | 'advances' | 'resolves' }[]
  /** Live reveals (`topic_quote`). */
  reveals: readonly { nodeId: string }[]
}

/** A character as loose ends read it: the scenes the name scan names them in, and whether they are dead there. */
export interface LooseCharacter {
  recordId: string
  name: string
  /** The readable scenes naming them for certain (the name scan, ambiguous spans left out). */
  namedIn: readonly string[]
  /** Dead as of a scene (a narration-now `alive` value reading as a death, latest up to it). */
  deadAt: (nodeId: string) => boolean
}

/** A planned scene: no words, readable, with no link to a drafted scene. */
export interface LoosePlanned {
  nodeId: string
  title: string
}

export interface LooseEndsInput {
  reading: ReadingOrder
  /** Readable scenes with words. */
  drafted: ReadonlySet<string>
  checkedUpTo: SceneRefView | null
  threads: readonly LooseThread[]
  characters: readonly LooseCharacter[]
  planned: readonly LoosePlanned[]
  /** The `notProblem` keys on the Dismissed list. */
  dismissed: ReadonlySet<string>
}

/** A loose end's *Not a problem* key: what it is and where it was last touched (a later touch brings it back). */
export const looseKey = (kind: LooseEndKind, id: string, lastNodeId: string | null): string =>
  dismissedKey({ kind: 'notProblem', loose: { kind, id, lastNodeId } })

/** How a thread's last touch reads in its question. */
const TOUCH_VERB: Readonly<Record<'opens' | 'advances' | 'reveal', string>> = {
  opens: 'was opened',
  advances: 'was last advanced',
  reveal: 'last came up'
}

/**
 * Every loose end, oldest first (its last touch, or a planned card's own place), at most
 * `LOOSE_ENDS_MAX` with the rest counted; empty when the book has no drafted scene.
 */
export function looseEnds(input: LooseEndsInput): LooseEndsView {
  const { reading } = input
  const refOf = (nodeId: string): SceneRefView => ({ nodeId, ref: reading.refs.get(nodeId) ?? '' })
  const orderOf = (nodeId: string): number => reading.order.get(nodeId) ?? -1
  const furthestId =
    [...input.drafted]
      .filter((nodeId) => reading.order.has(nodeId))
      .sort((a, b) => orderOf(a) - orderOf(b))
      .at(-1) ?? null
  const view: LooseEndsView = {
    items: [],
    more: 0,
    furthest: furthestId === null ? null : refOf(furthestId),
    checkedUpTo: input.checkedUpTo
  }
  if (furthestId === null) return view
  const furthest = orderOf(furthestId)
  const window = looseWindow(reading.order.size)
  const checked = input.checkedUpTo === null ? -1 : orderOf(input.checkedUpTo.nodeId)
  const horizon = Math.min(furthest, checked)
  const horizonRef = horizon === furthest ? refOf(furthestId) : input.checkedUpTo
  const found: (LooseEnd & { order: number })[] = []
  const keep = (end: LooseEnd & { order: number }): void => {
    if (!input.dismissed.has(looseKey(end.kind, end.id, end.lastNodeId))) found.push(end)
  }

  for (const thread of input.threads) {
    const counted = thread.steps.filter((step) => reading.order.has(step.nodeId))
    if (thread.origin !== 'author' && counted.length < 2) continue
    const ordered = [...counted].sort(
      (a, b) => orderOf(a.nodeId) - orderOf(b.nodeId) || stepRank(a.step) - stepRank(b.step)
    )
    // Resolved: its last counted step resolves it (a reveal after it changes nothing).
    if (ordered.at(-1)?.step === 'resolves') continue
    const touches = [
      ...ordered.map((step) => ({
        nodeId: step.nodeId,
        how: step.step === 'opens' ? ('opens' as const) : ('advances' as const)
      })),
      ...thread.reveals
        .filter((reveal) => reading.order.has(reveal.nodeId))
        .map((reveal) => ({ nodeId: reveal.nodeId, how: 'reveal' as const }))
    ].sort((a, b) => orderOf(a.nodeId) - orderOf(b.nodeId))
    const last = touches.at(-1)
    if (last === undefined) continue
    if (horizon - orderOf(last.nodeId) < window || horizonRef === null) continue
    const lastRef = refOf(last.nodeId).ref
    // Scenes past "checked up to" are not read yet: the question says how far its "last" holds.
    const scope = horizon < furthest ? ` (as far as the book is read, up to ${horizonRef.ref})` : ''
    keep({
      kind: 'thread',
      id: thread.recordId,
      name: thread.label,
      lastRef,
      lastNodeId: last.nodeId,
      horizonRef: horizonRef.ref,
      checkedUpTo: input.checkedUpTo,
      ask: `${thread.label} ${TOUCH_VERB[last.how]} in ${lastRef}${scope}. Where does it go next?`,
      order: orderOf(last.nodeId)
    })
  }

  for (const character of input.characters) {
    const named = [...new Set(character.namedIn)]
      .filter((nodeId) => reading.order.has(nodeId))
      .sort((a, b) => orderOf(a) - orderOf(b))
    if (named.length < LOOSE_CHARACTER_SCENES) continue
    const last = named.at(-1)
    if (last === undefined || character.deadAt(last)) continue
    if (furthest - orderOf(last) < window) continue
    const lastRef = refOf(last).ref
    keep({
      kind: 'character',
      id: character.recordId,
      name: character.name,
      lastRef,
      lastNodeId: last,
      horizonRef: refOf(furthestId).ref,
      checkedUpTo: input.checkedUpTo,
      ask: `${character.name} is last named in ${lastRef}. Where is ${character.name} after that?`,
      order: orderOf(last)
    })
  }

  for (const plan of input.planned) {
    const order = reading.order.get(plan.nodeId)
    if (order === undefined || order >= furthest) continue
    keep({
      kind: 'planned',
      id: plan.nodeId,
      name: plan.title,
      lastRef: null,
      lastNodeId: null,
      horizonRef: refOf(furthestId).ref,
      checkedUpTo: input.checkedUpTo,
      ask: `Which drafted scene covers the plan '${plan.title}'?`,
      order
    })
  }

  const sorted = found.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  return {
    ...view,
    items: sorted.slice(0, LOOSE_ENDS_MAX).map((end): LooseEnd => ({
      kind: end.kind,
      id: end.id,
      name: end.name,
      lastRef: end.lastRef,
      lastNodeId: end.lastNodeId,
      horizonRef: end.horizonRef,
      checkedUpTo: end.checkedUpTo,
      ask: end.ask
    })),
    more: Math.max(0, sorted.length - LOOSE_ENDS_MAX)
  }
}
