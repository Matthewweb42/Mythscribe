import { Editor } from '@tiptap/core'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { Conversations } from '@shared/chat'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { RECAP_SCENE_QUESTION } from '@shared/quickActions'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { resetProofreadStore, useProofreadStore } from '@renderer/features/editor/proofreadStore'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiActivityStore } from './aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import { resetAssistantStore, useAssistantStore } from './assistantStore'
import { continuityTree } from './continuityFixture'
import { resetContinuityStore, useContinuityStore } from './continuityStore'
import { resetProposalStore } from './proposalStore'
import {
  CONTINUITY_BUSY_MESSAGE,
  CONVERSATION_BUSY_MESSAGE,
  PROOFREAD_BUSY_MESSAGE,
  PROOFREAD_FOCUS_MESSAGE,
  PROOFREAD_STACK_MESSAGE,
  QuickActions
} from './QuickActions'

/** Long enough for every action, the consistency check's 200 characters included. */
const SCENE = 'Mara climbed the ridge at dusk and waited for the storm to break. '.repeat(4).trim()

let editor: Editor
/** Every request the row sent, by channel; none of them ever answers. */
let sent: { channel: Channel; input: unknown }[]

function install(): void {
  const stored: Conversations = { active: null, items: [] }
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'conversations:get') return stored as Output<C>
      if (channel === 'conversations:set') return input as Output<C>
      if (channel === 'ai:cancel') return { cancelled: true } as Output<C>
      if (channel === 'proposal:settle') return null as Output<C>
      sent.push({ channel, input })
      return new Promise<Output<C>>(() => {})
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 2,
  ...over
})

const button = (id: string): HTMLElement => screen.getByTestId(`quick-action-${id}`)
const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

function openScene(id = 'sc-1'): void {
  act(() => useActiveEditorStore.getState().set(id, editor))
}

beforeEach(async () => {
  sent = []
  resetAssistantStore()
  resetContinuityStore()
  resetProofreadStore()
  resetFocusStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetPendingSaves()
  resetActiveEditorStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
  useAiSettingsStore.setState({ settings: settings() })
  useTreeStore.setState({ ...buildIndex(continuityTree), loaded: true, selectedId: 'sc-1' })
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
    }
  })
  await useAssistantStore.getState().load()
})
afterEach(() => {
  resetAssistantStore()
  resetContinuityStore()
  resetProofreadStore()
  resetFocusStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetProposalStore()
  resetActiveEditorStore()
  useTreeStore.getState().clear()
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('QuickActions (F-5.17)', () => {
  it('shows the four actions with their tiers, all off with one reason line without a scene', () => {
    render(<QuickActions />)
    expect(screen.getByRole('group', { name: 'Quick actions' })).toBeInTheDocument()
    expect(button('whatNext')).toHaveTextContent('What should come next?fast')
    expect(button('proofread')).toHaveTextContent('Proofreadfast')
    expect(button('continuity')).toHaveTextContent('Check consistencystrong')
    expect(button('recap')).toHaveTextContent('What happened here?strong')
    for (const id of ['whatNext', 'proofread', 'continuity', 'recap']) {
      expect(button(id)).toBeDisabled()
      expect(button(id)).toHaveAttribute('title', 'Open a manuscript scene first')
    }
    expect(screen.getByTestId('quick-action-reason')).toHaveTextContent(
      'Open a manuscript scene first'
    )
    // A front-matter page is not a scene.
    openScene('title-page')
    expect(button('recap')).toBeDisabled()
  })

  it('says what to change when the dial is off, and names the tier once on', () => {
    useAiSettingsStore.setState({ settings: settings({ dial: 0 }) })
    openScene()
    render(<QuickActions />)
    expect(button('whatNext')).toBeDisabled()
    expect(screen.getByTestId('quick-action-reason')).toHaveTextContent(
      'What comes next needs the AI dial at Ask or higher (Settings, AI tab)'
    )
    act(() => useAiSettingsStore.setState({ settings: settings() }))
    for (const id of ['whatNext', 'proofread', 'continuity', 'recap']) {
      expect(button(id)).toBeEnabled()
    }
    expect(button('continuity').getAttribute('title')).toContain('Uses the strong tier.')
    expect(button('proofread').getAttribute('title')).toContain('Uses the fast tier.')
    expect(screen.queryByTestId('quick-action-reason')).not.toBeInTheDocument()
  })

  it('a toggled-off feature and too little text turn off only their own buttons', () => {
    const on = settings()
    useAiSettingsStore.setState({
      settings: { ...on, features: { ...on.features, continuity: false } }
    })
    openScene()
    render(<QuickActions />)
    expect(button('continuity')).toHaveAttribute(
      'title',
      'Consistency check is turned off for this project (Settings, AI tab)'
    )
    expect(button('whatNext')).toBeEnabled()
    act(() => {
      editor.commands.setContent('<p>Mara climbed the ridge.</p>')
    })
    expect(button('whatNext')).toHaveAttribute('title', 'Write 40 characters first')
    expect(button('recap')).toBeEnabled()
    expect(screen.queryByTestId('quick-action-reason')).not.toBeInTheDocument()
  })

  it('waits while each action’s own work is running, and proofread needs the single-scene view', () => {
    openScene()
    render(<QuickActions />)
    act(() => useTreeStore.setState({ selectedId: 'ms' }))
    expect(button('proofread')).toHaveAttribute('title', PROOFREAD_STACK_MESSAGE)
    act(() => useTreeStore.setState({ selectedId: 'sc-1' }))
    act(() => useFocusStore.setState({ active: true }))
    expect(button('proofread')).toHaveAttribute('title', PROOFREAD_FOCUS_MESSAGE)
    act(() => useFocusStore.setState({ active: false }))
    act(() => useProofreadStore.getState().start('sc-1', editor))
    expect(button('proofread')).toHaveAttribute('title', PROOFREAD_BUSY_MESSAGE)
    act(() => useContinuityStore.getState().check('sc-1'))
    expect(button('continuity')).toHaveAttribute('title', CONTINUITY_BUSY_MESSAGE)
    expect(button('whatNext')).toBeEnabled()
    act(() => {
      void useAssistantStore.getState().recap()
    })
    expect(button('whatNext')).toHaveAttribute('title', CONVERSATION_BUSY_MESSAGE)
    expect(button('recap')).toHaveAttribute('title', CONVERSATION_BUSY_MESSAGE)
  })

  it('each button starts its request on the open scene and shows the view it lands in', async () => {
    openScene()
    act(() => useContinuityStore.getState().setViewOpen(true))
    render(<QuickActions />)

    await userEvent.click(button('whatNext'))
    await flush()
    expect(useContinuityStore.getState().viewOpen).toBe(false)
    expect(sent.at(-1)).toMatchObject({ channel: 'ai:whatNext', input: { nodeId: 'sc-1' } })

    act(() => useAssistantStore.getState().stop())
    act(() => useContinuityStore.getState().setViewOpen(true))
    await userEvent.click(button('recap'))
    await flush()
    expect(useContinuityStore.getState().viewOpen).toBe(false)
    expect(sent.at(-1)).toMatchObject({
      channel: 'ai:query',
      input: { nodeId: 'sc-1', message: RECAP_SCENE_QUESTION, pinActive: true }
    })

    await userEvent.click(button('continuity'))
    await flush()
    expect(useContinuityStore.getState().viewOpen).toBe(true)
    expect(sent.at(-1)).toMatchObject({ channel: 'ai:continuity', input: { nodeId: 'sc-1' } })

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 40 })
    })
    await userEvent.click(button('proofread'))
    await flush()
    expect(sent.at(-1)).toMatchObject({
      channel: 'ai:proofread',
      input: { nodeId: 'sc-1', selection: SCENE.slice(0, 39) }
    })
    expect(useProofreadStore.getState().session?.scope).toBe('selection')
  })
})
