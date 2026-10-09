import { describe, expect, it } from 'vitest'
import { type FetchFn, lemonSqueezyApi, REFUND_TIMEOUT_MS } from './lemonSqueezy'

/**
 * The Lemon Squeezy refund call over an injected `fetch`: the request it sends (docs:
 * docs.lemonsqueezy.com/api/orders/issue-refund) and how each kind of answer is read. Nothing here
 * reaches the real API.
 */

interface Sent {
  url: string
  init: RequestInit
  /** The body as sent; the client always sends a JSON string. */
  body: string
}

function recording(answer: () => Promise<Response>): { fetchFn: FetchFn; sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    fetchFn: (url, init) => {
      sent.push({ url, init, body: typeof init.body === 'string' ? init.body : '' })
      return answer()
    }
  }
}

describe('lemonSqueezyApi.refundOrder', () => {
  it('posts a JSON:API refund with the amount in cents and the key as the bearer', async () => {
    const { fetchFn, sent } = recording(() => Promise.resolve(new Response('{}', { status: 200 })))
    const outcome = await lemonSqueezyApi('ls-key', fetchFn).refundOrder('123', 700)

    expect(outcome).toEqual({ status: 'refunded' })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe('https://api.lemonsqueezy.com/v1/orders/123/refund')
    expect(sent[0]?.init.method).toBe('POST')
    expect(sent[0]?.init.headers).toMatchObject({
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: 'Bearer ls-key'
    })
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({
      data: { type: 'orders', id: '123', attributes: { amount: 700 } }
    })
  })

  it('leaves the amount out for a full refund', async () => {
    const { fetchFn, sent } = recording(() => Promise.resolve(new Response('{}', { status: 200 })))
    await lemonSqueezyApi('ls-key', fetchFn).refundOrder('9', null)
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({
      data: { type: 'orders', id: '9', attributes: {} }
    })
  })

  it('reads a 4xx as refused, and a 5xx or no answer as unknown', async () => {
    const answer = (status: number): Promise<Response> =>
      Promise.resolve(new Response('{"errors":[]}', { status }))
    expect(
      await lemonSqueezyApi('k', recording(() => answer(422)).fetchFn).refundOrder('1', 1)
    ).toEqual({ status: 'refused', httpStatus: 422 })
    expect(
      await lemonSqueezyApi('k', recording(() => answer(503)).fetchFn).refundOrder('1', 1)
    ).toEqual({ status: 'unknown' })
    expect(
      await lemonSqueezyApi(
        'k',
        recording(() => Promise.reject(new TypeError('network down'))).fetchFn
      ).refundOrder('1', 1)
    ).toEqual({ status: 'unknown' })
  })

  it('gives up before the app does: 12 s, under its 15 s request timeout', () => {
    // `CLOUD_REQUEST_TIMEOUT_MS` in src/main/account/cloudAuthClient.ts; the Worker must answer
    // "not confirmed yet" before the app stops waiting for it.
    expect(REFUND_TIMEOUT_MS).toBe(12_000)
    expect(REFUND_TIMEOUT_MS).toBeLessThan(15_000)
  })

  it('reads a call that outlives the timeout as unknown', async () => {
    const hanging: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    expect(await lemonSqueezyApi('k', hanging, 5).refundOrder('1', 1)).toEqual({
      status: 'unknown'
    })
  })
})
