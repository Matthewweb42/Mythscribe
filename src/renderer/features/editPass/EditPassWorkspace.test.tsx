import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSource } from '@shared/aiSettings'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { resetAccountStore } from '@renderer/features/account/accountStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetAiStore } from '@renderer/features/ai/aiStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EditPassWorkspace } from './EditPassWorkspace'
import { resetEditPassStore } from './editPassStore'

/**
 * The edit pass set-up on MythScribe Cloud (AI-BILLING-SPEC hosted flow 2, R3, E4, C4): the
 * estimate is the hosted quote in dollars with no token counts, and a pass quoted above the
 * threshold asks for a confirm before anything is sent. The own-key estimate keeps its tokens.
 */

let calls: Channel[]

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
    calls.push(channel)
    if (channel === 'editPass:start') {
      return { ok: false, code: 'PROVIDER', message: 'Stopped here.', nextStep: '' } as Output<C>
    }
    throw new Error(`unexpected ${channel}`)
  },
  on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void): () => void {
    return () => undefined
  }
}

/** One scene open and ticked, `words` long, with AI on for the project's `source`. */
function setUp(source: AiSource, words: number): void {
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1, source } })
  const index = buildIndex(treeFixture)
  useTreeStore.setState({
    ...index,
    wordCountRollup: { ...index.wordCountRollup, 'sc-1': words },
    loaded: true,
    selectedId: 'sc-1'
  })
}

beforeEach(() => {
  resetAccountStore()
  resetAiSettingsStore()
  resetAiStore()
  resetEditPassStore()
  calls = []
  setIpcClient(client)
})
afterEach(() => {
  resetAccountStore()
  resetAiSettingsStore()
  resetAiStore()
  resetEditPassStore()
  useTreeStore.setState({ ...buildIndex([]), loaded: false, selectedId: null })
  useDialogStore.setState({ toasts: [] })
})

describe('EditPassWorkspace on MythScribe Cloud', () => {
  it('quotes in dollars without tokens and starts a cheap pass straight away', async () => {
    setUp('cloud', 1_200)
    render(<EditPassWorkspace />)
    const line = screen.getByTestId('edit-pass-estimate-ai')
    expect(line).toHaveTextContent(
      /^With MythScribe: up to about .+ from your MythScribe Cloud balance on deepseek\/deepseek-v4-/
    )
    expect(line.textContent).not.toMatch(/token/i)
    await userEvent.click(screen.getByTestId('edit-pass-start'))
    await waitFor(() => expect(calls).toContain('editPass:start'))
    expect(screen.queryByTestId('edit-pass-quote')).not.toBeInTheDocument()
  })

  it('asks for a confirm above the quote threshold before sending anything', async () => {
    setUp('cloud', 400_000)
    render(<EditPassWorkspace />)
    await userEvent.click(screen.getByTestId('edit-pass-start'))
    expect(screen.getByTestId('edit-pass-quote')).toHaveTextContent(
      /^This pass takes up to about \$\d+\.\d\d from your MythScribe Cloud balance\./
    )
    expect(calls).not.toContain('editPass:start')

    await userEvent.click(screen.getByTestId('edit-pass-quote-cancel'))
    expect(screen.queryByTestId('edit-pass-quote')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('edit-pass-start'))
    expect(screen.getByTestId('edit-pass-start')).toHaveTextContent('Confirm and start')
    await userEvent.click(screen.getByTestId('edit-pass-start'))
    await waitFor(() => expect(calls).toContain('editPass:start'))
  })
})

describe('EditPassWorkspace on the author’s own key', () => {
  it('keeps the token counts and never asks for a confirm', async () => {
    setUp('ownKey', 400_000)
    render(<EditPassWorkspace />)
    expect(screen.getByTestId('edit-pass-estimate-ai')).toHaveTextContent(/tokens in/)
    await userEvent.click(screen.getByTestId('edit-pass-start'))
    await waitFor(() => expect(calls).toContain('editPass:start'))
    expect(screen.queryByTestId('edit-pass-quote')).not.toBeInTheDocument()
  })
})
