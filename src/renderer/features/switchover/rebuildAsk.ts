import type { AiSettings } from '@shared/aiSettings'
import {
  cloudUnpriced,
  cloudUnpricedRefusal,
  type RebuildEstimate
} from '@shared/memory/switchover'
import type { MemoryStatus } from '@shared/memory/views'
import { formatCount } from '@renderer/features/ai/usageFormat'
import { aboutMinutes, CLOUD_REBUILD_CAPS, rebuildCost } from '@renderer/features/memory/memoryView'

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
  /**
   * Today's AI spending cap stopped the reading (main's status): main would not start the
   * rebuild either, so it waits for a higher cap or tomorrow.
   */
  | { kind: 'dailyCap' }
  /** The active draft has no scene to read. */
  | { kind: 'nothing' }
  /**
   * MythScribe Cloud has no price for a model story memory uses (one it does not offer): never
   * started without its price (SW-D9; main refuses it too).
   */
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
  if (status.paused === 'dailyCap') return { kind: 'dailyCap' }
  return null
}

/**
 * With reading allowed and a provider: the ask the price makes. An own key with a model missing
 * from the price table may start (the author's own key, P2a's rule); Cloud without its price
 * may not (`cloudUnpriced`, the rule main and the rebuild dialog keep too).
 */
export function pricedAsk(estimate: RebuildEstimate): RebuildAsk {
  if (estimate.scenes === 0) return { kind: 'nothing' }
  if (cloudUnpriced(estimate)) return { kind: 'cloudUnpriced', estimate }
  return { kind: 'offer', estimate, starting: false, refused: null }
}

/** Whether the ask offers *Rebuild now*. */
export const offersRebuild = (ask: RebuildAsk | null): boolean => ask?.kind === 'offer'

/** Whether the screen's way out is *Later* (offered, or waiting on a price or today's cap). */
export const laterAsk = (ask: RebuildAsk | null): boolean =>
  ask?.kind === 'offer' || ask?.kind === 'cloudUnpriced' || ask?.kind === 'dailyCap'

const KEPT = 'Your text, Pinned, Ideas and Dismissed stay as they are.'
const NEEDS_A_LOOK = 'This scene › Needs a look offers Rebuild memory with its price.'

/**
 * A test copy's rebuild reads the copy only: switching the project later needs its own, at about
 * the same price (Switch-over slice 4 review), so the whole book is never paid for twice unasked.
 */
function testCopyLine(estimate: RebuildEstimate): string {
  return `This reads the test copy only: when you switch your project, it needs its own Rebuild memory${estimate.source === 'local' ? '' : ', at about the same price'}.`
}

/** What the rebuild costs, where it is paid from (`rebuildCost`), and how long it takes. */
function offerLine(estimate: RebuildEstimate, onCopy: boolean): string {
  const reads = `Rebuild memory now: the AI reads ${formatCount(estimate.scenes, 'scene')} once, ${rebuildCost(estimate)} (${aboutMinutes(estimate.minutes)}).`
  const caps = estimate.source === 'cloud' ? ` ${CLOUD_REBUILD_CAPS}` : ''
  const copy = onCopy ? ` ${testCopyLine(estimate)}` : ''
  return `${reads}${caps} ${KEPT}${copy}`
}

/** The ask's line on the final screen; `onCopy` on a test copy's. */
export function rebuildAskLine(ask: RebuildAsk, onCopy = false): string {
  switch (ask.kind) {
    case 'reading':
      return 'Working out what Rebuild memory would cost…'
    case 'aiOff':
      return `Use AI is off, so nothing is read and nothing is spent. When you turn it on in Settings › AI, ${NEEDS_A_LOOK}`
    case 'readingOff':
      return `Story memory reading is off, so nothing is read and nothing is spent. When you turn it on in Settings › AI, ${NEEDS_A_LOOK}`
    case 'noProvider':
      return 'Story memory needs an AI provider: add a key or sign in to MythScribe Cloud in Settings › AI. Needs a look then offers Rebuild memory with its price.'
    case 'dailyCap':
      return `Today’s AI spending cap is reached, so Rebuild memory waits and nothing more is spent today. When you raise the cap in Settings › AI, or tomorrow, ${NEEDS_A_LOOK}`
    case 'nothing':
      return 'Rebuild memory: nothing to read yet. Needs a look offers it once the book has scenes to read.'
    case 'cloudUnpriced': {
      // Main's own refusal, word for word, then where the rebuild is offered once it has a price.
      const refusal = cloudUnpricedRefusal(ask.estimate)
      return `${refusal.message} ${refusal.nextStep} Then ${NEEDS_A_LOOK}`
    }
    case 'offer':
      return offerLine(ask.estimate, onCopy)
    case 'unknown':
      return `Could not work out what Rebuild memory would cost: ${ask.message} ${NEEDS_A_LOOK}`
  }
}
