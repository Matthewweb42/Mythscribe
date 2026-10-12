import { z } from 'zod'

/**
 * Story memory v2's Cloud monthly cap (F-16.19; design decision 7, answer 17, plan P2a §3.6):
 * on MythScribe Cloud, reading the author did not ask for (leaving a scene, the idle pause, a
 * small backlog or back-fill, spot checks after a reading) spends up to a monthly cap, $1 by
 * default. Work she asked for or confirmed with its price (*Read now*, *Rebuild memory*, a priced
 * backlog or back-fill) is never held back by it (P2a-D9). Own key and local models have no cap.
 */

export const CLOUD_CAP_DEFAULT_USD = 1
/** Settings changes the cap in quarter-dollar steps, up to this. */
export const CLOUD_CAP_STEP_USD = 0.25
export const CLOUD_CAP_MAX_USD = 20
/** What *Allow another $1 this month* adds. */
export const CLOUD_CAP_EXTRA_USD = 1

/** A cap in quarter-dollar steps between $0 and $20. */
export const CloudCapUsd = z
  .number()
  .min(0)
  .max(CLOUD_CAP_MAX_USD)
  .refine(
    (usd) => Math.abs(usd / CLOUD_CAP_STEP_USD - Math.round(usd / CLOUD_CAP_STEP_USD)) < 1e-9,
    `The cap goes in steps of $${CLOUD_CAP_STEP_USD.toFixed(2)}`
  )

/** `cloudCap:get` / `cloudCap:set`: this month's cap and what background reading spent of it. */
export const CloudCapState = z.object({
  /** The local month (`YYYY-MM`) the figures belong to. */
  month: z.string(),
  capUsd: z.number().nonnegative(),
  /** What *Allow another $1 this month* added this month. */
  extraUsd: z.number().nonnegative(),
  backgroundUsd: z.number().nonnegative(),
  askedUsd: z.number().nonnegative(),
  /** `capUsd + extraUsd`: where background reading stops. */
  limitUsd: z.number().nonnegative(),
  reached: z.boolean()
})
export type CloudCapState = z.infer<typeof CloudCapState>
