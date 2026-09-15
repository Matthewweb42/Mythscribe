import { Editor } from '@tiptap/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { CRITIQUE_TEXT_MIN } from '@shared/critique'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { CritiqueButton } from './CritiqueButton'
import { resetCritiqueStore, useCritiqueStore } from './critiqueStore'
import { resetDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'

/** Just over the minimum, so one deletion takes the scene under it. */
const LONG = 'The storm broke at dusk. '.repeat(9)

let editor: Editor
let requests: Input<'ai:critique'>[]

const button = (): HTMLElement => screen.getByRole('button', { name: "Editor's notes" })
const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 1,
  ...over
})

beforeEach(() => {
  resetTagStore()
  resetCritiqueStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:critique') {
        requests.push(input as Input<'ai:critique'>)
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
  resetCritiqueStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  editor.destroy()
  setIpcClient(null)
})

describe('CritiqueButton (F-14.8)', () => {
  it('is disabled below Ask, or with the feature off, and says so', () => {
    const { rerender } = render(<CritiqueButton editor={editor} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      "Editor's notes needs the AI dial at Ask or higher (Settings, AI tab)"
    )
    const off = settings()
    useAiSettingsStore.setState({
      settings: { ...off, features: { ...off.features, critique: false } }
    })
    rerender(<CritiqueButton editor={editor} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      "Editor's notes is turned off for this project (Settings, AI tab)"
    )
  })

  it(`needs ${CRITIQUE_TEXT_MIN} characters of scene text, and no editor disables it`, async () => {
    useAiSettingsStore.setState({ settings: settings() })
    const { rerender } = render(<CritiqueButton editor={null} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    rerender(<CritiqueButton editor={editor} nodeId="sc-1" />)
    await waitFor(() => expect(button()).toBeEnabled())
    expect(button()).toHaveAttribute('title', "Get an editor's notes on this scene")
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Too short.' }] }]
    })
    await waitFor(() => expect(button()).toBeDisabled())
    expect(button()).toHaveAttribute(
      'title',
      "Write 200 characters before asking for editor's notes"
    )
  })

  it('starts the critique for the document and is disabled while it runs', async () => {
    useAiSettingsStore.setState({ settings: settings() })
    render(<CritiqueButton editor={editor} nodeId="sc-1" />)
    await waitFor(() => expect(button()).toBeEnabled())
    await userEvent.click(button())
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({ nodeId: 'sc-1' })
    expect(useCritiqueStore.getState().session?.status).toBe('pending')
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute('title', "Editor's notes are already on the way")
  })
})
