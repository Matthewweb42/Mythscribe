import { create } from 'zustand'
import type { AccountStatus } from '@shared/account'
import type { CreditsResult } from '@shared/cloudApi'
import type { AccentId, SupporterStatus } from '@shared/license'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer's view of the MythScribe account (F-15.2). Main owns the state machine and the
 * poll timer; this store holds the status main last answered (or pushed through
 * `account:changed` when a link was opened or expired) and the one thing the author is looking
 * at while it happens: the failure. Errors land in `error`, not in a toast, because the author
 * is inside the Account tab when they happen and the next step belongs beside the field.
 * The session token never reaches the renderer: the status only names who is signed in.
 */
interface AccountState {
  /** null until the first `load` resolves. */
  status: AccountStatus | null
  /** True while any of the account channels is in flight; the tab disables its buttons on it. */
  busy: boolean
  /** The message from the last failed action, cleared by the next one. */
  error: string | null
  /** The Cloud credits (F-15.3) of the signed-in account; null until they have been asked for. */
  credits: CreditsResult | null
  /**
   * When `credits` was last known to be current (epoch ms); null with no credits. The run-out
   * projection (F-15.5) measures the period's pace against it, so the meter is a value the
   * store owns rather than a clock read while React renders.
   */
  creditsAt: number | null
  /** True while a credits call is in flight; its own flag, so it cannot disable the sign-in row. */
  creditsBusy: boolean
  /**
   * The message from the last failed credits call. Separate from `error` so a Worker that
   * cannot answer for credits does not hide (or get hidden by) a sign-in failure.
   */
  creditsError: string | null
  /**
   * The Supporter license (F-15.9) as main sees it; null until it has been asked for. It is the
   * local cache, not the account, so it is loaded at start whether anyone is signed in or not,
   * and main pushes `account:supporterChanged` when a background refresh or a sign-out changes it.
   */
  supporter: SupporterStatus | null
  /** True while a supporter call is in flight; its own flag, like the credits one. */
  supporterBusy: boolean
  /** The message from the last failed supporter call; separate from `error` and `creditsError`. */
  supporterError: string | null
  load: () => Promise<void>
  /** Asks main to email a sign-in link and start polling; the pending status comes back. */
  requestLink: (email: string) => Promise<void>
  /** Stops waiting for the link; the link itself stays valid until it expires. */
  cancelLink: () => Promise<void>
  signOut: () => Promise<void>
  /** Re-checks a stored session with the Worker; fills `since`, or signs out a revoked session. */
  refresh: () => Promise<void>
  /** Asks main for the balance, the spend per feature, and the packs on sale (F-15.3). */
  loadCredits: () => Promise<void>
  /** Opens the Lemon Squeezy checkout for one pack in the browser (F-15.3); the balance follows a Refresh. */
  buyCredits: (variantId: string) => Promise<void>
  /** Reads the cached Supporter license (F-15.9); works signed out, so App loads it at start. */
  loadSupporter: () => Promise<void>
  /** Asks the Worker to confirm the license and re-sign the token; unreachable leaves it as it is. */
  refreshSupporter: () => Promise<void>
  /** Opens the Lemon Squeezy checkout for the Supporter license in the browser (F-15.9). */
  buySupporter: () => Promise<void>
  /** Picks the accent colour (F-15.9); main refuses anything but `default` without a license. */
  setAccent: (accent: AccentId) => Promise<void>
  /**
   * Listens for what main pushes: a status change (a link opened, an attempt expired), the
   * balance a Cloud request was charged against (F-15.5), and the Supporter license after a
   * background refresh or a sign-out (F-15.9). Returns the one unsubscribe for all three.
   */
  subscribe: () => () => void
}

/** Bumped by every reset so a response from a superseded request is dropped. */
let generation = 0

export const useAccountStore = create<AccountState>((set, get) => {
  const run = async (call: () => Promise<AccountStatus>): Promise<void> => {
    const mine = generation
    set({ busy: true, error: null })
    try {
      const status = await call()
      if (mine !== generation) return
      // Credits belong to the account that was signed in: an action that ends anywhere but
      // signed in (sign out, a revoked session on refresh) leaves none to show.
      // The Supporter license (F-15.9) is deliberately not cleared here: the cached token is
      // local, and main pushes `account:supporterChanged` when signing out drops it.
      set(
        status.state === 'signedIn'
          ? { status }
          : { status, credits: null, creditsAt: null, creditsError: null }
      )
    } catch (err: unknown) {
      if (mine !== generation) return
      set({ error: describeError(err) })
    } finally {
      if (mine === generation) set({ busy: false })
    }
  }

  /**
   * One credits call, under its own busy and error so a credits failure leaves the sign-in row
   * alone. `account:buyCredits` answers null: it opens a browser, it does not change the balance.
   */
  const runCredits = async (call: () => Promise<CreditsResult | null>): Promise<void> => {
    const mine = generation
    set({ creditsBusy: true, creditsError: null })
    try {
      const credits = await call()
      if (mine !== generation || credits === null) return
      set({ credits, creditsAt: Date.now() })
    } catch (err: unknown) {
      if (mine !== generation) return
      set({ creditsError: describeError(err) })
    } finally {
      if (mine === generation) set({ creditsBusy: false })
    }
  }

  /**
   * One Supporter-license call (F-15.9), under its own busy and error for the same reason the
   * credits have theirs. `account:buySupporter` answers null: it opens a browser, it grants
   * nothing, so the status only changes on the next refresh.
   */
  const runSupporter = async (call: () => Promise<SupporterStatus | null>): Promise<void> => {
    const mine = generation
    set({ supporterBusy: true, supporterError: null })
    try {
      const supporter = await call()
      if (mine !== generation || supporter === null) return
      set({ supporter })
    } catch (err: unknown) {
      if (mine !== generation) return
      set({ supporterError: describeError(err) })
    } finally {
      if (mine === generation) set({ supporterBusy: false })
    }
  }

  return {
    status: null,
    busy: false,
    error: null,
    credits: null,
    creditsAt: null,
    creditsBusy: false,
    creditsError: null,
    supporter: null,
    supporterBusy: false,
    supporterError: null,

    load: () => run(() => ipc().invoke('account:getStatus', undefined)),

    requestLink: (email) => run(() => ipc().invoke('account:requestLink', { email: email.trim() })),

    cancelLink: () => run(() => ipc().invoke('account:cancelLink', undefined)),

    signOut: () => run(() => ipc().invoke('account:signOut', undefined)),

    refresh: () => run(() => ipc().invoke('account:refresh', undefined)),

    loadCredits: () => runCredits(() => ipc().invoke('account:getCredits', undefined)),

    buyCredits: (variantId) => runCredits(() => ipc().invoke('account:buyCredits', { variantId })),

    loadSupporter: () => runSupporter(() => ipc().invoke('account:getSupporter', undefined)),

    refreshSupporter: () => runSupporter(() => ipc().invoke('account:refreshSupporter', undefined)),

    buySupporter: () => runSupporter(() => ipc().invoke('account:buySupporter', undefined)),

    setAccent: (accent) => runSupporter(() => ipc().invoke('account:setAccent', { accent })),

    subscribe: () => {
      const offStatus = ipc().on('account:changed', (status) => {
        // The state moved on under the author (the link was opened, or the attempt expired), so
        // whatever went wrong before describes a state that is gone. Credits go with the account.
        set(
          status.state === 'signedIn'
            ? { status, error: null }
            : { status, error: null, credits: null, creditsAt: null, creditsError: null }
        )
      })
      // F-15.5: a Cloud request was answered and charged; the balance it left behind is the one
      // part of the credits that is live, so the meter follows it without another `/credits`.
      const offBalance = ipc().on('account:balanceChanged', ({ balanceMicros }) => {
        const { credits, status, creditsBusy } = get()
        if (credits !== null) {
          set({ credits: { ...credits, balanceMicros }, creditsAt: Date.now() })
          return
        }
        // Nothing has been asked for yet: the rest of the meter (the period, the spend) is worth
        // one call now that this account is known to be spending.
        if (status?.state === 'signedIn' && !creditsBusy) void get().loadCredits()
      })
      // F-15.9: the license changed without anyone asking — a background refresh confirmed or
      // dropped it, a sign-in granted it, a sign-out cleared it. Whatever failed before describes
      // a state that is gone, so the error goes with it.
      const offSupporter = ipc().on('account:supporterChanged', (supporter) => {
        set({ supporter, supporterError: null })
      })
      return () => {
        offStatus()
        offBalance()
        offSupporter()
      }
    }
  }
})

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetAccountStore(): void {
  generation++
  useAccountStore.setState({
    status: null,
    busy: false,
    error: null,
    credits: null,
    creditsAt: null,
    creditsBusy: false,
    creditsError: null,
    supporter: null,
    supporterBusy: false,
    supporterError: null
  })
}
