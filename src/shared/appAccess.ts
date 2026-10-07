import { z } from 'zod'

/**
 * The app license and the free trial (AI-BILLING-SPEC M1, decided 2026-10-07): MythScribe is a
 * one-time purchase with a 30-day trial that needs no card. After the trial, without the license,
 * every project opens read-only; export and backup always work, so writing is never trapped.
 *
 * The license is the F-15.9 token (`license.ts`): the Worker grants the same license row for the
 * app purchase as it did for the Supporter product, and main verifies it the same way. This file
 * owns only the trial clock and the state the renderer sees; main owns the clock's storage
 * (`app-state.json`) and the gate (`src/main/account/appAccess.ts`).
 */

/** Calendar days of free use from the first launch. */
export const APP_TRIAL_DAYS = 30

/** Every refusal of a write after the trial says this; the banner says the same in its own words. */
export const TRIAL_ENDED_MESSAGE =
  'Your 30-day trial has ended, so this project is read-only. Buy MythScribe on the Account tab in ' +
  'Settings to keep writing; export and backup still work.'

/**
 * The trial clock as stored in `app-state.json`. `lastSeenAt` only moves forward, so turning the
 * system clock back does not give days back. Not a secret and not signed: it keeps honest users
 * honest, nothing more (decided by Claude, unconfirmed; `QUESTIONS.md`).
 */
export const AppTrial = z.object({
  /** Epoch ms of the first launch that had the trial. */
  startedAt: z.number().int().nonnegative(),
  /** The latest time the app has seen; the clock never reads earlier than this. */
  lastSeenAt: z.number().int().nonnegative()
})
export type AppTrial = z.infer<typeof AppTrial>

export const AppAccessState = z.enum(['trial', 'licensed', 'expired'])
export type AppAccessState = z.infer<typeof AppAccessState>

/** What the renderer sees (`app:getAccess`, `app:accessChanged`). */
export const AppAccess = z.object({
  state: AppAccessState,
  /** ISO timestamp of the local midnight that ends the trial. */
  trialEndsAt: z.string(),
  /** Calendar days of trial left, today included; 0 once it has ended. */
  daysLeft: z.number().int().nonnegative()
})
export type AppAccess = z.infer<typeof AppAccess>

const DAY_MS = 24 * 60 * 60_000

/** Local midnight at the start of the day `ms` falls on. */
function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * The trial ends at local midnight `APP_TRIAL_DAYS` calendar days after the day it started, so a
 * trial started at any hour on the 1st ends as the 31st begins.
 */
export function trialEndsAt(startedAt: number): number {
  const d = new Date(startedAt)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + APP_TRIAL_DAYS).getTime()
}

/** Starts the clock on the first launch, and moves `lastSeenAt` forward (never back) after that. */
export function touchTrial(trial: AppTrial | null, now: number): AppTrial {
  if (trial === null) return { startedAt: now, lastSeenAt: now }
  return { startedAt: trial.startedAt, lastSeenAt: Math.max(trial.lastSeenAt, now) }
}

/**
 * The access the app grants now. A license wins; otherwise the trial counts calendar days from
 * the later of the real clock and the last time the app saw it.
 */
export function appAccessFor(trial: AppTrial, licensed: boolean, now: number): AppAccess {
  const endsAt = trialEndsAt(trial.startedAt)
  const clock = Math.max(now, trial.lastSeenAt)
  // Rounded: a day across a daylight-saving change is 23 or 25 hours long.
  const daysLeft = Math.max(0, Math.round((endsAt - startOfDay(clock)) / DAY_MS))
  const state: AppAccessState = licensed ? 'licensed' : clock < endsAt ? 'trial' : 'expired'
  return { state, trialEndsAt: new Date(endsAt).toISOString(), daysLeft }
}

/** Whether the app may change projects and call AI: during the trial or with the license. */
export function canWrite(access: AppAccess | null): boolean {
  return access?.state !== 'expired'
}

/** The trial line for the banner and the Account tab: "12 days left in your trial". */
export function trialDaysText(daysLeft: number): string {
  return daysLeft === 1 ? '1 day left in your trial' : `${daysLeft} days left in your trial`
}
