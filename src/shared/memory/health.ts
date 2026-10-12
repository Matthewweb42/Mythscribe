/**
 * The health gate (F-16.17; design §2.3 "Measuring accuracy without a gold set", 2): per model,
 * over its last 20 readings, the share of proposed items whose quote was found and the share of
 * verifier checks that passed. Below 90 % or 80 % background reading pauses, with one probe read
 * per 10 due scenes, until the author keeps reading anyway or switches model. A model is judged
 * only once it has 10 readings with at least 30 items between them (P2a-D16): a new model reads
 * freely until then.
 */

export const HEALTH_WINDOW = 20
export const HEALTH_MIN_READINGS = 10
export const HEALTH_MIN_ITEMS = 30
export const HEALTH_QUOTES_MIN = 0.9
export const HEALTH_VERIFIED_MIN = 0.8
/** While paused, one due scene in this many is read as a probe. */
export const PROBE_EVERY = 10

/** The yields of one reading the gate reads (`reading` rows, newest first). */
export interface HealthReading {
  items: number
  quotesFound: number
  verifySent: number
  verified: number
}

export interface ModelHealth {
  /** Whether there is enough to judge by. */
  judged: boolean
  readings: number
  items: number
  /** Quotes found / items proposed (1 with no items). */
  quotes: number
  /** Verified / sent to the verifier (1 with none sent). */
  verified: number
  paused: boolean
  /** Which bar it fell under, quotes first. */
  reason: 'quotes' | 'verified' | null
}

const share = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole)

/** The model's health over its newest `HEALTH_WINDOW` readings (`readings` newest first). */
export function modelHealth(readings: readonly HealthReading[]): ModelHealth {
  const recent = readings.slice(0, HEALTH_WINDOW)
  const total = recent.reduce(
    (sum, reading) => ({
      items: sum.items + reading.items,
      quotesFound: sum.quotesFound + reading.quotesFound,
      verifySent: sum.verifySent + reading.verifySent,
      verified: sum.verified + reading.verified
    }),
    { items: 0, quotesFound: 0, verifySent: 0, verified: 0 }
  )
  const quotes = share(total.quotesFound, total.items)
  const verified = share(total.verified, total.verifySent)
  const judged = recent.length >= HEALTH_MIN_READINGS && total.items >= HEALTH_MIN_ITEMS
  const reason = !judged
    ? null
    : quotes < HEALTH_QUOTES_MIN
      ? 'quotes'
      : verified < HEALTH_VERIFIED_MIN
        ? 'verified'
        : null
  return {
    judged,
    readings: recent.length,
    items: total.items,
    quotes,
    verified,
    paused: reason !== null,
    reason
  }
}

/**
 * Whether a due scene is read as a probe while reading is paused: `skipped` is how many due
 * scenes were skipped since the last probe, so the tenth one probes.
 */
export function probeDue(skipped: number): boolean {
  return skipped >= PROBE_EVERY - 1
}
