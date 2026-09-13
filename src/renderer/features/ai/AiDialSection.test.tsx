import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AI_FEATURE_IDS, DEFAULT_MODELS, type AiStatus } from '@shared/ai'
import { AI_DATA_SHARING, defaultAiSettings, type AiSettings } from '@shared/aiSettings'
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
  models: DEFAULT_MODELS
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
            fake.settings = fake.setAnswer(input as Input<'aiSettings:set'>)
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
const radio = (name: string): HTMLElement => screen.getByRole('radio', { name })
const checkbox = (name: RegExp | string): HTMLElement => screen.getByRole('checkbox', { name })
const sets = (): AiSettings[] =>
  fake.calls
    .filter((c) => c.channel === 'aiSettings:set')
    .map((c) => c.input as Input<'aiSettings:set'>)
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

/** Renders the section with `initial` loaded, the way `App.tsx` loads it with the project. */
async function open(initial: AiSettings = defaultAiSettings()): Promise<void> {
  fake = fakeClient(initial)
  setIpcClient(fake.client)
  render(<AiDialSection />)
  await useAiStore.getState().load()
  await useAiSettingsStore.getState().load()
  await screen.findByRole('radiogroup', { name: 'AI dial' })
}

beforeEach(() => {
  resetAiSettingsStore()
  resetAiStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetAiSettingsStore()
})

describe('AiDialSection (F-14.4)', () => {
  it('renders nothing until the settings load, then the dial at Off with its meanings', async () => {
    fake = fakeClient(defaultAiSettings())
    setIpcClient(fake.client)
    render(<AiDialSection />)
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    await useAiSettingsStore.getState().load()
    const group = await screen.findByRole('radiogroup', { name: 'AI dial' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-checked'))
    ).toEqual(['true', 'false', 'false', 'false'])
    expect(radio('Off')).toHaveAccessibleDescription('Nothing leaves this machine.')
    expect(radio('Ask')).toHaveAccessibleDescription(/Queries, summaries, tag suggestions/)
    expect(radio('Suggest')).toHaveAccessibleDescription(/Adds ghost text/)
    expect(radio('Draft')).toHaveAccessibleDescription(/multi-paragraph/)
    expect(radio('Off')).toHaveAttribute('tabindex', '0')
    expect(radio('Ask')).toHaveAttribute('tabindex', '-1')
    expect(screen.getByText('This project')).toBeInTheDocument()
    expect(
      screen.getByText("Nothing is sent until a feature's row above is allowed and you use it.")
    ).toBeInTheDocument()
  })

  it('selects a level on click and writes it once after the debounce', async () => {
    await open()
    await userEvent.click(radio('Suggest'))
    expect(radio('Suggest')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Off')).toHaveAttribute('aria-checked', 'false')
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toEqual({ ...defaultAiSettings(), dial: 2 })
  })

  it('moves and selects with the arrow keys, Home, and End', async () => {
    await open()
    radio('Off').focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(radio('Ask')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Ask')).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    expect(radio('Draft')).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{ArrowRight}')
    expect(radio('Off')).toHaveAttribute('aria-checked', 'true') // wraps
    await userEvent.keyboard('{ArrowLeft}')
    expect(radio('Draft')).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{Home}')
    expect(radio('Off')).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{End}')
    expect(radio('Draft')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Draft')).toHaveFocus()
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]?.dial).toBe(3)
  })

  it('disables a toggle below its level, says the level needed, and enables it once the dial is raised', async () => {
    await open()
    for (const id of AI_FEATURE_IDS) {
      expect(checkbox(new RegExp(`^${AI_DATA_SHARING[id].label}`))).toBeDisabled()
    }
    expect(checkbox('Ghost text (needs Suggest)')).toBeChecked()
    expect(checkbox('Author mode (needs Draft)')).toBeDisabled()
    expect(checkbox('Tag suggestions (needs Ask)')).toBeDisabled()
    await userEvent.click(radio('Ask'))
    expect(checkbox('Tag suggestions')).toBeEnabled()
    expect(checkbox('Ghost text (needs Suggest)')).toBeDisabled()
    await userEvent.click(radio('Suggest'))
    expect(checkbox('Ghost text')).toBeEnabled()
    expect(checkbox('Author mode (needs Draft)')).toBeDisabled()
    await userEvent.click(radio('Draft'))
    expect(checkbox('Author mode')).toBeEnabled()
  })

  it('unchecks and rechecks a toggle through the store, replacing the toggles wholesale', async () => {
    await open({ ...defaultAiSettings(), dial: 2 })
    await userEvent.click(checkbox('Ghost text'))
    expect(checkbox('Ghost text')).not.toBeChecked()
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toEqual({
      dial: 2,
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
    await userEvent.click(radio('Draft'))
    expect(radio('Draft')).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(toasts()).toEqual(['Disk is read-only']))
    expect(radio('Off')).toHaveAttribute('aria-checked', 'true')
  })

  it('lists every feature in the data-sharing table with what it sends, the provider, and the level', async () => {
    await open()
    const table = screen.getByRole('table', { name: 'What each AI feature sends' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(AI_FEATURE_IDS.length)
    for (const id of AI_FEATURE_IDS) {
      const { label, sends } = AI_DATA_SHARING[id]
      const row = within(table).getByRole('row', { name: new RegExp(`^${label} `) })
      expect(row).toHaveTextContent(sends)
      expect(row).toHaveTextContent('OpenAI')
    }
    const rowFor = (label: string): HTMLElement =>
      within(table).getByRole('row', { name: new RegExp(`^${label} `) })
    expect(rowFor('Ghost text')).toHaveTextContent(/Suggest$/)
    expect(rowFor('Author mode')).toHaveTextContent(/Draft$/)
    expect(rowFor('Tag suggestions')).toHaveTextContent(/Ask$/)
  })
})
