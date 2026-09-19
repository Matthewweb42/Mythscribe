import { create } from 'zustand'
import type { AccountStatus } from '@shared/account'
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
  load: () => Promise<void>
  /** Asks main to email a sign-in link and start polling; the pending status comes back. */
  requestLink: (email: string) => Promise<void>
  /** Stops waiting for the link; the link itself stays valid until it expires. */
  cancelLink: () => Promise<void>
  signOut: () => Promise<void>
  /** Re-checks a stored session with the Worker; fills `since`, or signs out a revoked session. */
  refresh: () => Promise<void>
  /** Listens for status changes main pushes (a link opened, an attempt expired); returns the unsubscribe. */
  subscribe: () => () => void
}

/** Bumped by every reset so a response from a superseded request is dropped. */
let generation = 0

export const useAccountStore = create<AccountState>((set) => {
  const run = async (call: () => Promise<AccountStatus>): Promise<void> => {
    const mine = generation
    set({ busy: true, error: null })
    try {
      const status = await call()
      if (mine !== generation) return
      set({ status })
    } catch (err: unknown) {
      if (mine !== generation) return
      set({ error: describeError(err) })
    } finally {
      if (mine === generation) set({ busy: false })
    }
  }

  return {
    status: null,
    busy: false,
    error: null,

    load: () => run(() => ipc().invoke('account:getStatus', undefined)),

    requestLink: (email) => run(() => ipc().invoke('account:requestLink', { email: email.trim() })),

    cancelLink: () => run(() => ipc().invoke('account:cancelLink', undefined)),

    signOut: () => run(() => ipc().invoke('account:signOut', undefined)),

    refresh: () => run(() => ipc().invoke('account:refresh', undefined)),

    subscribe: () =>
      ipc().on('account:changed', (status) => {
        // The state moved on under the author (the link was opened, or the attempt expired), so
        // whatever went wrong before describes a state that is gone.
        set({ status, error: null })
      })
  }
})

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetAccountStore(): void {
  generation++
  useAccountStore.setState({ status: null, busy: false, error: null })
}
