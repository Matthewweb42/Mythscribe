import {
  type AppAccess,
  appAccessFor,
  TRIAL_ENDED_MESSAGE,
  touchTrial,
  trialEndsAt
} from '@shared/appAccess'
import type { AppStateStore } from '../appState/appStateStore'
import { AppError } from '../ipc/errors'
import { defaultSchedule, type Schedule } from '../schedule'

/**
 * The one owner of what the app may do (AI-BILLING-SPEC M1): the 30-day trial clock in
 * `app-state.json`, the license (the F-15.9 token, through `licensed`), and the read-only state
 * after the trial. The IPC gate (`channelAccess.ts`) and the AI request path ask it; the renderer
 * hears every change as `app:accessChanged`.
 *
 * The state is cached and recomputed on a timer (at most hourly, and exactly at the trial's end)
 * and whenever the license changes, so the gate costs nothing per call. The timer also moves the
 * clock's `lastSeenAt` forward, which is what makes turning the system clock back useless.
 */

/**
 * The author's own exemption (decided by the author 2026-10-10): with this environment variable
 * set to `1` on their machine, the app answers as licensed, so their copy never turns read-only
 * from the trial or from a license check that expired offline. It is read in main only, at
 * launch; no setting, menu, or channel reads or writes it, so nothing in the UI can turn it on.
 * Documented for the author in `docs/PERSONAL-USE.md`.
 */
export const DEV_LICENSE_ENV = 'MYTHSCRIBE_DEV_LICENSE'

/** Whether the developer exemption is on: exactly `1` (spaces trimmed), nothing looser. */
export function devLicenseExempt(env: Record<string, string | undefined>): boolean {
  return env[DEV_LICENSE_ENV]?.trim() === '1'
}

/** How often the state is recomputed while the app runs: a token's `exp` passes without an event. */
export const ACCESS_RECHECK_MS = 60 * 60_000

export interface AppAccessServiceOptions {
  appState: AppStateStore
  /** Whether a verified app license is held now (`AccountService.supporter().licensed`). */
  licensed: () => boolean
  onChange: (access: AppAccess) => void
  /**
   * Whether the trial can end. False in a build that cannot verify a license (the placeholder
   * key, `licenseVerifiable`) and under the developer exemption (`devLicenseExempt`): the app
   * then answers as licensed and never turns read-only.
   */
  enforced?: boolean
  now?: () => number
  schedule?: Schedule
}

export class AppAccessService {
  private current: AppAccess
  private cancelTimer: (() => void) | null = null
  private disposed = false

  private readonly appState: AppStateStore
  private readonly licensed: () => boolean
  private readonly onChange: (access: AppAccess) => void
  private readonly enforced: boolean
  private readonly now: () => number
  private readonly schedule: Schedule

  constructor(options: AppAccessServiceOptions) {
    this.appState = options.appState
    this.licensed = options.licensed
    this.onChange = options.onChange
    this.enforced = options.enforced ?? true
    this.now = options.now ?? (() => Date.now())
    this.schedule = options.schedule ?? defaultSchedule
    this.current = this.compute()
    this.arm()
  }

  status(): AppAccess {
    return this.current
  }

  /** Whether projects may change and AI may run: during the trial or with the license. */
  writable(): boolean {
    return this.current.state !== 'expired'
  }

  /** The gate every project write passes; refuses with the message the author can act on. */
  assertWritable(): void {
    if (!this.writable()) {
      throw new AppError('VALIDATION', TRIAL_ENDED_MESSAGE, { code: 'TRIAL_ENDED' })
    }
  }

  /**
   * Recomputes now: the license changed (a refresh, a sign-in, a sign-out), or a caller wants the
   * freshest answer. Pushes `onChange` only when the state the renderer sees changed.
   */
  refresh(): AppAccess {
    const before = this.current
    this.current = this.compute()
    if (!sameAccess(before, this.current)) this.onChange(this.current)
    return this.current
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  /** Starts or advances the stored clock, then answers the access it gives. */
  private compute(): AppAccess {
    const now = this.now()
    const stored = this.appState.get().trial
    const trial = touchTrial(stored, now)
    if (stored?.lastSeenAt !== trial.lastSeenAt) {
      this.appState.update((s) => ({ ...s, trial }))
    }
    return appAccessFor(trial, !this.enforced || this.licensed(), now)
  }

  private arm(): void {
    if (this.disposed) return
    const trial = this.appState.get().trial
    const untilEnd = trial === null ? ACCESS_RECHECK_MS : trialEndsAt(trial.startedAt) - this.now()
    const delay = untilEnd > 0 ? Math.min(untilEnd, ACCESS_RECHECK_MS) : ACCESS_RECHECK_MS
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      if (this.disposed) return
      this.refresh()
      this.arm()
    }, delay)
  }
}

function sameAccess(a: AppAccess, b: AppAccess): boolean {
  return a.state === b.state && a.trialEndsAt === b.trialEndsAt && a.daysLeft === b.daysLeft
}
