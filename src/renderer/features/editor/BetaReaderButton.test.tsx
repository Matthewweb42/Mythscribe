import { Editor } from '@tiptap/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { BETA_READER_TEXT_MIN } from '@shared/betaReader'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { BetaReaderButton } from './BetaReaderButton'
import { resetBetaReaderStore, useBetaReaderStore } from './betaReaderStore'
import { resetDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'

/** Just over the minimum, so one deletion takes the scene under it. */
const LONG = 'The storm broke at dusk. '.repeat(9)

let editor: Editor
let requests: Input<'ai:betaReader'>[]

const button = (): HTMLElement => screen.getByRole('button', { name: 'Beta reader' })
const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 1,
  ...over
})

beforeEach(() => {
  resetTagStore()
  resetBetaReaderStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:betaReader') {
        requests.push(input as Input<'ai:betaReader'>)
        return new Promise<Output<C>>(() => {})
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: LONG }] }]
    }
  })
})
afterEach(() => {
  resetBetaReaderStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  editor.destroy()
  setIpcClient(null)
})

describe('BetaReaderButton (F-14.11)', () => {
  it('is disabled below Ask, or with the feature off, and says so', () => {
    const { rerender } = render(<BetaReaderButton editor={editor} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Beta reader needs the AI dial at Ask or higher (Settings, AI tab)'
    )
    const off = settings()
    useAiSettingsStore.setState({
      settings: { ...off, features: { ...off.features, betaReader: false } }
    })
    rerender(<BetaReaderButton editor={editor} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Beta reader is turned off for this project (Settings, AI tab)'
    )
  })

  it(`needs ${BETA_READER_TEXT_MIN} characters of scene text, and no editor disables it`, async () => {
    useAiSettingsStore.setState({ settings: settings() })
    const { rerender } = render(<BetaReaderButton editor={null} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    rerender(<BetaReaderButton editor={editor} nodeId="sc-1" />)
    await waitFor(() => expect(button()).toBeEnabled())
    expect(button()).toHaveAttribute(
      'title',
      'Read the manuscript up to this scene as a first-time reader'
    )
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Too short.' }] }]
    })
    await waitFor(() => expect(button()).toBeDisabled())
    expect(button()).toHaveAttribute('title', 'Write 200 characters before asking for a beta read')
  })

  it('starts the read for the document and is disabled while it runs', async () => {
    useAiSettingsStore.setState({ settings: settings() })
    render(<BetaReaderButton editor={editor} nodeId="sc-1" />)
    await waitFor(() => expect(button()).toBeEnabled())
    await userEvent.click(button())
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({ nodeId: 'sc-1' })
    expect(useBetaReaderStore.getState().session?.status).toBe('pending')
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute('title', 'The beta reader is already reading')
  })
})
