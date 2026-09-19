import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MODELS,
  type AiErrorCode,
  type AiModelMap,
  type AiStatus,
  type AiTestConnectionResult,
  type AiUsageSummary
} from '@shared/ai'
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
  models: { openai: DEFAULT_MODELS, cloud: DEFAULT_MODELS }
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
  setModelsAnswer: (provider: 'openai' | 'cloud', models: AiModelMap) => AiStatus
  /** What `ai:setDailyCap` answers; by default the usage with the sent cap. */
  setDailyCapAnswer: (dailyCapUsd: number) => AiUsageSummary
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
              (input as { provider: 'openai' | 'cloud' }).provider,
              (input as { models: AiModelMap }).models
            )
            return fake.status as Output<C>
          case 'ai:testConnection':
            return fake.testAnswer() as Output<C>
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
  authorRules: defaultAuthorRules()
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

const capField = (): HTMLElement => screen.getByLabelText('Daily cap (USD)', { selector: 'input' })

async function open(initial: AiStatus = NO_KEY, usage: AiUsageSummary = NO_USAGE): Promise<void> {
  fake = fakeClient(initial, usage)
  setIpcClient(fake.client)
  // App.tsx loads the project's AI settings with the tree; the tab only reads them.
  await useAiSettingsStore.getState().load()
  render(<AiSettingsTab />)
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
      { channel: 'ai:getStatus', input: undefined },
      { channel: 'ai:usageSummary', input: undefined },
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
    expect(screen.getByText(/stored only on this machine/)).toBeInTheDocument()
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
    expect(fake.calls[5]).toEqual({ channel: 'ai:setKey', input: { key: 'sk-test-1234abcd' } })
    expect(keyField()).toHaveValue('')
    expect(button('Clear')).toBeEnabled()
    expect(button('Test connection')).toBeEnabled()
  })

  it('submits with Enter and trims the key', async () => {
    await open()
    await userEvent.type(keyField(), '  sk-test-1234abcd  {Enter}')
    await waitFor(() => expect(hint()).toHaveTextContent('Key saved: sk-…abcd'))
    expect(fake.calls[5]).toEqual({ channel: 'ai:setKey', input: { key: 'sk-test-1234abcd' } })
  })

  it('clears the key and goes back to no key', async () => {
    await open(WITH_KEY)
    expect(hint()).toHaveTextContent('Key saved: sk-…abcd')
    await userEvent.click(button('Clear'))
    await waitFor(() => expect(hint()).toHaveTextContent('No key'))
    expect(fake.calls[5]).toEqual({ channel: 'ai:clearKey', input: undefined })
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
      'Add credit to your OpenAI account.'
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

  it('warns about obfuscated storage on a keyring-less Linux box but still lets the author save', async () => {
    await open({ ...NO_KEY, encryption: 'plain' })
    expect(screen.getByRole('alert')).toHaveTextContent(/stored obfuscated, not encrypted/)
    expect(keyField()).toBeEnabled()
    await userEvent.type(keyField(), 'sk-test-1234abcd{Enter}')
    await waitFor(() => expect(hint()).toHaveTextContent('Key saved: sk-…abcd'))
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('replaces the key field with the keychain warning when nothing can protect the key', async () => {
    await open({ ...NO_KEY, encryption: 'none' })
    expect(screen.getByRole('alert')).toHaveTextContent(/no safe storage available/)
    expect(screen.queryByLabelText('API key', { selector: 'input' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(button('Test connection')).toBeDisabled()
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
      models: { openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4-pro' }, cloud: DEFAULT_MODELS }
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
  const sourceRadio = (source: 'ownKey' | 'cloud'): HTMLElement =>
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

  it('writes the source, hides the key form, and names the signed-in account', async () => {
    await open(WITH_KEY)
    signIn()
    await userEvent.click(sourceRadio('cloud'))
    expect(sourceRadio('cloud')).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toMatchObject({ source: 'cloud' })
    expect(screen.queryByLabelText('API key', { selector: 'input' })).not.toBeInTheDocument()
    expect(screen.getByTestId('ai-cloud-account')).toHaveTextContent(
      'Signed in as author@example.com. Manage credits on the Account tab.'
    )
    expect(screen.getByText(/relays it to OpenAI and stores none of it/)).toBeInTheDocument()
    // The data-sharing table says where the text goes now.
    expect(screen.getAllByText('MythScribe Cloud').length).toBeGreaterThan(1)
  })

  it('enables Test connection by the source: a key, or a signed-in account', async () => {
    await open(WITH_KEY)
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

  it('edits the Cloud map, leaving the key map alone', async () => {
    await open({
      ...NO_KEY,
      models: { openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4' }, cloud: DEFAULT_MODELS }
    })
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
