import type { AiSettings } from '@shared/aiSettings'
import type { RebuildEstimate } from '@shared/memory/switchover'
import type { MemoryStatus } from '@shared/memory/views'
import { formatCents, formatCount } from '@renderer/features/ai/usageFormat'

/**
 * The final screen's *Rebuild memory* ask (F-16.31 part A, plan `Switchover.md` §4.1, decisions
 * SW-D8 and SW-D9): once the project is open again on the new story memory, the rebuild is asked
 * for once, with its price, or the screen says why it waits and that This scene › Needs a look
 * will offer it. Pure: the store reads `memory:status`, `aiSettings:get` and the price, and these
 * decide and word what it shows.
 */
export type RebuildAsk =
  /** The status, the settings and the price are being read. */
  | { kind: 'reading' }
  /** Use AI is off: nothing is read and nothing is spent. */
  | { kind: 'aiOff' }
  /** Use AI is on, the Story memory reading switch off. */
  | { kind: 'readingOff' }
  /** No key, no Cloud sign-in, no local server. */
  | { kind: 'noProvider' }
  /** The active draft has no scene to read. */
  | { kind: 'nothing' }
  /** MythScribe Cloud has not sent its prices yet: never started without one (SW-D9). */
  | { kind: 'cloudUnpriced'; estimate: RebuildEstimate }
  /**
   * *Rebuild now* and *Later*. `starting` while `memory:rebuild` runs; `refused` is main's answer
   * when it would not start (its message and next step), with *Later* still there.
   */
  | { kind: 'offer'; estimate: RebuildEstimate; starting: boolean; refused: string | null }
  /** A read failed: the price is not known, and Needs a look will offer it. */
  | { kind: 'unknown'; message: string }

/**
 * Before any price: why the rebuild cannot be asked for now (main's own view of the reading
 * switch and the provider, the reason its footer would give), or null when it can be priced.
 */
export function heldAsk(
  status: Pick<MemoryStatus, 'paused'>,
  settings: Pick<AiSettings, 'dial'>
): RebuildAsk | null {
  if (status.paused === 'off') return { kind: settings.dial === 0 ? 'aiOff' : 'readingOff' }
  if (status.paused === 'noProvider') return { kind: 'noProvider' }
  return null
}

/**
 * With reading allowed and a provider: the ask the price makes. An own key with a model missing
 * from the price table may start (the author's own key, P2a's rule); Cloud without its prices
 * may not.
 */
export function pricedAsk(estimate: RebuildEstimate): RebuildAsk {
  if (estimate.scenes === 0) return { kind: 'nothing' }
  if (estimate.source === 'cloud' && !estimate.priced) return { kind: 'cloudUnpriced', estimate }
  return { kind: 'offer', estimate, starting: false, refused: null }
}

/** Whether the ask offers *Rebuild now*. */
export const offersRebuild = (ask: RebuildAsk | null): boolean => ask?.kind === 'offer'

/** Whether the screen's way out is *Later* (the rebuild was offered or waits on a price). */
export const laterAsk = (ask: RebuildAsk | null): boolean =>
  ask?.kind === 'offer' || ask?.kind === 'cloudUnpriced'

const KEPT = 'Your text, Pinned, Ideas and Dismissed stay as they are.'
const NEEDS_A_LOOK = 'This scene › Needs a look offers Rebuild memory with its price.'

/** "about a minute", "about 12 minutes". */
function aboutMinutes(minutes: number): string {
  return minutes <= 1 ? 'about a minute' : `about ${formatCount(minutes, 'minute')}`
}

/** What the rebuild costs, where it is paid from, and how long it takes. */
function offerLine(estimate: RebuildEstimate): string {
  const reads = `Rebuild memory now: the AI reads ${formatCount(estimate.scenes, 'scene')} once`
  const time = aboutMinutes(estimate.minutes)
  if (estimate.source === 'local') return `${reads}, free on your local model (${time}). ${KEPT}`
  if (estimate.source === 'cloud') {
    return (
      `${reads}, about ${formatCents(estimate.costUsd)} from your MythScribe Cloud balance (${time}). ` +
      'It is not counted toward your monthly reading cap; today’s AI spending cap still applies, ' +
      `so a long book may finish tomorrow. ${KEPT}`
    )
  }
  const cost = estimate.priced
    ? `about ${formatCents(estimate.costUsd)}`
    : 'a cost not yet known (a model is not in the price table)'
  return `${reads}, ${cost} on your own key (${time}). ${KEPT}`
}

/** The ask's line on the final screen. */
export function rebuildAskLine(ask: RebuildAsk): string {
  switch (ask.kind) {
    case 'reading':
      return 'Working out what Rebuild memory would cost…'
    case 'aiOff':
      return `Use AI is off, so nothing is read and nothing is spent. When you turn it on in Settings › AI, ${NEEDS_A_LOOK}`
    case 'readingOff':
      return `Story memory reading is off, so nothing is read and nothing is spent. When you turn it on in Settings › AI, ${NEEDS_A_LOOK}`
    case 'noProvider':
      return 'Story memory needs an AI provider: add a key or sign in to MythScribe Cloud in Settings › AI. Needs a look then offers Rebuild memory with its price.'
    case 'nothing':
      return 'Rebuild memory: nothing to read yet. Needs a look offers it once the book has scenes to read.'
    case 'cloudUnpriced':
      return 'MythScribe Cloud has not sent its prices yet. Needs a look will offer Rebuild memory with its price.'
    case 'offer':
      return offerLine(ask.estimate)
    case 'unknown':
      return `Could not work out what Rebuild memory would cost: ${ask.message} ${NEEDS_A_LOOK}`
  }
}
