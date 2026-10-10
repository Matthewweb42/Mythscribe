import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AI_FEATURE_IDS,
  DEFAULT_MODELS,
  OPENROUTER_DEFAULT_MODELS,
  type AiStatus
} from '@shared/ai'
import { AI_DATA_SHARING, AiSettings, defaultAiSettings } from '@shared/aiSettings'
import { DEFAULT_ASSISTANT_NAME, nameAssistant } from '@shared/assistantName'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, IpcRequestError, type IpcClient } from '@renderer/lib/ipc'
import { AiDialSection } from './AiDialSection'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import { resetAiStore, useAiStore } from './aiStore'

const STATUS: AiStatus = {
  provider: 'openai',
  hasKey: false,
  hint: null,
  encryption: 'os',
  models: {
    openai: DEFAULT_MODELS,
    cloud: DEFAULT_MODELS,
    local: DEFAULT_MODELS,
    openrouter: OPENROUTER_DEFAULT_MODELS
  },
  local: { baseUrl: 'http://localhost:11434/v1' }
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  settings: AiSettings
  /** What `aiSettings:set` answers; by default the sent value. */
  setAnswer: (value: AiSettings) => AiSettings
}

function fakeClient(initial: AiSettings): Fake {
  const calls: Fake['calls'] = []
  const fake: Fake = {
    calls,
    settings: initial,
    setAnswer: (value) => value,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push({ channel, input })
        switch (channel) {
          case 'aiSettings:get':
            return fake.settings as Output<C>
          case 'aiSettings:set':
            fake.settings = fake.setAnswer(AiSettings.parse(input))
            return fake.settings as Output<C>
          case 'ai:getStatus':
            return STATUS as Output<C>
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
const useAi = (): HTMLElement => screen.getByRole('switch', { name: 'Use AI' })
const checkbox = (name: RegExp | string): HTMLElement => screen.getByRole('checkbox', { name })
const sets = (): AiSettings[] =>
  fake.calls.filter((c) => c.channel === 'aiSettings:set').map((c) => AiSettings.parse(c.input))
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

/** Renders the section with `initial` loaded, the way `App.tsx` loads it with the project. */
async function open(initial: AiSettings = defaultAiSettings()): Promise<void> {
  fake = fakeClient(initial)
  setIpcClient(fake.client)
  render(<AiDialSection />)
  await useAiStore.getState().load()
  await useAiSettingsStore.getState().load()
  await screen.findByRole('switch', { name: 'Use AI' })
}

beforeEach(() => {
  resetAiSettingsStore()
  resetAiStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetAiSettingsStore()
})

describe('AiDialSection (F-14.4, F-5.21)', () => {
  it('renders nothing until the settings load, then Use AI off with its meaning (2026-10-07)', async () => {
    fake = fakeClient(defaultAiSettings())
    setIpcClient(fake.client)
    render(<AiDialSection />)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    await useAiSettingsStore.getState().load()
    const control = await screen.findByRole('switch', { name: 'Use AI' })
    expect(control).not.toBeChecked()
    expect(control).toHaveAccessibleDescription('No AI at all. Nothing leaves this machine.')
    // The chat's Auto/Ask/Plan lives under the chat box, not here.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.getByText('This project')).toBeInTheDocument()
  })

  it('turns AI on and off and writes it once after the debounce, leaving the chat mode alone', async () => {
    await open({ ...defaultAiSettings(), chatMode: 'plan' })
    await userEvent.click(useAi())
    expect(useAi()).toBeChecked()
    expect(useAi()).toHaveAccessibleDescription(/mode picked under the chat box/)
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toEqual({ ...defaultAiSettings(), dial: 1, chatMode: 'plan' })
    await userEvent.click(useAi())
    expect(useAi()).not.toBeChecked()
    await waitFor(() => expect(sets()).toHaveLength(2))
    expect(sets()[1]).toMatchObject({ dial: 0, chatMode: 'plan' })
  })

  it('disables every toggle while AI is off and enables them all once it is on', async () => {
    await open()
    for (const id of AI_FEATURE_IDS) {
      expect(
        checkbox(nameAssistant(AI_DATA_SHARING[id].label, DEFAULT_ASSISTANT_NAME))
      ).toBeDisabled()
    }
    expect(checkbox('Ghost text')).toBeChecked()
    await userEvent.click(useAi())
    for (const id of AI_FEATURE_IDS) {
      expect(
        checkbox(nameAssistant(AI_DATA_SHARING[id].label, DEFAULT_ASSISTANT_NAME))
      ).toBeEnabled()
    }
  })

  it('unchecks and rechecks a toggle through the store, replacing the toggles wholesale', async () => {
    await open({ ...defaultAiSettings(), dial: 1 })
    await userEvent.click(checkbox('Ghost text'))
    expect(checkbox('Ghost text')).not.toBeChecked()
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toEqual({
      ...defaultAiSettings(),
      dial: 1,
      features: { ...defaultAiSettings().features, ghostText: false }
    })
    await userEvent.click(checkbox('Ghost text'))
    expect(checkbox('Ghost text')).toBeChecked()
    await waitFor(() => expect(sets()).toHaveLength(2))
    expect(sets()[1]?.features.ghostText).toBe(true)
  })

  it('reverts and toasts when the write is refused', async () => {
    await open()
    fake.setAnswer = () => {
      throw new IpcRequestError({ code: 'IO', message: 'Disk is read-only' })
    }
    await userEvent.click(useAi())
    expect(useAi()).toBeChecked()
    await waitFor(() => expect(toasts()).toEqual(['Disk is read-only']))
    expect(useAi()).not.toBeChecked()
  })

  it('shows the ghost-text idle delay in seconds and commits a clamped value on blur or Enter (F-5.3)', async () => {
    await open({ ...defaultAiSettings(), ghostText: { enabled: true, idleMs: 1500 } })
    const field = screen.getByLabelText('Ghost text idle delay (s)', { selector: 'input' })
    expect(field).toHaveValue(1.5)
    expect(field).toHaveAccessibleDescription(/How long VibeWrite waits/)
    await userEvent.clear(field)
    await userEvent.type(field, '0.5')
    await userEvent.tab()
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]?.ghostText).toEqual({ enabled: true, idleMs: 500 })
    expect(field).toHaveValue(0.5)
    await userEvent.clear(field)
    await userEvent.type(field, '9{Enter}')
    await waitFor(() => expect(sets()).toHaveLength(2))
    expect(sets()[1]?.ghostText.idleMs).toBe(5000)
    expect(field).toHaveValue(5)
    await userEvent.clear(field)
    await userEvent.type(field, '0.1')
    await userEvent.tab()
    await waitFor(() => expect(sets()).toHaveLength(3))
    expect(sets()[2]?.ghostText.idleMs).toBe(500)
    // A blank or unchanged commit writes nothing and shows the saved value again.
    await userEvent.clear(field)
    await userEvent.tab()
    expect(field).toHaveValue(0.5)
    await userEvent.clear(field)
    await userEvent.type(field, '0.5{Enter}')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sets()).toHaveLength(3)
  })

  it('lists every feature in the data-sharing table with what it sends and the provider', async () => {
    await open()
    const table = screen.getByRole('table', { name: 'What each AI feature sends' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(AI_FEATURE_IDS.length)
    for (const id of AI_FEATURE_IDS) {
      const label = nameAssistant(AI_DATA_SHARING[id].label, DEFAULT_ASSISTANT_NAME)
      const sends = nameAssistant(AI_DATA_SHARING[id].sends, DEFAULT_ASSISTANT_NAME)
      const row = within(table).getByRole('row', { name: new RegExp(`^${label} `) })
      expect(row).toHaveTextContent(sends)
      expect(row).toHaveTextContent('OpenAI')
    }
  })
})

describe('AiDialSection provider column (F-15.4)', () => {
  it('names OpenAI while the project runs on its own key', async () => {
    await open()
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0)
    expect(screen.queryByText('MythScribe Cloud')).not.toBeInTheDocument()
  })

  it('names MythScribe Cloud once the project sends through the proxy', async () => {
    await open({ ...defaultAiSettings(), source: 'cloud' })
    expect(screen.getAllByText('MythScribe Cloud').length).toBeGreaterThan(0)
    expect(screen.queryByText('OpenAI')).not.toBeInTheDocument()
  })
})
