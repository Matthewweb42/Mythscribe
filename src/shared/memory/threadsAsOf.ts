import type { ReadingOrder } from './asOf'
import type { ClaimMode, ClaimState, ClaimVoice } from './claims'
import type { RecordOrigin } from './records'
import { parseStep, stepRank, type ThreadStep } from './topics'
import type { SceneRefView, ThreadMemoryView, ThreadStepView } from './views'
import { topicQuotesOf, type TopicQuoteInput } from './whoKnows'

/**
 * Plot threads as of a scene (F-16.23; design §2.5, §2.7): status is derived, never stored
 * (P2b-D22). A step (`opens`, `advances`, `resolves`; a claim of slot `thread` whose record is the
 * thread) counts only in mode `now` and not as a rumour; the rest are listed muted. Within one
 * scene the text's order holds, except that a resolve comes last (`stepRank`), so a scene that
 * advances a thread and resolves it reads as resolved. A thread's reveal (its defining quote) is
 * shown as its quote, never as a status change: a reveal carries no voice or mode, so a supposed
 * or rumoured sentence ("If Mr. Ashby came back tomorrow") must not open it (P2b-D22). Pure: the
 * views of slice 5 and P3's navigator call it.
 */

/** A thread step claim as the rules read it. */
export interface ThreadStepClaim {
  id: string
  /** The thread. */
  recordId: string | null
  /** The step (`THREAD_STEPS`). */
  how: string | null
  value: string
  voice: ClaimVoice
  mode: ClaimMode
  nodeId: string
  para: number
  state: ClaimState
}

export interface ThreadInput {
  recordId: string
  label: string
  origin: RecordOrigin
}

/** Whether a step moves the status (P2b-D22): mode `now`, not a rumour. */
export const stepCounts = (claim: { voice: ClaimVoice; mode: ClaimMode }): boolean =>
  claim.mode === 'now' && claim.voice !== 'rumour'

interface PlacedStep {
  claim: ThreadStepClaim
  step: ThreadStep
  order: number
  index: number
}

export interface ThreadsAsOfInput {
  threads: readonly ThreadInput[]
  /** The draft's thread step claims (slot `thread`). */
  claims: readonly ThreadStepClaim[]
  /** The threads' reveals (`topic_quote`). */
  quotes: readonly TopicQuoteInput[]
  reading: ReadingOrder
  /** The scene it is read as of; null for the end of the book. */
  atId: string | null
}

/**
 * Every thread as of a scene (F-16.23): status (`notYet` before its first counted step, `open`
 * after an opening or an advance, `resolved` after a resolve), where it opened, its last
 * counted step, where it resolved, its steps as of the scene (counted and muted), how many steps
 * come later, and its reveals. An author's thread with no step reads `notYet` (the view scopes it
 * with `checkedUpTo`).
 */
export function threadsAsOf(input: ThreadsAsOfInput): ThreadMemoryView[] {
  const { reading, atId } = input
  const at = atId === null ? Infinity : (reading.at.get(atId) ?? -1)
  const refOf = (nodeId: string): SceneRefView => ({
    nodeId,
    ref: reading.refs.get(nodeId) ?? ''
  })
  return input.threads.map((thread) => {
    const steps: PlacedStep[] = input.claims
      .flatMap((claim, index) => {
        const step = parseStep(claim.how)
        const order = reading.order.get(claim.nodeId)
        if (
          claim.recordId !== thread.recordId ||
          claim.state === 'waiting' ||
          step === null ||
          order === undefined
        ) {
          return []
        }
        return [{ claim, step, order, index }]
      })
      .sort(
        (a, b) =>
          a.order - b.order ||
          stepRank(a.step) - stepRank(b.step) ||
          a.claim.para - b.claim.para ||
          a.index - b.index
      )
    const asOf = steps.filter((entry) => entry.order <= at)
    const counted = asOf.filter((entry) => stepCounts(entry.claim))
    const reveals = topicQuotesOf(thread.recordId, input.quotes, reading)
    const firstStep = counted[0]
    const opened = firstStep === undefined ? null : refOf(firstStep.claim.nodeId)
    const lastStep = counted[counted.length - 1]
    const resolved = lastStep?.step === 'resolves' ? refOf(lastStep.claim.nodeId) : null
    const view: ThreadStepView[] = asOf.map((entry) => ({
      claimId: entry.claim.id,
      step: entry.step,
      value: entry.claim.value,
      nodeId: entry.claim.nodeId,
      ref: reading.refs.get(entry.claim.nodeId) ?? '',
      para: entry.claim.para,
      voice: entry.claim.voice,
      mode: entry.claim.mode,
      counted: stepCounts(entry.claim),
      stale: entry.claim.state === 'stale'
    }))
    return {
      recordId: thread.recordId,
      label: thread.label,
      origin: thread.origin,
      status: resolved !== null ? 'resolved' : opened !== null ? 'open' : 'notYet',
      opened,
      last: lastStep !== undefined ? refOf(lastStep.claim.nodeId) : opened,
      resolved,
      steps: view,
      later: steps.length - asOf.length,
      ...reveals
    }
  })
}
