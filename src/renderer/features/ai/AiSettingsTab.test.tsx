import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AiErrorCode, AiStatus, AiTestConnectionResult } from '@shared/ai'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, IpcRequestError, type IpcClient } from '@renderer/lib/ipc'
import { AiSettingsTab } from './AiSettingsTab'
import { resetAiStore, useAiStore } from './aiStore'

const NO_KEY: AiStatus = { provider: 'openai', hasKey: false, hint: null, encryption: 'os' }
const WITH_KEY: AiStatus = { provider: 'openai', hasKey: true, hint: 'sk-…abcd', encryption: 'os' }

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  status: AiStatus
  testAnswer: () => AiTestConnectionResult
  setKeyAnswer: () => AiStatus
}

/** Answers with the fake's current `status`; `ai:setKey` flips it to `WITH_KEY` unless told otherwise. */
function fakeClient(initial: AiStatus): Fake {
  const calls: Fake['calls'] = []
  const fake: Fake = {
    calls,
    status: initial,
    testAnswer: () => ({ ok: true, model: 'gpt-fake' }),
    setKeyAnswer: () => ({ ...WITH_KEY, encryption: fake.status.encryption }),
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
          case 'ai:testConnection':
            return fake.testAnswer() as Output<C>
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
const button = (name: string): HTMLElement => screen.getByRole('button', { name })
const keyField = (): HTMLElement => screen.getByLabelText('API key', { selector: 'input' })
const hint = (): HTMLElement => screen.getByTestId('ai-key-hint')
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function open(initial: AiStatus = NO_KEY): Promise<void> {
  fake = fakeClient(initial)
  setIpcClient(fake.client)
  render(<AiSettingsTab />)
  await waitFor(() => expect(useAiStore.getState().status).not.toBeNull())
}

beforeEach(() => {
  resetAiStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('AiSettingsTab (F-5.1)', () => {
  it('loads the status on mount and shows the provider, no key, disabled Test and Clear, and the privacy line', async () => {
    await open()
    expect(fake.calls).toEqual([{ channel: 'ai:getStatus', input: undefined }])
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
    expect(hint()).toHaveTextContent('No key')
    expect(keyField()).toHaveAttribute('type', 'password')
    expect(keyField()).toBeEnabled()
    expect(button('Save')).toBeDisabled()
    expect(button('Clear')).toBeDisabled()
    expect(button('Test connection')).toBeDisabled()
    expect(screen.getByText(/stored only on this machine/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('saves a typed key through ai:setKey, then shows the mask and empties the field', async () => {
    await open()
    await userEvent.type(keyField(), 'sk-test-1234abcd')
    expect(button('Save')).toBeEnabled()
    await userEvent.click(button('Save'))
    await waitFor(() => expect(hint()).toHaveTextContent('Key saved: sk-…abcd'))
    expect(fake.calls[1]).toEqual({ channel: 'ai:setKey', input: { key: 'sk-test-1234abcd' } })
    expect(keyField()).toHaveValue('')
    expect(button('Clear')).toBeEnabled()
    expect(button('Test connection')).toBeEnabled()
  })

  it('submits with Enter and trims the key', async () => {
    await open()
    await userEvent.type(keyField(), '  sk-test-1234abcd  {Enter}')
    await waitFor(() => expect(hint()).toHaveTextContent('Key saved: sk-…abcd'))
    expect(fake.calls[1]).toEqual({ channel: 'ai:setKey', input: { key: 'sk-test-1234abcd' } })
  })

  it('clears the key and goes back to no key', async () => {
    await open(WITH_KEY)
    expect(hint()).toHaveTextContent('Key saved: sk-…abcd')
    await userEvent.click(button('Clear'))
    await waitFor(() => expect(hint()).toHaveTextContent('No key'))
    expect(fake.calls[1]).toEqual({ channel: 'ai:clearKey', input: undefined })
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
