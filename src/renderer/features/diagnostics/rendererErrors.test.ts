import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DIAGNOSTIC_QUEUE_MAX,
  RENDERER_ERROR_MESSAGE_MAX,
  RENDERER_ERROR_STACK_MAX
} from '@shared/diagnostics'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { contract } from '@shared/ipc/contract'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { listenForRendererErrors, rendererErrorFields } from './rendererErrors'

let calls: { channel: Channel; input: unknown }[]
let fail: Error | null

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    calls.push({ channel, input })
    if (fail) throw fail
    return null as Output<C>
  },
  on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void): () => void {
    return () => undefined
  }
}

let stop: (() => void) | null = null

beforeEach(() => {
  calls = []
  fail = null
  setIpcClient(client)
})
afterEach(() => {
  stop?.()
  stop = null
})

/** The reports the listener sent, already proven to be what the channel accepts. */
function reported(): { name: string; message: string; stack: string | null }[] {
  return calls.map((call) => {
    expect(call.channel).toBe('diagnostics:reportRendererError')
    return contract['diagnostics:reportRendererError'].input.parse(call.input)
  })
}

describe('rendererErrorFields (F-15.8)', () => {
  it('takes the class, the message, and the stack of an Error', () => {
    const error = new TypeError('Cannot read properties of null')
    expect(rendererErrorFields(error, 'Error')).toEqual({
      name: 'TypeError',
      message: 'Cannot read properties of null',
      stack: error.stack
    })
  })

  it('names what was thrown when it is not an Error, and reads it as text', () => {
    expect(rendererErrorFields('boom', 'UnhandledRejection')).toEqual({
      name: 'UnhandledRejection',
      message: 'boom',
      stack: null
    })
    expect(rendererErrorFields(undefined, 'Error').message).toBe('undefined')
  })

  it('cuts every field to the length the channel accepts, so a crash is never refused', () => {
    const error = new Error('m'.repeat(RENDERER_ERROR_MESSAGE_MAX + 500))
    error.stack = 's'.repeat(RENDERER_ERROR_STACK_MAX + 500)
    const fields = rendererErrorFields(error, 'Error')
    expect(fields.message).toHaveLength(RENDERER_ERROR_MESSAGE_MAX)
    expect(fields.stack).toHaveLength(RENDERER_ERROR_STACK_MAX)
    expect(() => contract['diagnostics:reportRendererError'].input.parse(fields)).not.toThrow()
  })
})

describe('listenForRendererErrors (F-15.8)', () => {
  it('reports an uncaught error, then stops when it is removed', () => {
    stop = listenForRendererErrors()
    const error = new RangeError('out of range')
    throwInWindow(error)
    expect(reported()).toEqual([
      { name: 'RangeError', message: 'out of range', stack: error.stack ?? null }
    ])

    stop()
    stop = null
    throwInWindow(error)
    expect(calls).toHaveLength(1)
  })

  it('reads a rejection whose reason is not an Error', () => {
    stop = listenForRendererErrors()
    rejectWith('the fetch was refused')
    expect(reported()).toEqual([
      { name: 'UnhandledRejection', message: 'the fetch was refused', stack: null }
    ])
  })

  it('stops after a bounded number of reports, so an error in a loop cannot flood main', () => {
    stop = listenForRendererErrors()
    for (let i = 0; i < DIAGNOSTIC_QUEUE_MAX + 5; i += 1) rejectWith(`failure ${i}`)
    expect(calls).toHaveLength(DIAGNOSTIC_QUEUE_MAX)
  })

  it('swallows a report main refused: reporting a failed report is how a loop starts', async () => {
    fail = new IpcRequestError({ code: 'VALIDATION', message: 'no' })
    stop = listenForRendererErrors()
    rejectWith('boom')
    await Promise.resolve()
    expect(calls).toHaveLength(1)
  })
})

/**
 * An uncaught error, as the window delivers it. The event is cancelled by a listener of its own
 * so jsdom does not go on to report it a second time as a failure of this test file; the app
 * never cancels it, because the console entry is the point outside a test.
 */
function throwInWindow(error: Error): void {
  const swallow = (event: Event): void => event.preventDefault()
  window.addEventListener('error', swallow)
  window.dispatchEvent(new ErrorEvent('error', { error, message: error.message, cancelable: true }))
  window.removeEventListener('error', swallow)
}

/** jsdom has no `PromiseRejectionEvent`, so the event the listener reads is built by hand. */
function rejectWith(reason: unknown): void {
  const event = new Event('unhandledrejection')
  Object.defineProperty(event, 'reason', { value: reason })
  window.dispatchEvent(event)
}
