import { sentenceHash } from './anchor'

/**
 * Spot checks (F-16.17; design §2.3 "Measuring accuracy without a gold set" 3, plan P2a §3.5,
 * P2a-D8): after a *Rebuild memory*, 50 claims proved in code go back through the fast checker
 * (10 per call) and 20 claims the checker passed go to the strong model (one per call, three
 * sentences either side, 40 tokens out). From then on, 1 new claim in 20 is checked: a literal one
 * rides its own reading's check batch, a verified one waits for the next strong batch (sent once 5
 * are due). A strong rejection deletes the claim; a fast disagreement with code is only counted.
 * Settings shows "proof agreement: 48 of 50 checked", never "accuracy".
 */

export const REBUILD_FAST_CHECKS = 50
export const REBUILD_STRONG_CHECKS = 20
/** Claims per fast spot-check call. */
export const SPOT_FAST_BATCH = 10
/** After a rebuild, one new claim in this many is checked. */
export const SPOT_EVERY = 20
/** Verified claims waiting before a strong batch is sent. */
export const SPOT_STRONG_DUE = 5
/** Sentences either side of the quote a strong check reads. */
export const SPOT_STRONG_AROUND = 3

/**
 * Whether the claim with this key is one of the `every` checked: a stable pick by hash, so the
 * same claim is picked (or not) whichever reading or session meets it.
 */
export function spotPicked(key: string, every: number = SPOT_EVERY): boolean {
  if (every <= 1) return true
  return Number.parseInt(sentenceHash(key).slice(-8), 16) % every === 0
}
