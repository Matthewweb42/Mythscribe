import { Editor } from '@tiptap/core'
import { render, screen, waitFor } from '@testing-library/react'
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
import { buildExtensions } from './extensions'
import { RewriteButton } from './RewriteButton'
import { resetRewriteStore, useRewriteStore } from './rewriteStore'

const FIRST = 'The storm broke at dusk. Rain followed.'

let editor: Editor
let requests: Input<'ai:rewrite'>[]

const button = (): HTMLElement => screen.getByRole('button', { name: 'Rewrite in my voice' })
const select = (from: number, to: number): boolean => editor.commands.setTextSelection({ from, to })
const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 2,
  ...over
})

beforeEach(() => {
  resetTagStore()
  resetRewriteStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:rewrite') {
        requests.push(input as Input<'ai:rewrite'>)
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
      content: [{ type: 'paragraph', content: [{ type: 'text', text: FIRST }] }]
    }
  })
})
afterEach(() => {
  resetRewriteStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  editor.destroy()
  setIpcClient(null)
})

describe('RewriteButton (F-14.10)', () => {
  it('is disabled below Suggest, or with the feature off, and says so', () => {
    const { rerender } = render(<RewriteButton editor={editor} nodeId="sc-1" />)
    select(1, FIRST.length + 1)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Rewrite in my voice needs the AI dial at Suggest or higher (Settings, AI tab)'
    )
    useAiSettingsStore.setState({ settings: settings({ dial: 1 }) })
    rerender(<RewriteButton editor={editor} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Rewrite in my voice needs the AI dial at Suggest or higher (Settings, AI tab)'
    )
    const off = settings()
    useAiSettingsStore.setState({
      settings: { ...off, features: { ...off.features, rewrite: false } }
    })
    rerender(<RewriteButton editor={editor} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Rewrite in my voice is turned off for this project (Settings, AI tab)'
    )
  })

  it('needs 20–4,000 characters of selected text, and no editor disables it', async () => {
    useAiSettingsStore.setState({ settings: settings() })
    const { rerender } = render(<RewriteButton editor={null} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    rerender(<RewriteButton editor={editor} nodeId="sc-1" />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Select 20–4,000 characters to rewrite them in your voice'
    )
    select(1, 10)
    await waitFor(() => expect(button()).toBeDisabled())
    select(1, FIRST.length + 1)
    await waitFor(() => expect(button()).toBeEnabled())
    expect(button()).toHaveAttribute('title', 'Rewrite the selection in your voice')
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(4_001) }] }]
    })
    editor.commands.selectAll()
    await waitFor(() => expect(button()).toBeDisabled())
    expect(button()).toHaveAttribute('title', 'The selection is over 4,000 characters')
  })

  it('starts the rewrite for the selection and is disabled while it runs', async () => {
    useAiSettingsStore.setState({ settings: settings() })
    render(<RewriteButton editor={editor} nodeId="sc-1" />)
    select(1, FIRST.length + 1)
    await waitFor(() => expect(button()).toBeEnabled())
    await userEvent.click(button())
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ nodeId: 'sc-1', text: FIRST, from: 1 })
    expect(useRewriteStore.getState().session?.status).toBe('streaming')
    await waitFor(() => expect(button()).toBeDisabled())
    expect(button()).toHaveAttribute('title', 'A rewrite is already in progress')
    // The selection survived the click.
    expect(editor.state.selection.to).toBe(FIRST.length + 1)
  })
})
