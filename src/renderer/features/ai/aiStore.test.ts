import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MODELS,
  type AiModelMap,
  type AiStatus,
  type AiTestConnectionResult,
  type AiUsageSummary
} from '@shared/ai'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiStore, useAiStore } from './aiStore'

const NO_KEY: AiStatus = {
  provider: 'openai',
  hasKey: false,
  hint: null,
  encryption: 'os',
  models: { openai: DEFAULT_MODELS, cloud: DEFAULT_MODELS }
}
const WITH_KEY: AiStatus = { ...NO_KEY, hasKey: true, hint: 'sk-…abcd' }
const ZERO = { requests: 0, tokens: 0, costUsd: 0 }
const USAGE: AiUsageSummary = {
  today: ZERO,
  session: ZERO,
  total: ZERO,
  byFeature: [],
  recent: [],
  dailyCapUsd: 2
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  /** What `ai:testConnection` answers; a thrown value rejects instead. */
  testAnswer: () => AiTestConnectionResult
}

function fakeClient(): Fake {
  const calls: Fake['calls'] = []
  const fake: Fake = {
    calls,
    testAnswer: () => ({ ok: true, model: 'gpt-fake' }),
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push({ channel, input })
        switch (channel) {
          case 'ai:getStatus':
            return NO_KEY as Output<C>
          case 'ai:setKey':
            return WITH_KEY as Output<C>
          case 'ai:clearKey':
            return NO_KEY as Output<C>
          case 'ai:setModels': {
            const { provider, models } = input as {
              provider: 'openai' | 'cloud'
              models: AiModelMap
            }
            return { ...WITH_KEY, models: { ...WITH_KEY.models, [provider]: models } } as Output<C>
          }
          case 'ai:testConnection':
            return fake.testAnswer() as Output<C>
          case 'ai:usageSummary':
            return USAGE as Output<C>
          case 'ai:setDailyCap':
            return {
              ...USAGE,
              dailyCapUsd: (input as { dailyCapUsd: number }).dailyCapUsd
            } as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on: () => () => {}
    }
  }
  return fake
}

let fake: Fake
const store = (): ReturnType<typeof useAiStore.getState> => useAiStore.getState()

beforeEach(() => {
  resetAiStore()
  fake = fakeClient()
  setIpcClient(fake.client)
})

describe('aiStore (F-5.1)', () => {
  it('starts empty and loads the status', async () => {
    expect(store().status).toBeNull()
    await store().load()
    expect(store().status).toEqual(NO_KEY)
    expect(fake.calls).toEqual([{ channel: 'ai:getStatus', input: undefined }])
  })

  it('sends the key once, keeps only the answered status, and drops a stale test result', async () => {
    useAiStore.setState({ testResult: { ok: true, model: 'old' } })
    await store().setKey('sk-test-1234abcd')
    expect(fake.calls).toEqual([{ channel: 'ai:setKey', input: { key: 'sk-test-1234abcd' } }])
    expect(store().status).toEqual(WITH_KEY)
    expect(store().testResult).toBeNull()
    expect(JSON.stringify(store())).not.toContain('sk-test-1234abcd')
  })

  it('clears the key and the last test result', async () => {
    useAiStore.setState({ status: WITH_KEY, testResult: { ok: true, model: 'old' } })
    await store().clearKey()
    expect(store().status).toEqual(NO_KEY)
    expect(store().testResult).toBeNull()
  })

  it('sends the model mapping for the provider and drops the stale test result (F-5.11)', async () => {
    useAiStore.setState({ status: WITH_KEY, testResult: { ok: true, model: 'old' } })
    const models = { fast: 'gpt-5.4-nano', strong: 'gpt-5.4' }
    await store().setModels('cloud', models)
    expect(fake.calls).toEqual([{ channel: 'ai:setModels', input: { provider: 'cloud', models } }])
    expect(store().status).toEqual({ ...WITH_KEY, models: { ...WITH_KEY.models, cloud: models } })
    expect(store().testResult).toBeNull()
  })

  it('marks testing while the connection test runs and stores its result', async () => {
    const pending = store().test()
    expect(store().testing).toBe(true)
    expect(store().testResult).toBeNull()
    await pending
    expect(store().testing).toBe(false)
    expect(store().testResult).toEqual({ ok: true, model: 'gpt-fake' })
  })

  it('stores an expected failure as data without throwing', async () => {
    const failure: AiTestConnectionResult = {
      ok: false,
      code: 'INVALID_KEY',
      message: 'OpenAI rejected the API key.',
      nextStep: 'Check the key and try again.'
    }
    fake.testAnswer = () => failure
    await expect(store().test()).resolves.toBeUndefined()
    expect(store().testResult).toEqual(failure)
  })

  it('rethrows an unexpected failure and stops testing', async () => {
    fake.testAnswer = () => {
      throw new Error('bridge down')
    }
    await expect(store().test()).rejects.toThrow('bridge down')
    expect(store().testing).toBe(false)
    expect(store().testResult).toBeNull()
  })

  it('drops a response that arrives after a reset', async () => {
    const pending = store().load()
    resetAiStore()
    await pending
    expect(store().status).toBeNull()
  })
})

describe('aiStore usage (F-5.14)', () => {
  it('starts without a summary and loads it', async () => {
    expect(store().usage).toBeNull()
    await store().loadUsage()
    expect(store().usage).toEqual(USAGE)
    expect(fake.calls).toEqual([{ channel: 'ai:usageSummary', input: undefined }])
  })

  it('sends the new cap and keeps the summary answered', async () => {
    await store().setDailyCap(5)
    expect(fake.calls).toEqual([{ channel: 'ai:setDailyCap', input: { dailyCapUsd: 5 } }])
    expect(store().usage).toEqual({ ...USAGE, dailyCapUsd: 5 })
  })

  it('drops a usage response that arrives after a reset', async () => {
    const pending = store().loadUsage()
    resetAiStore()
    await pending
    expect(store().usage).toBeNull()
  })
})
