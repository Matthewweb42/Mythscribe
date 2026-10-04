import { Editor } from '@tiptap/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'
import { ProofreadButton } from './ProofreadButton'
import { resetProofreadStore, useProofreadStore } from './proofreadStore'

const TEXT = 'The strom broke at dusk, and the the rain came.'

let editor: Editor
let requests: Input<'ai:proofread'>[]

const button = (): HTMLElement => screen.getByRole('button', { name: 'Proofread' })
const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 1,
  ...over
})

beforeEach(() => {
  resetTagStore()
  resetProofreadStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:proofread') {
        requests.push(input as Input<'ai:proofread'>)
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
      content: [{ type: 'paragraph', content: [{ type: 'text', text: TEXT }] }]
    }
  })
})
afterEach(() => {
  resetProofreadStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  editor.destroy()
  setIpcClient(null)
})

describe('ProofreadButton (F-14.12)', () => {
  it('is disabled below Ask, or with the feature off, and says so', () => {
    const { rerender } = render(<ProofreadButton editor={editor} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Proofread needs the AI dial at Ask or higher (Settings, AI tab)'
    )
    const off = settings()
    useAiSettingsStore.setState({
      settings: { ...off, features: { ...off.features, proofread: false } }
    })
    rerender(<ProofreadButton editor={editor} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Proofread is turned off for this project (Settings, AI tab)'
    )
  })

  it('needs 20 characters of scene text, and no editor disables it', async () => {
    useAiSettingsStore.setState({ settings: settings() })
    const { rerender } = render(<ProofreadButton editor={null} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    rerender(<ProofreadButton editor={editor} nodeId="sc-1" />)
    await waitFor(() => expect(button()).toBeEnabled())
    expect(button()).toHaveAttribute('title', 'Proofread this scene')
    act(() => {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Too short.' }] }]
      })
    })
    await waitFor(() => expect(button()).toBeDisabled())
    expect(button()).toHaveAttribute('title', 'Write 20 characters before proofreading')
  })

  it('names the selection when 20 or more characters are selected', async () => {
    useAiSettingsStore.setState({ settings: settings() })
    render(<ProofreadButton editor={editor} nodeId="sc-1" />)
    await waitFor(() => expect(button()).toHaveAttribute('title', 'Proofread this scene'))
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 10 })
    })
    expect(button()).toHaveAttribute('title', 'Proofread this scene')
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 25 })
    })
    await waitFor(() => expect(button()).toHaveAttribute('title', 'Proofread the selection'))
  })

  it('starts the pass for the document and is disabled while it runs', async () => {
    useAiSettingsStore.setState({ settings: settings() })
    render(<ProofreadButton editor={editor} nodeId="sc-1" />)
    await waitFor(() => expect(button()).toBeEnabled())
    await userEvent.click(button())
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({ nodeId: 'sc-1', selection: null })
    expect(useProofreadStore.getState().session?.status).toBe('pending')
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute('title', 'A proofreading pass is already in progress')
  })
})
