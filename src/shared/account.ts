import { z } from 'zod'
import { CLOUD_API_URL } from './cloudApi'

/**
 * The MythScribe account as the renderer sees it (F-15.2). The session token never crosses IPC:
 * the renderer only learns who is signed in. Optional throughout; nothing in the app requires it.
 */
export const AccountStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('signedOut') }),
  /** A sign-in link was sent and main is polling for its approval. */
  z.object({
    state: z.literal('pending'),
    email: z.string(),
    attemptId: z.string(),
    /** ISO timestamp after which the link no longer works and the state returns to signedOut. */
    expiresAt: z.string(),
    /** Only from a Worker running the `log` mail transport (local dev): the link, so it can be opened without an inbox. */
    devLink: z.string().optional()
  }),
  z.object({
    state: z.literal('signedIn'),
    email: z.string(),
    userId: z.string(),
    /** ISO timestamp of the sign-in; null until `account:refresh` has asked the Worker once. */
    since: z.string().nullable()
  })
])
export type AccountStatus = z.infer<typeof AccountStatus>

/** Where the app sends Cloud requests, so the tab can name a non-default (dev or e2e) endpoint. */
export const cloudApiUrl = (env: Record<string, string | undefined>): string => {
  const override = env.MYTHSCRIBE_CLOUD_API_URL?.trim()
  return override !== undefined && override !== '' ? override : CLOUD_API_URL
}
