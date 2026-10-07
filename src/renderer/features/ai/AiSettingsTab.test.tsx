import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MODELS,
  LOCAL_DEFAULT_MODELS,
  OPENROUTER_DEFAULT_MODELS,
  type AiErrorCode,
  type AiModelMap,
  type AiStatus,
  type AiTestConnectionResult,
  type AiUsageRecent,
  type AiUsageSummary,
  type OwnKeyProvider,
  USAGE_HISTORY_PAGE
} from '@shared/ai'
import { defaultAiRouting, type AiModelChoice, type AiRouting } from '@shared/aiRouting'
import { defaultAiSettings } from '@shared/aiSettings'
import { defaultAuthorRules } from '@shared/authorRules'
import type { Channel, Input, Output, ProvenanceReport, VoiceProfile } from '@shared/ipc/contract'
import { computeStylometrics } from '@shared/stylometry'
import { IDLE_INDEX_QUEUE } from '@shared/jobs'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, IpcRequestError, type IpcClient } from '@renderer/lib/ipc'
import { AiSettingsTab } from './AiSettingsTab'
import { resetAccountStore, useAccountStore } from '@renderer/features/account/accountStore'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import { resetAiStore, useAiStore } from './aiStore'
import { resetIndexingStore } from './indexingStore'
import { resetProvenanceStore, useProvenanceStore } from './provenanceStore'
import { resetVoiceStore } from './voiceStore'

const NO_KEY: AiStatus = {
  provider: 'openai',
  hasKey: false,
  hint: null,
  encryption: 'os',
  models: {
    openai: DEFAULT_MODELS,
    cloud: DEFAULT_MODELS,
    local: LOCAL_DEFAULT_MODELS,
    openrouter: OPENROUTER_DEFAULT_MODELS
  },
  local: { baseUrl: 'http://localhost:11434/v1' }
}
const WITH_KEY: AiStatus = { ...NO_KEY, hasKey: true, hint: 'sk-…abcd' }
const ZERO = { requests: 0, tokens: 0, costUsd: 0 }
const NO_USAGE: AiUsageSummary = {
  today: ZERO,
  session: ZERO,
  total: ZERO,
  byFeature: [],
  recent: [],
  dailyCapUsd: 2
}
const SOME_USAGE: AiUsageSummary = {
  today: { requests: 7, tokens: 2_100, costUsd: 0.0123 },
  session: { requests: 3, tokens: 900, costUsd: 0.0456 },
  total: { requests: 12, tokens: 15_400, costUsd: 0.75 },
  byFeature: [
    { feature: 'ghostText', requests: 10, tokens: 1_400, costUsd: 0.002 },
    { feature: 'tags', requests: 2, tokens: 14_000, costUsd: 0.748 }
  ],
  recent: [
    {
      id: 'u2',
      at: new Date(2026, 8, 17, 14, 5).toISOString(),
      feature: 'tags',
      model: 'gpt-5.4-mini',
      promptTokens: 1_200,
      completionTokens: 80,
      costUsd: 0.0012,
      cached: false
    },
    {
      id: 'u1',
      at: new Date(2026, 8, 17, 9, 30).toISOString(),
      feature: 'ghostText',
      model: 'gpt-5.4-mini',
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      cached: true
    }
  ],
  dailyCapUsd: 3.5
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  status: AiStatus
  usage: AiUsageSummary
  testAnswer: () => AiTestConnectionResult
  setKeyAnswer: () => AiStatus
  /** What `ai:setModels` answers; by default the status with the sent mapping. */
  setModelsAnswer: (provider: 'openai' | 'cloud' | 'local', models: AiModelMap) => AiStatus
  /** What `ai:setDailyCap` answers; by default the usage with the sent cap. */
  setDailyCapAnswer: (dailyCapUsd: number) => AiUsageSummary
  /** Model choice (AI-BILLING-SPEC M8, R4); `ai:setRouting` replaces its overrides. */
  choice: AiModelChoice
  /** Every ledger row `ai:usageHistory` pages through. */
  historyRows: AiUsageRecent[]
}

/** Answers with the fake's current `status`; `ai:setKey` flips it to `WITH_KEY` unless told otherwise. */
function fakeClient(initial: AiStatus, usage: AiUsageSummary): Fake {
  const calls: Fake['calls'] = []
  const fake: Fake = {
    calls,
    status: initial,
    usage,
    testAnswer: () => ({ ok: true, model: 'gpt-fake' }),
    setKeyAnswer: () => ({ ...WITH_KEY, encryption: fake.status.encryption }),
    setModelsAnswer: (provider, models) => ({
      ...fake.status,
      models: { ...fake.status.models, [provider]: models }
    }),
    setDailyCapAnswer: (dailyCapUsd) => ({ ...fake.usage, dailyCapUsd }),
    choice: { routing: defaultAiRouting(), cloudPricing: null },
    historyRows: [],
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push({ channel, input })
        switch (channel) {
          case 'ai:getStatus':
            return fake.status as Output<C>
          case 'ai:setKey':
            fake.status = fake.setKeyAnswer()
            return fake.status as Output<C>
          case 'ai:clearKey':
            fake.status = { ...NO_KEY, encryption: fake.status.encryption }
            return fake.status as Output<C>
          case 'ai:setModels':
            fake.status = fake.setModelsAnswer(
              (input as { provider: 'openai' | 'cloud' | 'local' }).provider,
              (input as { models: AiModelMap }).models
            )
            return fake.status as Output<C>
          case 'ai:setLocalEndpoint':
            fake.status = {
              ...fake.status,
              local: { baseUrl: (input as { baseUrl: string }).baseUrl }
            }
            return fake.status as Output<C>
          case 'ai:testConnection':
            return fake.testAnswer() as Output<C>
          case 'ai:setOwnKeyProvider':
            fake.status = {
              ...fake.status,
              provider: (input as { provider: OwnKeyProvider }).provider,
              hasKey: false,
              hint: null
            }
            return fake.status as Output<C>
          case 'ai:getModelChoice':
            return fake.choice as Output<C>
          case 'ai:setRouting':
            fake.choice = { ...fake.choice, routing: input as AiRouting }
            return fake.choice as Output<C>
          case 'ai:usageHistory': {
            const { offset, limit } = input as { offset: number; limit: number }
            return {
              rows: fake.historyRows.slice(offset, offset + limit),
              total: fake.historyRows.length
            } as Output<C>
          }
          case 'ai:usageSummary':
            return fake.usage as Output<C>
          case 'ai:setDailyCap':
            fake.usage = fake.setDailyCapAnswer((input as { dailyCapUsd: number }).dailyCapUsd)
            return fake.usage as Output<C>
          case 'aiSettings:get':
            return defaultAiSettings() as Output<C>
          case 'aiSettings:set':
            return input as Output<C>
          case 'voice:profile':
            return EMPTY_PROFILE as Output<C>
          case 'voice:listExemplars':
            return [] as Output<C>
          case 'voice:notes':
            return null as Output<C>
          case 'provenance:report':
            return EMPTY_LEDGER as Output<C>
          case 'jobs:indexAll':
            return { ok: true, queued: 2, status: IDLE_INDEX_QUEUE } as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on: () => () => {}
    }
  }
  return fake
}

/** What `voice:profile` answers for a fresh project (F-14.1); the Voice section is its own test. */
const EMPTY_PROFILE: VoiceProfile = {
  rules: [],
  stats: computeStylometrics(''),
  exemplars: [],
  confidence: 0,
  wordCount: 0,
  authorRules: defaultAuthorRules(),
  notes: []
}

/** What `provenance:report` answers for a fresh project (F-14.6); the Provenance section is its own test. */
const EMPTY_LEDGER: ProvenanceReport = {
  projectPercent: 0,
  aiChars: 0,
  totalChars: 0,
  documents: []
}

let fake: Fake
const button = (name: string): HTMLElement => screen.getByRole('button', { name })
const keyField = (): HTMLElement => screen.getByLabelText('API key', { selector: 'input' })
const hint = (): HTMLElement => screen.getByTestId('ai-key-hint')
const modelField = (label: string): HTMLElement =>
  screen.getByLabelText(label, { selector: 'input' })
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const lastCall = (channel: Channel): Fake['calls'][number] | undefined =>
  fake.calls.filter((c) => c.channel === channel).at(-1)

const capField = (): HTMLElement => screen.getByLabelText('Daily cap (USD)', { selector: 'input' })

async function open(
  initial: AiStatus = NO_KEY,
  usage: AiUsageSummary = NO_USAGE,
  props: { cloudAvailable?: boolean } = {}
): Promise<void> {
  fake = fakeClient(initial, usage)
  setIpcClient(fake.client)
  // App.tsx loads the project's AI settings with the tree; the tab only reads them.
  await useAiSettingsStore.getState().load()
  render(<AiSettingsTab {...props} />)
  await waitFor(() => expect(useAiStore.getState().status).not.toBeNull())
  await waitFor(() => expect(useAiStore.getState().usage).not.toBeNull())
  await waitFor(() => expect(useProvenanceStore.getState().report).not.toBeNull())
}

beforeEach(() => {
  resetAiStore()
  resetAiSettingsStore()
  resetAccountStore()
  resetVoiceStore()
  resetProvenanceStore()
  resetIndexingStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetAiSettingsStore()
  resetIndexingStore()
  resetAccountStore()
})

describe('AiSettingsTab (F-5.1)', () => {
  it('loads the status on mount and shows the provider, no key, disabled Test and Clear, and the privacy line', async () => {
    await open()
    expect(fake.calls).toEqual([
      { channel: 'aiSettings:get', input: undefined },
      { channel: 'voice:profile', input: {} },
      { channel: 'voice:listExemplars', input: undefined },
      { channel: 'voice:notes', input: undefined },
      { channel: 'ai:getStatus', input: undefined },
      { channel: 'ai:usageSummary', input: undefined },
      { channel: 'ai:getModelChoice', input: undefined },
      // Last because its store flushes pending saves before asking (F-14.6).
      { channel: 'provenance:report', input: undefined }
    ])
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0)
    expect(hint()).toHaveTextContent('No key')
    expect(keyField()).toHaveAttribute('type', 'password')
    expect(keyField()).toBeEnabled()
    expect(button('Save')).toBeDisabled()
    expect(button('Clear')).toBeDisabled()
    expect(button('Test connection')).toBeDisabled()
    expect(screen.getByText(/kept in your system keychain on this machine/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('provenance-section')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export disclosure report' })).toBeEnabled()
  })

  it('saves a typed key through ai:setKey, then shows the mask and empties the field', async () => {
    await open()
    await userEvent.type(keyField(), 'sk-test-1234abcd')
    expect(button('Save')).toBeEnabled()
    await userEvent.click(button('Save'))
    await waitFor(() => expect(hint()).toHaveTextContent('Key saved: sk-…abcd'))
    expect(lastCall('ai:setKey')).toEqual({
      channel: 'ai:setKey',
      input: { key: 'sk-test-1234abcd' }
    })
    expect(keyField()).toHaveValue('')
    expect(button('Clear')).toBeEnabled()
    expect(button('Test connection')).toBeEnabled()
  })

  it('submits with Enter and trims the key', async () => {
    await open()
    await userEvent.type(keyField(), '  sk-test-1234abcd  {Enter}')
    await waitFor(() => expect(hint()).toHaveTextContent('Key saved: sk-…abcd'))
    expect(lastCall('ai:setKey')).toEqual({
      channel: 'ai:setKey',
      input: { key: 'sk-test-1234abcd' }
    })
  })

  it('clears the key and goes back to no key', async () => {
    await open(WITH_KEY)
    expect(hint()).toHaveTextContent('Key saved: sk-…abcd')
    await userEvent.click(button('Clear'))
    await waitFor(() => expect(hint()).toHaveTextContent('No key'))
    expect(lastCall('ai:clearKey')).toEqual({ channel: 'ai:clearKey', input: undefined })
    expect(button('Test connection')).toBeDisabled()
  })

  it('shows the answering model after a successful test', async () => {
    await open(WITH_KEY)
    await userEvent.click(button('Test connection'))
    await waitFor(() =>
      expect(screen.getByTestId('ai-test-result')).toHaveTextContent(
        'Connected. gpt-fake answered.'
      )
    )
    expect(screen.getByRole('status')).toHaveClass('text-success')
  })

  it.each<[AiErrorCode, string, string]>([
    ['NO_KEY', 'No API key is saved.', 'Add a key above and save it.'],
    ['INVALID_KEY', 'OpenAI rejected the API key.', 'Check the key and try again.'],
    ['RATE_LIMIT', 'OpenAI is rate-limiting this key.', 'Wait a moment and retry.'],
    [
      'QUOTA',
      "This key's OpenAI account has no credit left.",
      'Add credit to your provider account (OpenRouter or OpenAI).'
    ],
    ['NETWORK', 'Could not reach OpenAI.', 'Check your internet connection and retry.'],
    ['PROVIDER', 'OpenAI reported a problem (HTTP 500).', 'Try again in a moment.']
  ])('shows the message and next step for %s', async (code, message, nextStep) => {
    await open(WITH_KEY)
    fake.testAnswer = () => ({ ok: false, code, message, nextStep })
    await userEvent.click(button('Test connection'))
    await waitFor(() =>
      expect(screen.getByTestId('ai-test-result')).toHaveTextContent(`${message} ${nextStep}`)
    )
    expect(screen.getByRole('status')).toHaveClass('text-danger')
  })

  it('drops the old test result when the key changes', async () => {
    await open(WITH_KEY)
    await userEvent.click(button('Test connection'))
    await waitFor(() => expect(screen.getByTestId('ai-test-result')).toBeInTheDocument())
    await userEvent.type(keyField(), 'sk-next-key-9999wxyz{Enter}')
    await waitFor(() => expect(screen.queryByTestId('ai-test-result')).not.toBeInTheDocument())
  })

  it('refuses a new key without the OS keychain (S2) but lets an old one be cleared', async () => {
    await open({ ...WITH_KEY, encryption: 'plain' })
    expect(screen.getByTestId('ai-no-keychain')).toHaveTextContent(
      /only in your system keychain.*GNOME Keyring or KWallet/
    )
    expect(keyField()).toBeDisabled()
    expect(button('Save')).toBeDisabled()
    await userEvent.click(button('Clear'))
    await waitFor(() => expect(hint()).toHaveTextContent('No key'))
  })

  it('closes the key field with the keychain warning when nothing can protect the key', async () => {
    await open({ ...NO_KEY, encryption: 'none' })
    expect(screen.getByTestId('ai-no-keychain')).toHaveTextContent(/only in your system keychain/)
    expect(keyField()).toBeDisabled()
    expect(button('Save')).toBeDisabled()
    expect(button('Test connection')).toBeDisabled()
  })

  it('switches the key provider between OpenRouter and OpenAI, naming it on the key field', async () => {
    await open({ ...NO_KEY, provider: 'openrouter' })
    const picker = screen.getByRole('radiogroup', { name: 'Key provider' })
    expect(within(picker).getByTestId('own-key-provider-openrouter')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('form', { name: 'OpenRouter API key' })).toBeInTheDocument()
    expect(keyField()).toHaveAttribute('placeholder', 'Paste your OpenRouter API key')
    expect(modelField('Fast tier')).toHaveValue(OPENROUTER_DEFAULT_MODELS.fast)
    await userEvent.click(within(picker).getByTestId('own-key-provider-openai'))
    await waitFor(() =>
      expect(screen.getByRole('form', { name: 'OpenAI API key' })).toBeInTheDocument()
    )
    expect(lastCall('ai:setOwnKeyProvider')?.input).toEqual({ provider: 'openai' })
    expect(modelField('Fast tier')).toHaveValue(DEFAULT_MODELS.fast)
    expect(screen.getByText(/sent only to OpenAI when you use/)).toBeInTheDocument()
  })

  it('toasts an unexpected save failure and keeps the typed key', async () => {
    await open()
    fake.setKeyAnswer = () => {
      throw new IpcRequestError({ code: 'IO', message: 'Disk is read-only' })
    }
    await userEvent.type(keyField(), 'sk-test-1234abcd{Enter}')
    await waitFor(() => expect(toasts()).toEqual(['Disk is read-only']))
    expect(keyField()).toHaveValue('sk-test-1234abcd')
    expect(hint()).toHaveTextContent('No key')
  })
})

describe('AiSettingsTab models (F-5.11)', () => {
  const NANO = { fast: 'gpt-5.4-nano', strong: DEFAULT_MODELS.strong }

  it('shows the effective models with their uses, and Reset is disabled at the defaults', async () => {
    await open()
    expect(modelField('Fast tier')).toHaveValue('gpt-5.4-mini')
    expect(modelField('Strong tier')).toHaveValue('gpt-5.4')
    expect(modelField('Fast tier')).toHaveAccessibleDescription(/Ghost text, tags, summaries/)
    expect(modelField('Strong tier')).toHaveAccessibleDescription(/Author mode, critique/)
    expect(button('Reset to defaults')).toBeDisabled()
  })

  it('saves the fast model, trimmed, on blur and drops the old test result', async () => {
    await open(WITH_KEY)
    await userEvent.click(button('Test connection'))
    await waitFor(() => expect(screen.getByTestId('ai-test-result')).toBeInTheDocument())
    await userEvent.clear(modelField('Fast tier'))
    await userEvent.type(modelField('Fast tier'), '  gpt-5.4-nano  ')
    await userEvent.tab()
    await waitFor(() => expect(modelField('Fast tier')).toHaveValue('gpt-5.4-nano'))
    expect(fake.calls.filter((c) => c.channel === 'ai:setModels')).toEqual([
      { channel: 'ai:setModels', input: { provider: 'openai', models: NANO } }
    ])
    expect(screen.queryByTestId('ai-test-result')).not.toBeInTheDocument()
    expect(button('Reset to defaults')).toBeEnabled()
  })

  it('saves the strong model on Enter', async () => {
    await open()
    await userEvent.clear(modelField('Strong tier'))
    await userEvent.type(modelField('Strong tier'), 'gpt-5.4-pro{Enter}')
    await waitFor(() =>
      expect(fake.calls.filter((c) => c.channel === 'ai:setModels')).toEqual([
        {
          channel: 'ai:setModels',
          input: {
            provider: 'openai',
            models: { fast: DEFAULT_MODELS.fast, strong: 'gpt-5.4-pro' }
          }
        }
      ])
    )
    expect(modelField('Strong tier')).toHaveValue('gpt-5.4-pro')
  })

  it('restores the saved value without a write when the commit is blank or unchanged', async () => {
    await open()
    await userEvent.clear(modelField('Fast tier'))
    await userEvent.tab()
    expect(modelField('Fast tier')).toHaveValue('gpt-5.4-mini')
    await userEvent.type(modelField('Fast tier'), ' {Enter}')
    expect(modelField('Fast tier')).toHaveValue('gpt-5.4-mini')
    expect(fake.calls.filter((c) => c.channel === 'ai:setModels')).toEqual([])
  })

  it('resets both tiers to the defaults through one save', async () => {
    await open({
      ...NO_KEY,
      models: {
        openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4-pro' },
        cloud: DEFAULT_MODELS,
        local: LOCAL_DEFAULT_MODELS,
        openrouter: OPENROUTER_DEFAULT_MODELS
      }
    })
    expect(modelField('Fast tier')).toHaveValue('gpt-5.4-nano')
    await userEvent.click(button('Reset to defaults'))
    await waitFor(() => expect(modelField('Fast tier')).toHaveValue('gpt-5.4-mini'))
    expect(modelField('Strong tier')).toHaveValue('gpt-5.4')
    expect(fake.calls.filter((c) => c.channel === 'ai:setModels')).toEqual([
      { channel: 'ai:setModels', input: { provider: 'openai', models: DEFAULT_MODELS } }
    ])
    expect(button('Reset to defaults')).toBeDisabled()
  })

  it('toasts a refused save and shows the saved model again', async () => {
    await open()
    fake.setModelsAnswer = () => {
      throw new IpcRequestError({ code: 'VALIDATION', message: 'Model name is too long' })
    }
    await userEvent.clear(modelField('Fast tier'))
    await userEvent.type(modelField('Fast tier'), 'gpt-5.4-nano{Enter}')
    await waitFor(() => expect(toasts()).toEqual(['Model name is too long']))
    await waitFor(() => expect(modelField('Fast tier')).toHaveValue('gpt-5.4-mini'))
  })
})

describe('AiSettingsTab usage (F-5.14)', () => {
  it('shows nothing spent, the empty-ledger line, and the default cap for a fresh install', async () => {
    await open()
    expect(screen.getByTestId('ai-usage-today')).toHaveTextContent('$0.00')
    expect(screen.getByTestId('ai-usage-total')).toHaveTextContent('$0.00 · 0 requests · 0 tokens')
    expect(screen.getByText('No AI requests in this project yet.')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'This project by feature' })).not.toBeInTheDocument()
    expect(capField()).toHaveValue(2)
    expect(capField()).toHaveAccessibleDescription(/Every project spends against this cap/)
    expect(screen.getByText('Spent today, all projects')).toBeInTheDocument()
    expect(screen.getByText('This session, all projects')).toBeInTheDocument()
    expect(screen.getByTestId('ai-usage-session')).toHaveTextContent(
      '$0.00 · 0 requests · 0 tokens'
    )
    expect(screen.getByText('This project, all time')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Recent requests' })).not.toBeInTheDocument()
  })

  it('shows the day, the project totals, and the per-feature table with labels', async () => {
    await open(NO_KEY, SOME_USAGE)
    expect(screen.getByTestId('ai-usage-today')).toHaveTextContent('$0.01')
    expect(screen.getByTestId('ai-usage-total')).toHaveTextContent(
      '$0.75 · 12 requests · 15,400 tokens'
    )
    const table = screen.getByRole('table', { name: 'This project by feature' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.textContent)).toEqual([
      'Ghost text101,400<$0.01',
      'Tag suggestions214,000$0.75'
    ])
    expect(capField()).toHaveValue(3.5)
  })

  it('shows the session tally and the recent requests newest first (F-5.9)', async () => {
    await open(NO_KEY, SOME_USAGE)
    expect(screen.getByTestId('ai-usage-session')).toHaveTextContent(
      '$0.05 · 3 requests · 900 tokens'
    )
    const table = screen.getByRole('table', { name: 'Recent requests' })
    expect(screen.getByTestId('ai-usage-recent')).toBe(table)
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.textContent)).toEqual([
      '14:05Tag suggestionsgpt-5.4-mini1,200 / 80$0.0012',
      '09:30Ghost textgpt-5.4-mini0 / 0$0.0000 · cached'
    ])
  })

  it('commits a new cap on blur through ai:setDailyCap and shows the answered value', async () => {
    await open()
    await userEvent.clear(capField())
    await userEvent.type(capField(), '5')
    await userEvent.tab()
    await waitFor(() => expect(capField()).toHaveValue(5))
    expect(fake.calls.filter((c) => c.channel === 'ai:setDailyCap')).toEqual([
      { channel: 'ai:setDailyCap', input: { dailyCapUsd: 5 } }
    ])
  })

  it('commits on Enter and accepts 0', async () => {
    await open()
    await userEvent.clear(capField())
    await userEvent.type(capField(), '0{Enter}')
    await waitFor(() =>
      expect(fake.calls.filter((c) => c.channel === 'ai:setDailyCap')).toEqual([
        { channel: 'ai:setDailyCap', input: { dailyCapUsd: 0 } }
      ])
    )
    expect(capField()).toHaveValue(0)
  })

  it('restores the saved cap without a write when the commit is blank or unchanged', async () => {
    await open()
    await userEvent.clear(capField())
    await userEvent.tab()
    expect(capField()).toHaveValue(2)
    await userEvent.clear(capField())
    await userEvent.type(capField(), '2.00{Enter}')
    expect(capField()).toHaveValue(2)
    expect(fake.calls.filter((c) => c.channel === 'ai:setDailyCap')).toEqual([])
  })

  it('toasts a refused cap and shows the saved value again', async () => {
    await open()
    fake.setDailyCapAnswer = () => {
      throw new IpcRequestError({ code: 'VALIDATION', message: 'Cap must be 0 to 500' })
    }
    await userEvent.clear(capField())
    await userEvent.type(capField(), '900{Enter}')
    await waitFor(() => expect(toasts()).toEqual(['Cap must be 0 to 500']))
    await waitFor(() => expect(capField()).toHaveValue(2))
  })
})

describe('AiSettingsTab: Summarize all scenes (F-5.13)', () => {
  const summarizeAll = (): HTMLElement => screen.getByTestId('summarize-all')

  it('is offered but refused while the dial or the toggle keeps summaries off', async () => {
    await open()
    // A fresh project installs at Off, so nothing can be summarised yet.
    expect(summarizeAll()).toBeDisabled()
  })

  it('queues every stale scene once summaries are allowed', async () => {
    await open()
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
    await waitFor(() => expect(summarizeAll()).toBeEnabled())
    await userEvent.click(summarizeAll())
    await waitFor(() => expect(toasts()).toEqual(['Queued 2 scenes for a summary.']))
    expect(fake.calls.filter((c) => c.channel === 'jobs:indexAll')).toHaveLength(1)
  })
})

describe('AiSettingsTab AI source (F-15.4)', () => {
  const sets = (): unknown[] =>
    fake.calls.filter((c) => c.channel === 'aiSettings:set').map((c) => c.input)
  const sourceRadio = (source: 'ownKey' | 'cloud' | 'local'): HTMLElement =>
    screen.getByTestId(`ai-source-${source}`)
  const signIn = (): void => {
    useAccountStore.setState({
      status: { state: 'signedIn', email: 'author@example.com', userId: 'u1', since: null }
    })
  }

  it("starts on the author's own key with the key form and the OpenAI privacy line", async () => {
    await open()
    expect(sourceRadio('ownKey')).toHaveAttribute('aria-checked', 'true')
    expect(sourceRadio('cloud')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/nothing is paid to MythScribe/)).toBeInTheDocument()
    expect(keyField()).toBeInTheDocument()
    expect(screen.queryByTestId('ai-cloud-account')).not.toBeInTheDocument()
    expect(screen.getByText(/sent only to OpenAI/)).toBeInTheDocument()
  })

  it('offers a local model: the server form, the quality warning, the local map, and no key (F-5.15)', async () => {
    await open()
    await userEvent.click(sourceRadio('local'))
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toMatchObject({ source: 'local' })
    expect(screen.queryByLabelText('API key', { selector: 'input' })).not.toBeInTheDocument()
    expect(screen.getByTestId('ai-local-warning')).toHaveTextContent('Local models are smaller')
    expect(screen.getByText(/Nothing leaves this computer/)).toBeInTheDocument()
    expect(modelField('Fast tier')).toHaveValue(LOCAL_DEFAULT_MODELS.fast)
    // Test connection needs no key here.
    expect(button('Test connection')).toBeEnabled()
    const address = screen.getByLabelText('Server address', { selector: 'input' })
    expect(address).toHaveValue('http://localhost:11434/v1')
    expect(button('Save')).toBeDisabled()
    await userEvent.clear(address)
    await userEvent.type(address, 'localhost:1234')
    expect(button('Save')).toBeDisabled()
    await userEvent.clear(address)
    await userEvent.type(address, 'http://192.168.1.20:1234/v1')
    await userEvent.click(button('Save'))
    await waitFor(() =>
      expect(fake.calls.filter((c) => c.channel === 'ai:setLocalEndpoint')).toEqual([
        { channel: 'ai:setLocalEndpoint', input: { baseUrl: 'http://192.168.1.20:1234/v1' } }
      ])
    )
    // An address off this computer is said to be one.
    expect(await screen.findByText(/your text leaves the machine/)).toBeInTheDocument()
  })

  it('shows Cloud disabled as "Coming soon" while Cloud does not serve AI yet', async () => {
    await open(WITH_KEY)
    signIn()
    expect(sourceRadio('cloud')).toBeDisabled()
    expect(screen.getByTestId('ai-source-cloud-coming-soon')).toHaveTextContent('Coming soon')
    await userEvent.click(sourceRadio('cloud'))
    expect(sets()).toEqual([])
    expect(sourceRadio('ownKey')).toHaveAttribute('aria-checked', 'true')
    expect(sourceRadio('local')).toBeEnabled()
    expect(screen.queryByTestId('ai-cloud-unavailable')).not.toBeInTheDocument()
  })

  it('tells a project still stored on Cloud to choose another source, without rewriting it', async () => {
    await open(WITH_KEY)
    signIn()
    const stored = useAiSettingsStore.getState().settings
    if (stored === null) throw new Error('settings not loaded')
    act(() => useAiSettingsStore.setState({ settings: { ...stored, source: 'cloud' } }))
    expect(await screen.findByTestId('ai-cloud-unavailable')).toHaveTextContent(
      'MythScribe Cloud isn\u2019t available yet \u2014 choose My own key or Local model.'
    )
    expect(sourceRadio('cloud')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByTestId('ai-cloud-account')).not.toBeInTheDocument()
    expect(button('Test connection')).toBeDisabled()
    expect(sets()).toEqual([])
    await userEvent.click(sourceRadio('ownKey'))
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toMatchObject({ source: 'ownKey' })
    expect(screen.queryByTestId('ai-cloud-unavailable')).not.toBeInTheDocument()
  })

  it('writes the source, hides the key form, and names the signed-in account', async () => {
    await open(WITH_KEY, NO_USAGE, { cloudAvailable: true })
    signIn()
    await userEvent.click(sourceRadio('cloud'))
    expect(sourceRadio('cloud')).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toMatchObject({ source: 'cloud' })
    expect(screen.queryByLabelText('API key', { selector: 'input' })).not.toBeInTheDocument()
    expect(screen.getByTestId('ai-cloud-account')).toHaveTextContent(
      'Signed in as author@example.com. Manage credits on the Account tab.'
    )
    expect(screen.getByText(/relays it to the model and stores none of it/)).toBeInTheDocument()
    // The data-sharing table says where the text goes now.
    expect(screen.getAllByText('MythScribe Cloud').length).toBeGreaterThan(1)
  })

  it('enables Test connection by the source: a key, or a signed-in account', async () => {
    await open(WITH_KEY, NO_USAGE, { cloudAvailable: true })
    expect(button('Test connection')).toBeEnabled()
    await userEvent.click(sourceRadio('cloud'))
    expect(screen.getByTestId('ai-cloud-account')).toHaveTextContent(
      'Not signed in. Sign in on the Account tab to use MythScribe Cloud.'
    )
    expect(button('Test connection')).toBeDisabled()
    signIn()
    await waitFor(() => expect(button('Test connection')).toBeEnabled())
    await userEvent.click(button('Test connection'))
    await waitFor(() => expect(screen.getByTestId('ai-test-result')).toBeInTheDocument())
    expect(screen.getByTestId('ai-test-result')).toHaveTextContent('Connected. gpt-fake answered.')
  })

  it('shows the Cloud rate beside each model only while Cloud is the source (F-15.11)', async () => {
    await open(
      {
        ...NO_KEY,
        models: {
          openai: DEFAULT_MODELS,
          cloud: { fast: 'gpt-5.4-mini', strong: 'my-finetune' },
          local: LOCAL_DEFAULT_MODELS,
          openrouter: OPENROUTER_DEFAULT_MODELS
        }
      },
      NO_USAGE,
      { cloudAvailable: true }
    )
    expect(screen.queryByTestId('ai-model-rate-fast')).not.toBeInTheDocument()
    await userEvent.click(sourceRadio('cloud'))
    // AI-BILLING-SPEC C4: a price line without tokens; the bundled table stands in for the server's.
    expect(await screen.findByTestId('ai-model-rate-fast')).toHaveTextContent(
      'Paid from your MythScribe Cloud balance at the published price.'
    )
    expect(screen.getByTestId('ai-model-rate-fast')).not.toHaveTextContent(/token/i)
    // A model outside the rate table cannot be billed, so the proxy refuses it; the line says so.
    expect(screen.getByTestId('ai-model-rate-strong')).toHaveTextContent(
      'MythScribe Cloud has no rate for this model'
    )
    await userEvent.click(sourceRadio('ownKey'))
    await waitFor(() => expect(screen.queryByTestId('ai-model-rate-fast')).not.toBeInTheDocument())
  })

  it('edits the Cloud map, leaving the key map alone', async () => {
    await open(
      {
        ...NO_KEY,
        models: {
          openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4' },
          cloud: DEFAULT_MODELS,
          local: LOCAL_DEFAULT_MODELS,
          openrouter: OPENROUTER_DEFAULT_MODELS
        }
      },
      NO_USAGE,
      { cloudAvailable: true }
    )
    expect(modelField('Fast tier')).toHaveValue('gpt-5.4-nano')
    await userEvent.click(sourceRadio('cloud'))
    await waitFor(() => expect(modelField('Fast tier')).toHaveValue(DEFAULT_MODELS.fast))
    await userEvent.clear(modelField('Fast tier'))
    await userEvent.type(modelField('Fast tier'), 'gpt-5.4-nano{Enter}')
    await waitFor(() =>
      expect(fake.calls.filter((c) => c.channel === 'ai:setModels')).toEqual([
        {
          channel: 'ai:setModels',
          input: {
            provider: 'cloud',
            models: { fast: 'gpt-5.4-nano', strong: DEFAULT_MODELS.strong }
          }
        }
      ])
    )
    expect(useAiStore.getState().status?.models.openai).toEqual({
      fast: 'gpt-5.4-nano',
      strong: 'gpt-5.4'
    })
  })
})

describe('AiSettingsTab model choice (AI-BILLING-SPEC M8, R4)', () => {
  it('puts every task on one model, or one task on its own, through ai:setRouting', async () => {
    await open()
    const all = screen.getByRole('combobox', { name: 'All tasks' })
    expect(all).toHaveValue('auto')
    await userEvent.selectOptions(all, 'strong')
    await waitFor(() =>
      expect(lastCall('ai:setRouting')?.input).toEqual({ all: 'strong', features: {} })
    )
    const summaries = screen.getByRole('combobox', {
      name: 'Model for Scene summaries, story bible, and tags'
    })
    // Auto follows the one-model choice once it is set.
    expect(
      within(summaries).getByRole('option', { name: 'Auto (strong model)' })
    ).toBeInTheDocument()
    await userEvent.selectOptions(summaries, 'fast')
    await waitFor(() =>
      expect(lastCall('ai:setRouting')?.input).toEqual({
        all: 'strong',
        features: { summary: 'fast' }
      })
    )
    await userEvent.selectOptions(summaries, 'auto')
    await waitFor(() =>
      expect(lastCall('ai:setRouting')?.input).toEqual({ all: 'strong', features: {} })
    )
  })

  it('labels Auto per task from the routing table, and edit passes as depending on the request', async () => {
    await open()
    const tags = screen.getByRole('combobox', { name: 'Model for Tag suggestions' })
    expect(within(tags).getByRole('option', { name: 'Auto (fast model)' })).toBeInTheDocument()
    const passes = screen.getByRole('combobox', { name: 'Model for Edit passes' })
    expect(
      within(passes).getByRole('option', { name: 'Auto (depends on the request)' })
    ).toBeInTheDocument()
  })
})

describe('AiSettingsTab usage history (AI-BILLING-SPEC E7, C4)', () => {
  const row = (i: number): AiUsageRecent => ({
    id: `r${i}`,
    at: new Date(2026, 9, 7, 9, i % 60).toISOString(),
    feature: 'summary',
    model: 'openai/gpt-5.4-mini',
    promptTokens: 1_000 + i,
    completionTokens: 100,
    cachedTokens: i === 0 ? 800 : null,
    costUsd: 0.001,
    cached: false
  })

  it('opens the history on demand and pages through it, newest first', async () => {
    await open()
    fake.historyRows = Array.from({ length: USAGE_HISTORY_PAGE + 3 }, (_, i) => row(i))
    expect(screen.queryByTestId('ai-usage-history')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('ai-usage-history-toggle'))
    const table = await screen.findByTestId('ai-usage-history')
    expect(within(table).getAllByRole('row')).toHaveLength(USAGE_HISTORY_PAGE + 1)
    expect(within(table).getByText('1,000 / 100 (800 cached)')).toBeInTheDocument()
    expect(screen.getByTestId('ai-usage-history-range')).toHaveTextContent(
      `1\u2013${USAGE_HISTORY_PAGE} of ${USAGE_HISTORY_PAGE + 3}`
    )
    expect(button('Newer')).toBeDisabled()
    await userEvent.click(button('Older'))
    await waitFor(() =>
      expect(screen.getByTestId('ai-usage-history-range')).toHaveTextContent(
        `${USAGE_HISTORY_PAGE + 1}\u2013${USAGE_HISTORY_PAGE + 3} of ${USAGE_HISTORY_PAGE + 3}`
      )
    )
    expect(button('Older')).toBeDisabled()
    expect(lastCall('ai:usageHistory')?.input).toEqual({
      offset: USAGE_HISTORY_PAGE,
      limit: USAGE_HISTORY_PAGE
    })
  })

  it('keeps tokens out of the usage block on MythScribe Cloud', async () => {
    await open(WITH_KEY, SOME_USAGE, { cloudAvailable: true })
    expect(screen.getByTestId('ai-usage-total')).toHaveTextContent(/tokens/)
    await userEvent.click(screen.getByTestId('ai-source-cloud'))
    await waitFor(() =>
      expect(screen.getByTestId('ai-usage-total')).toHaveTextContent('$0.75 · 12 requests')
    )
    expect(screen.getByTestId('ai-usage')).not.toHaveTextContent(/token/i)
  })
})
