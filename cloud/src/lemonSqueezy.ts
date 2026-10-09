/**
 * The one Lemon Squeezy API call the Worker makes (2026-10-08): refund (part of) an order, for the
 * self-serve refund of unused balance and for a starter order that may not be credited.
 * `POST https://api.lemonsqueezy.com/v1/orders/{id}/refund` with an optional `amount` in cents
 * (omitted = the whole order; docs.lemonsqueezy.com/api/orders/issue-refund), authenticated with
 * the store's API key (`LEMONSQUEEZY_API_KEY`, a Worker secret). Plain `fetch`, injected, so the
 * tests never reach the real API.
 */

export const LEMONSQUEEZY_API_URL = 'https://api.lemonsqueezy.com/v1'

/**
 * How long the Worker waits for Lemon Squeezy before it treats the outcome as unknown. Below the
 * app's own 15 s request timeout (`CLOUD_REQUEST_TIMEOUT_MS`), so the app hears the Worker's
 * answer ("not confirmed yet") instead of giving up on a refund that may have gone through.
 */
export const REFUND_TIMEOUT_MS = 12_000

/**
 * What became of a refund call: `refunded` (2xx), `refused` (a 4xx: Lemon Squeezy definitely did
 * not refund — the order is already refunded, the amount is too large, the key is wrong), or
 * `unknown` (a 5xx, a timeout, or no answer: it may or may not have happened, so the caller keeps
 * the money held until the webhook says).
 */
export type RefundOutcome =
  { status: 'refunded' } | { status: 'refused'; httpStatus: number } | { status: 'unknown' }

export interface LemonSqueezyApi {
  /** `amountCents` null refunds the whole order. */
  refundOrder(orderId: string, amountCents: number | null): Promise<RefundOutcome>
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

export function lemonSqueezyApi(
  apiKey: string,
  fetchFn: FetchFn = (input, init) => fetch(input, init),
  timeoutMs: number = REFUND_TIMEOUT_MS
): LemonSqueezyApi {
  return {
    async refundOrder(orderId, amountCents) {
      const body = {
        data: {
          type: 'orders',
          id: orderId,
          attributes: amountCents === null ? {} : { amount: amountCents }
        }
      }
      let response: Response
      try {
        response = await fetchFn(
          `${LEMONSQUEEZY_API_URL}/orders/${encodeURIComponent(orderId)}/refund`,
          {
            method: 'POST',
            headers: {
              Accept: 'application/vnd.api+json',
              'Content-Type': 'application/vnd.api+json',
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
          }
        )
      } catch {
        return { status: 'unknown' }
      }
      // The body is not needed; draining it frees the connection.
      await response.text().catch(() => '')
      if (response.ok) return { status: 'refunded' }
      if (response.status >= 400 && response.status < 500) {
        return { status: 'refused', httpStatus: response.status }
      }
      return { status: 'unknown' }
    }
  }
}
