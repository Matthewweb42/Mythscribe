import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Editor } from '@tiptap/core'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { toTagName } from '@shared/tags'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { resetViewStore, useViewStore } from '@renderer/features/shell/viewStore'
import {
  resetDocumentTagStore,
  useDocumentTagStore
} from '@renderer/features/tags/documentTagStore'
import { resetMentionStore } from '@renderer/features/tags/mentionStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetActiveEditorStore, useActiveEditorStore } from './activeEditorStore'
import { DocumentEditor } from './DocumentEditor'
import { TagsPanel } from './TagsPanel'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { resetBetaReaderStore, useBetaReaderStore } from './betaReaderStore'
import { resetProofreadStore, useProofreadStore } from './proofreadStore'
import { resetRewriteStore, useRewriteStore } from './rewriteStore'
import { resetSceneMetaStore } from './sceneMetaStore'
import { resetVoiceStore } from '@renderer/features/ai/voiceStore'
import { AiResults } from '@renderer/features/ai/AiResults'
import { resetAssistantStore, useAssistantStore } from '@renderer/features/ai/assistantStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { defaultAiSettings } from '@shared/aiSettings'
import type { AiBetaReaderResult, AiProofreadResult, AiRewriteResult } from '@shared/ipc/contract'
import { defaultEditorSettings } from '@shared/editorSettings'
import { defaultFocusSettings } from '@shared/focus'
import { resetBackgroundStore, useBackgroundStore } from '@renderer/features/focus/backgroundStore'
import { resetEditorSettingsStore, useEditorSettingsStore } from './settingsStore'

type Handler = (input: unknown) => unknown

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/**
 * A fake main for one document with no links yet: the bank is the fixture, `tag:create`
 * answers like main (kebab-cased, custom gray), and the tag links move the usage count.
 */
function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const links: Record<string, string[]> = {}
  let counter = 0
  const tagOf = (id: string): Tag => {
    const tag = useTagStore.getState().byId[id]
    if (!tag) throw new IpcRequestError({ code: 'NOT_FOUND', message: `no tag ${id}` })
    return tag
  }
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'tag:list') return tagFixture as Output<C>
      if (channel === 'tag:aliases') return {} as Output<C>
      if (channel === 'tag:create') {
        const value = input as Input<'tag:create'>
        const tag: Tag = {
          id: `t-new-${++counter}`,
          name: toTagName(value.name),
          category: value.category,
          color: value.color ?? '#6b7280',
          parentId: null,
          usageCount: 0,
          trackMentions: true,
          created: '2026-09-12T08:00:00.000Z',
          modified: '2026-09-12T08:00:00.000Z'
        }
        return tag as Output<C>
      }
      if (channel === 'document:get') {
        const { id } = input as Input<'document:get'>
        return { id, content: doc('Into the') } as Output<C>
      }
      if (channel === 'document:save') {
        const save = input as Input<'document:save'>
        return { wordCount: countWords(save.content), modified: 'm' } as Output<C>
      }
      if (channel === 'documentTag:list') {
        const { nodeId } = input as Input<'documentTag:list'>
        return (links[nodeId] ?? []).map((id) => ({ ...tagOf(id), source: 'author' })) as Output<C>
      }
      // F-4.12: the tags column asks for the document's recorded mentions; none in these tests.
      if (channel === 'mention:listForNode') return [] as Output<C>

      if (channel === 'documentTag:add') {
        const { nodeId, tagId } = input as Input<'documentTag:add'>
        const tag = tagOf(tagId)
        if (links[nodeId]?.includes(tagId)) return tag as Output<C>
        links[nodeId] = [...(links[nodeId] ?? []), tagId]
        return { ...tag, usageCount: tag.usageCount + 1 } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Document' })
const tokens = (): HTMLElement[] =>
  Array.from(box().querySelectorAll<HTMLElement>('[data-inline-tag]'))
const suggestions = (): HTMLElement => screen.getByRole('listbox', { name: 'Tag suggestions' })
const options = (): string[] =>
  within(suggestions())
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
const bar = (): HTMLElement => screen.getByRole('region', { name: 'Tags' })
const chips = (): string[] =>
  within(within(bar()).getByRole('list', { name: 'Document tags' }))
    .getAllByRole('listitem')
    .map((chip) => within(chip).getByRole('button').getAttribute('aria-label') ?? '')
const inlineRows = (): string[] =>
  within(within(bar()).getByRole('list', { name: 'Inline tags' }))
    .getAllByRole('listitem')
    .map((row) => row.textContent ?? '')
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
/** The first paragraph of the document store's latest content for sc-1. */
const paragraph = (): TiptapNodeT[] =>
  useDocumentStore.getState().docs['sc-1']?.content?.content?.[0]?.content ?? []

/**
 * Renders the editor for sc-1 with the bank loaded and the document ready, then puts the caret
 * at the end of the text (jsdom lays nothing out, so a click lands it at the start).
 */
async function mountReady(overrides: Partial<Record<Channel, Handler>> = {}) {
  const calls = install(overrides)
  await act(async () => {
    await useTagStore.getState().load()
  })
  let editor: Editor | null = null
  // The tags column sits beside the editor in the app; the inline-tag tests read its lists.
  render(
    <>
      <DocumentEditor
        id="sc-1"
        format="novel"
        onFocus={(focused) => {
          editor = focused
        }}
      />
      <TagsPanel id="sc-1" />
    </>
  )
  await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
  await waitFor(() => expect(useDocumentTagStore.getState().tagIdsByNode['sc-1']).toBeDefined())
  await userEvent.click(box())
  await waitFor(() => expect(editor).not.toBeNull())
  act(() => {
    editor?.commands.focus('end')
  })
  return calls
}

/** Like `mountReady`, but hands back the live editor instance so a test can place the caret mid-text. */
async function mountReadyWithEditor(
  overrides: Partial<Record<Channel, Handler>> = {},
  results = false
): Promise<Editor> {
  install(overrides)
  await act(async () => {
    await useTagStore.getState().load()
  })
  let editor: Editor | null = null
  // The tags column sits beside the editor in the app; the inline-tag tests read its lists.
  render(
    <>
      <DocumentEditor
        id="sc-1"
        format="novel"
        onFocus={(focused) => {
          editor = focused
        }}
      />
      <TagsPanel id="sc-1" />
      {results ? <AiResults /> : null}
    </>
  )
  await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
  await waitFor(() => expect(useDocumentTagStore.getState().tagIdsByNode['sc-1']).toBeDefined())
  await userEvent.click(box())
  await waitFor(() => expect(editor).not.toBeNull())
  if (!editor) throw new Error('editor did not mount')
  return editor
}

beforeEach(() => {
  resetDocumentStore()
  resetEditorSettingsStore()
  resetPendingSaves()
  resetTagStore()
  resetFocusStore()
  resetDocumentTagStore()
  resetMentionStore()
  resetLayoutStore()
  resetSceneMetaStore()
  resetVoiceStore()
  resetActiveEditorStore()
  resetRewriteStore()
  resetBetaReaderStore()
  resetProofreadStore()
  resetAiSettingsStore()
  resetAssistantStore()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetDocumentStore()
  resetEditorSettingsStore()
  resetPendingSaves()
  resetTagStore()
  resetDocumentTagStore()
  resetMentionStore()
  resetLayoutStore()
  resetSceneMetaStore()
  resetVoiceStore()
  resetActiveEditorStore()
  resetRewriteStore()
  resetBetaReaderStore()
  resetProofreadStore()
  resetAiSettingsStore()
  resetAssistantStore()
})

describe('DocumentEditor AI on a selection (2026-10-06)', () => {
  const PASSAGE = 'Into the dark woods they went, without a word.'

  it('keeps VibeWrite as the toolbar’s only AI control', async () => {
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 3 } })
    await mountReady()
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    expect(within(toolbar).getByRole('button', { name: 'VibeWrite' })).toBeInTheDocument()
    for (const name of [
      'Rewrite in my voice',
      "Editor's notes",
      'Beta reader',
      'Mark voice exemplar'
    ]) {
      expect(within(toolbar).queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('the bubble’s Rewrite rewrites the selection, opens the assistant, and Accept in the results replaces the text', async () => {
    let resolveRewrite: ((result: AiRewriteResult) => void) | null = null
    let sent: Input<'ai:rewrite'> | null = null
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 2 } })
    const editor = await mountReadyWithEditor(
      {
        'document:get': () => ({ id: 'sc-1', content: doc(PASSAGE) }),
        'ai:rewrite': (input) =>
          new Promise<AiRewriteResult>((resolve) => {
            sent = input as Input<'ai:rewrite'>
            resolveRewrite = resolve
          }),
        'proposal:settle': () => null,
        'layout:set': (input) => input
      },
      true
    )
    expect(screen.queryByTestId('selection-bubble')).not.toBeInTheDocument()
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 })
    })
    const bubble = await screen.findByTestId('selection-bubble')
    // Too short to rewrite: the button stays with the reason, Ask AI is there too.
    expect(within(bubble).getByTestId('selection-rewrite')).toBeDisabled()
    expect(within(bubble).getByTestId('selection-rewrite')).toHaveAttribute(
      'title',
      'Select 20–4,000 characters to rewrite them in your voice'
    )
    expect(within(bubble).getByTestId('selection-ask')).toBeInTheDocument()
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: PASSAGE.length + 1 })
    })
    await waitFor(() => expect(screen.getByTestId('selection-rewrite')).toBeEnabled())
    await userEvent.click(screen.getByTestId('selection-rewrite'))
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent).toMatchObject({ nodeId: 'sc-1', from: 1, to: PASSAGE.length + 1, text: PASSAGE })
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
    const panel = screen.getByTestId('rewrite-panel')
    expect(within(panel).getByTestId('rewrite-stop')).toBeInTheDocument()
    expect(box().querySelector('.rewrite-target')?.textContent).toBe(PASSAGE)
    act(() => {
      resolveRewrite?.({
        ok: true,
        text: 'Into the dark woods they went, and nobody spoke.',
        usage: { inputTokens: 300, outputTokens: 20 },
        costUsd: 0.0002,
        cached: false,
        model: 'gpt-5.4-mini',
        flagged: false,
        violation: null,
        proposalId: 'p1',
        requestId: sent?.requestId ?? ''
      })
    })
    await waitFor(() => expect(within(panel).getByTestId('rewrite-diff')).toBeInTheDocument())
    await userEvent.click(within(panel).getByTestId('rewrite-accept'))
    await waitFor(() => expect(screen.queryByTestId('rewrite-panel')).not.toBeInTheDocument())
    expect(box()).toHaveTextContent('Into the dark woods they went, and nobody spoke.')
    expect(box().querySelector('.ai-origin[data-proposal-id="p1"]')).not.toBeNull()
    expect(useRewriteStore.getState().session).toBeNull()
  })

  it('the bubble’s Ask AI attaches the passage to the composer; nothing shows while the dial is Off', async () => {
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 0 } })
    const editor = await mountReadyWithEditor({
      'document:get': () => ({ id: 'sc-1', content: doc(PASSAGE) }),
      'layout:set': (input) => input
    })
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 20 })
    })
    expect(screen.queryByTestId('selection-bubble')).not.toBeInTheDocument()
    // At Ask the chat is allowed but a rewrite is not: Ask AI alone, never a dead Rewrite.
    act(() => useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } }))
    const bubble = await screen.findByTestId('selection-bubble')
    expect(within(bubble).queryByTestId('selection-rewrite')).not.toBeInTheDocument()
    await userEvent.click(within(bubble).getByTestId('selection-ask'))
    expect(useAssistantStore.getState().attachment).toBe('Into the dark woods')
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
  })

  it('the right-click menu over a selection offers Rewrite and Ask AI while the dial allows them', async () => {
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 2 } })
    let sent: Input<'ai:rewrite'> | null = null
    const editor = await mountReadyWithEditor({
      'document:get': () => ({ id: 'sc-1', content: doc(PASSAGE) }),
      'ai:rewrite': (input) =>
        new Promise<AiRewriteResult>(() => {
          sent = input as Input<'ai:rewrite'>
        }),
      'layout:set': (input) => input
    })
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: PASSAGE.length + 1 })
    })
    fireEvent.contextMenu(box().querySelector('p')!, { clientX: 40, clientY: 50 })
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((el) => el.textContent)
    ).toEqual(['Tag selection…', 'Clear tags in selection', 'Rewrite', 'Ask AI'])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rewrite' }))
    await waitFor(() => expect(sent).toMatchObject({ nodeId: 'sc-1', text: PASSAGE }))
  })

  it('unmounting the editor dismisses its pending rewrite', async () => {
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 2 } })
    let cancelled: string | null = null
    const editor = await mountReadyWithEditor({
      'document:get': () => ({ id: 'sc-1', content: doc(PASSAGE) }),
      'ai:rewrite': () => new Promise<AiRewriteResult>(() => {}),
      'ai:cancel': (input) => {
        cancelled = (input as Input<'ai:cancel'>).requestId
        return { cancelled: true }
      }
    })
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: PASSAGE.length + 1 })
      useRewriteStore.getState().start('sc-1', editor)
    })
    const requestId = useRewriteStore.getState().session?.requestId ?? null
    expect(requestId).not.toBeNull()
    cleanup()
    expect(useRewriteStore.getState().session).toBeNull()
    await waitFor(() => expect(cancelled).toBe(requestId))
  })
})

describe('DocumentEditor beta reader (F-14.11)', () => {
  const SCENE = 'Into the dark woods they went, without a word. '.repeat(5)

  it('unmounting the editor dismisses the read in progress', async () => {
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 2 } })
    let sent: Input<'ai:betaReader'> | null = null
    let cancelled: string | null = null
    await mountReady({
      'document:get': () => ({ id: 'sc-1', content: doc(SCENE) }),
      'ai:betaReader': (input) =>
        new Promise<AiBetaReaderResult>(() => {
          sent = input as Input<'ai:betaReader'>
        }),
      'ai:cancel': (input) => {
        cancelled = (input as Input<'ai:cancel'>).requestId
        return { cancelled: true }
      }
    })
    act(() => useBetaReaderStore.getState().start('sc-1'))
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent).toMatchObject({ nodeId: 'sc-1' })
    const requestId = useBetaReaderStore.getState().session?.requestId ?? null
    cleanup()
    expect(useBetaReaderStore.getState().session).toBeNull()
    await waitFor(() => expect(cancelled).toBe(requestId))
  })
})

describe('DocumentEditor focus mode (F-6.1)', () => {
  it('carries the Focus mode button in the toolbar and drops the toolbar while active', async () => {
    await mountReady()
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    expect(within(toolbar).getByRole('button', { name: 'Focus mode' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    act(() => useFocusStore.setState({ active: true }))
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    // The surface and the status bar stay, and the document is still the same instance.
    expect(box()).toHaveAttribute('contenteditable', 'true')
    expect(box()).toHaveTextContent('Into the')
    expect(screen.getByTestId('status-words')).toBeInTheDocument()

    act(() => useFocusStore.setState({ active: false }))
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
  })
})

describe('DocumentEditor focus column width (F-6.4)', () => {
  it('sizes the column as a share of the pane only in focus mode', async () => {
    resetBackgroundStore()
    useBackgroundStore.setState({
      settings: { ...defaultFocusSettings(), overlay: { darkness: 40, width: 55 } }
    })
    await mountReady()
    const pane = (): string => box().closest('[style]')?.getAttribute('style') ?? ''
    expect(pane()).not.toContain('--ms-editor-max-width: 55%')
    act(() => useFocusStore.setState({ active: true }))
    expect(pane()).toContain('--ms-editor-max-width: 55%')
    act(() => useFocusStore.setState({ active: false }))
    expect(pane()).not.toContain('55%')
    resetBackgroundStore()
  })
})

describe('DocumentEditor page edges (F-7.11)', () => {
  afterEach(() => {
    resetViewStore()
  })

  it('draws the column as a sheet on the desk by default, not in focus mode, and not when turned off', async () => {
    await mountReady()
    const column = (): HTMLElement | null => box().parentElement
    const desk = (): HTMLElement | null | undefined => column()?.parentElement
    expect(column()).toHaveClass('ms-sheet', 'px-6')
    expect(desk()).toHaveClass('bg-desk')
    // Focus mode keeps its own surface (F-6.4): no sheet, no desk.
    act(() => useFocusStore.setState({ active: true }))
    expect(column()).not.toHaveClass('ms-sheet')
    expect(desk()).not.toHaveClass('bg-desk')
    act(() => useFocusStore.setState({ active: false }))
    expect(column()).toHaveClass('ms-sheet')
    // Off is the borderless column, the text in the same place (same padding).
    act(() => useViewStore.setState({ pageEdges: false }))
    expect(column()).not.toHaveClass('ms-sheet')
    expect(column()).toHaveClass('px-6')
    expect(desk()).not.toHaveClass('bg-desk')
  })
})

describe('DocumentEditor typewriter (F-3.9, F-6.7)', () => {
  it('follows the setting and focus mode without rebuilding the editor', async () => {
    const editor = await mountReadyWithEditor()
    expect(editor.storage.typewriter?.enabled).toBe(false)
    expect(box().parentElement?.className).not.toContain('pb-[50vh]')
    act(() => useFocusStore.setState({ active: true }))
    expect(editor.storage.typewriter?.enabled).toBe(true)
    expect(box().parentElement?.className).toContain('pb-[50vh]')
    act(() => useFocusStore.setState({ active: false }))
    expect(editor.storage.typewriter?.enabled).toBe(false)
    // `update` only patches loaded settings; the store is empty here, so seed it as `load` would.
    act(() =>
      useEditorSettingsStore.setState({
        settings: { ...defaultEditorSettings('novel'), typewriter: true }
      })
    )
    expect(editor.storage.typewriter?.enabled).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Document' })).toBe(box())
  })
})

describe('DocumentEditor active editor (F-5.4)', () => {
  it('registers the ready instance as the active editor and releases it on unmount', async () => {
    install()
    expect(useActiveEditorStore.getState().active).toBeNull()
    const { unmount } = render(<DocumentEditor id="sc-1" format="novel" />)
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    const active = useActiveEditorStore.getState().active
    expect(active?.id).toBe('sc-1')
    expect(active?.editor.view.dom).toBe(box())
    unmount()
    expect(useActiveEditorStore.getState().active).toBeNull()
  })

  it('the focused region of a stack takes over from the last one mounted', async () => {
    install()
    render(
      <>
        <DocumentEditor id="sc-1" format="novel" toolbar={false} />
        <DocumentEditor id="sc-2" format="novel" toolbar={false} />
      </>
    )
    const boxes = (): HTMLElement[] => screen.getAllByRole('textbox', { name: 'Document' })
    await waitFor(() =>
      expect(boxes().every((b) => b.getAttribute('contenteditable') === 'true')).toBe(true)
    )
    expect(useActiveEditorStore.getState().active?.id).toBe('sc-2')
    await userEvent.click(boxes()[0]!)
    expect(useActiveEditorStore.getState().active?.id).toBe('sc-1')
  })
})

describe('DocumentEditor status bar AI share (F-14.6)', () => {
  const markedDoc = (): TiptapNodeT => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Into the' },
          {
            type: 'text',
            text: ' dark',
            marks: [{ type: 'aiOrigin', attrs: { proposalId: 'p1', accepted: 5 } }]
          }
        ]
      }
    ]
  })

  it('shows the live percentage of AI-origin characters, and nothing for a document without any', async () => {
    await mountReady({ 'document:get': () => ({ id: 'sc-1', content: markedDoc() }) })
    expect(screen.getByTestId('status-ai')).toHaveTextContent('38% AI')
    expect(box().querySelectorAll('.ai-origin[data-proposal-id="p1"]')).toHaveLength(1)
    await userEvent.keyboard(' woods')
    await waitFor(() => expect(screen.getByTestId('status-ai')).toHaveTextContent('26% AI'))
    expect(screen.getByTestId('status-words')).toHaveTextContent('4 words')
  })

  it('shows no share for a document without AI text', async () => {
    await mountReady()
    expect(screen.queryByTestId('status-ai')).not.toBeInTheDocument()
    await userEvent.keyboard(' woods')
    expect(screen.queryByTestId('status-ai')).not.toBeInTheDocument()
  })
})

describe('DocumentEditor inline tags (F-4.6)', () => {
  it('typing # opens the suggestions at the caret; Tab inserts the token plus a space and links the tag', async () => {
    const calls = await mountReady()
    await userEvent.keyboard(' #dar')
    await waitFor(() => expect(options()).toEqual(['dark-forest', 'Create #dar']))
    expect(screen.getByRole('option', { name: 'dark-forest' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(tokens()).toHaveLength(1))
    expect(screen.queryByRole('listbox', { name: 'Tag suggestions' })).not.toBeInTheDocument()
    expect(tokens()[0]).toHaveTextContent('#dark-forest')
    expect(tokens()[0]?.style.getPropertyValue('--tag-color')).toBe('#ea580c')
    expect(paragraph()).toMatchObject([
      { type: 'text', text: 'Into the ' },
      { type: 'inlineTag', attrs: { id: 't-forest', name: 'dark-forest' } },
      { type: 'text', text: ' ' }
    ])
    expect(paragraph()[2]?.text?.startsWith(' ')).toBe(true)
    expect(calls).toContainEqual(['documentTag:add', { nodeId: 'sc-1', tagId: 't-forest' }])
    await waitFor(() => expect(chips()).toEqual(['Remove dark-forest']))
    expect(inlineRows()).toEqual(['dark-forest ×1'])
    expect(useTagStore.getState().byId['t-forest']?.usageCount).toBe(4)
    // The token counts as one word in the live status bar (F-3.3).
    expect(screen.getByTestId('status-words')).toHaveTextContent('3 words')
  })

  it('Enter on the Create row makes a custom tag from the text and inserts it; a second occurrence counts ×2', async () => {
    const calls = await mountReady()
    await userEvent.keyboard(' #Storm_Front')
    await waitFor(() => expect(options()).toEqual(['Create #storm-front']))
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(tokens()).toHaveLength(1))
    expect(calls).toContainEqual(['tag:create', { name: 'storm-front', category: 'custom' }])
    expect(calls).toContainEqual(['documentTag:add', { nodeId: 'sc-1', tagId: 't-new-1' }])
    expect(tokens()[0]).toHaveTextContent('#storm-front')
    expect(tokens()[0]?.style.getPropertyValue('--tag-color')).toBe('#6b7280')
    await waitFor(() => expect(inlineRows()).toEqual(['storm-front ×1']))
    await userEvent.keyboard('#storm')
    await waitFor(() => expect(options()).toEqual(['storm-front', 'Create #storm']))
    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(inlineRows()).toEqual(['storm-front ×2']))
    expect(calls.filter(([channel]) => channel === 'tag:create')).toHaveLength(1)
  })

  it('a failed create toasts and leaves the text as typed', async () => {
    await mountReady({
      'tag:create': () => {
        throw new IpcRequestError({ code: 'ALREADY_EXISTS', message: 'A tag named "zzz" exists' })
      }
    })
    await userEvent.keyboard(' #zzz')
    await waitFor(() => expect(options()).toEqual(['Create #zzz']))
    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(toasts()).toEqual(['A tag named "zzz" exists']))
    expect(tokens()).toHaveLength(0)
    expect(box()).toHaveTextContent('Into the #zzz')
  })

  it('Escape closes the suggestions without touching the text', async () => {
    const calls = await mountReady()
    await userEvent.keyboard(' #mo')
    await waitFor(() => expect(options()).toEqual(['moody', 'Create #mo']))
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Tag suggestions' })).not.toBeInTheDocument()
    )
    expect(box()).toHaveTextContent('Into the #mo')
    expect(calls.filter(([channel]) => channel === 'documentTag:add')).toHaveLength(0)
  })

  it('right-click on a token: Remove deletes the token only, the link stays', async () => {
    const calls = await mountReady()
    await userEvent.keyboard(' #dar')
    await waitFor(() => expect(options()).toEqual(['dark-forest', 'Create #dar']))
    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(chips()).toEqual(['Remove dark-forest']))
    fireEvent.contextMenu(tokens()[0]!, { clientX: 40, clientY: 50 })
    const menu = screen.getByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.textContent)
    ).toEqual(['Remove', 'Open in Tag Manager'])
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Remove' }))
    await waitFor(() => expect(tokens()).toHaveLength(0))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(paragraph().filter((n) => n.type === 'inlineTag')).toHaveLength(0)
    expect(box()).toHaveTextContent('Into the')
    expect(calls.filter(([channel]) => channel === 'documentTag:remove')).toHaveLength(0)
    expect(chips()).toEqual(['Remove dark-forest'])
    expect(within(bar()).queryByRole('list', { name: 'Inline tags' })).not.toBeInTheDocument()
  })

  it('right-click on a token: Open in Tag Manager shows the Tags tab and requests the tag', async () => {
    await mountReady()
    await userEvent.keyboard(' #dar')
    await waitFor(() => expect(options()).toEqual(['dark-forest', 'Create #dar']))
    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(tokens()).toHaveLength(1))
    act(() => useLayoutStore.getState().toggle('sidebar'))
    expect(useLayoutStore.getState().layout.sidebar.open).toBe(false)
    fireEvent.contextMenu(tokens()[0]!, { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open in Tag Manager' }))
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('tags')
    expect(useLayoutStore.getState().layout.sidebar.open).toBe(true)
    expect(useTagStore.getState().pendingSelection).toEqual({ id: 't-forest', token: 1 })
    expect(tokens()).toHaveLength(1)
  })

  it('a token of a merged tag paints as the tag it was merged into and opens it in the Tag Manager (F-4.9)', async () => {
    await mountReady()
    await userEvent.keyboard(' #dar')
    await waitFor(() => expect(options()).toEqual(['dark-forest', 'Create #dar']))
    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(tokens()).toHaveLength(1))
    act(() => {
      const byId = Object.fromEntries(
        Object.entries(useTagStore.getState().byId).filter(([id]) => id !== 't-forest')
      )
      useTagStore.setState({
        byId,
        ids: Object.keys(byId),
        aliases: { 't-forest': 't-mara' }
      })
    })
    expect(tokens()[0]).toHaveTextContent('#mara')
    fireEvent.contextMenu(tokens()[0]!, { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open in Tag Manager' }))
    expect(useTagStore.getState().pendingSelection).toEqual({ id: 't-mara', token: 1 })
  })

  it('a right-click on plain text opens no menu', async () => {
    await mountReady()
    fireEvent.contextMenu(box().querySelector('p')!, { clientX: 40, clientY: 50 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('a rename or recolor in the bank repaints the tokens in place', async () => {
    await mountReady()
    await userEvent.keyboard(' #dar')
    await waitFor(() => expect(options()).toEqual(['dark-forest', 'Create #dar']))
    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(tokens()).toHaveLength(1))
    act(() => {
      useTagStore.getState().merge({ ...tagFixture[0]!, name: 'gloomy-wood', color: '#112233' })
    })
    expect(tokens()[0]).toHaveTextContent('#gloomy-wood')
    expect(tokens()[0]?.style.getPropertyValue('--tag-color')).toBe('#112233')
    expect(paragraph()[1]?.attrs).toEqual({ id: 't-forest', name: 'dark-forest' })
    await waitFor(() => expect(inlineRows()).toEqual(['gloomy-wood ×1']))
  })

  it('inserting mid-text swallows one existing following space instead of doubling it', async () => {
    const editor = await mountReadyWithEditor({
      'document:get': (input) => ({
        id: (input as Input<'document:get'>).id,
        content: doc('Into the forest')
      })
    })
    // Right after "the", before the existing space and "forest": typing a new "#dar" here
    // (like inserting a tag reference ahead of an existing word) leaves that old space right
    // after the query, the exact case the swallow guards.
    act(() => {
      editor.chain().focus().setTextSelection(9).run()
    })
    await userEvent.keyboard(' #dar')
    await waitFor(() => expect(options()).toEqual(['dark-forest', 'Create #dar']))
    await userEvent.keyboard('{Tab}')
    await waitFor(() => expect(tokens()).toHaveLength(1))
    expect(paragraph()).toMatchObject([
      { type: 'text', text: 'Into the ' },
      { type: 'inlineTag', attrs: { id: 't-forest', name: 'dark-forest' } },
      { type: 'text', text: ' forest' }
    ])
  })
})

describe('DocumentEditor granular tags (F-4.8)', () => {
  const SCENE = 'Mara waited by the gate.'
  const tagged = (): TiptapNodeT[] =>
    paragraph().filter((n) => n.marks?.some((m) => m.type === 'tagRange'))
  const ranges = (): HTMLElement[] =>
    Array.from(box().querySelectorAll<HTMLElement>('[data-tag-range]'))
  const menuItems = (): (string | null)[] =>
    within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
  const mountScene = () =>
    mountReadyWithEditor({ 'document:get': () => ({ id: 'sc-1', content: doc(SCENE) }) })

  /** Selects `from..to`, right-clicks the paragraph, picks Tag selection… and then `tag`. */
  async function tagSelection(editor: Editor, from: number, to: number, tag: string) {
    act(() => {
      editor.commands.setTextSelection({ from, to })
    })
    fireEvent.contextMenu(box().querySelector('p')!, { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Tag selection…' }))
    const picker = screen.getByRole('group', { name: 'Tag selection' })
    await userEvent.click(within(picker).getByRole('option', { name: tag }))
    expect(screen.queryByRole('group', { name: 'Tag selection' })).not.toBeInTheDocument()
  }

  it('right-click over a selection: Tag selection… marks the text, paints it, and links the tag', async () => {
    const editor = await mountScene()
    const calls = install({ 'document:get': () => ({ id: 'sc-1', content: doc(SCENE) }) })
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 })
    })
    fireEvent.contextMenu(box().querySelector('p')!, { clientX: 40, clientY: 50 })
    expect(menuItems()).toEqual(['Tag selection…', 'Clear tags in selection'])
    expect(screen.getByRole('menuitem', { name: 'Clear tags in selection' })).toBeDisabled()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Tag selection…' }))
    const picker = screen.getByRole('group', { name: 'Tag selection' })
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(tagFixture.map((t) => t.name))
    await userEvent.click(within(picker).getByRole('option', { name: 'mara' }))
    expect(tagged()).toEqual([
      { type: 'text', text: 'Mara', marks: [{ type: 'tagRange', attrs: { tagId: 't-mara' } }] }
    ])
    expect(ranges()).toHaveLength(1)
    expect(ranges()[0]).toHaveAttribute('data-tag-id', 't-mara')
    expect(box().querySelector('p')).toHaveClass('tag-range-block')
    await waitFor(() =>
      expect(calls).toContainEqual(['documentTag:add', { nodeId: 'sc-1', tagId: 't-mara' }])
    )
  })

  it('Clear tags in selection removes the ranges in it and leaves the link', async () => {
    const editor = await mountScene()
    await tagSelection(editor, 1, 5, 'mara')
    await waitFor(() => expect(chips()).toEqual(['Remove mara']))
    const calls = install({ 'document:get': () => ({ id: 'sc-1', content: doc(SCENE) }) })
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 12 })
    })
    fireEvent.contextMenu(box().querySelector('p')!, { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Clear tags in selection' }))
    expect(tagged()).toEqual([])
    expect(ranges()).toHaveLength(0)
    expect(box().querySelector('p')).not.toHaveClass('tag-range-block')
    expect(calls.filter(([channel]) => channel === 'documentTag:remove')).toHaveLength(0)
    expect(chips()).toEqual(['Remove mara'])
  })

  it('right-click on a range without a selection offers Clear tags here, which clears it whole', async () => {
    const editor = await mountScene()
    await tagSelection(editor, 1, 12, 'dark-forest')
    act(() => {
      editor.commands.setTextSelection(3)
    })
    fireEvent.contextMenu(ranges()[0]!, { clientX: 40, clientY: 50 })
    expect(menuItems()).toEqual(['Clear tags here'])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Clear tags here' }))
    expect(tagged()).toEqual([])
  })

  it('a word the browser selects on the right-click itself (a misspelling) opens no menu', async () => {
    const editor = await mountScene()
    act(() => {
      editor.commands.setTextSelection(3)
    })
    const p = box().querySelector('p')!
    fireEvent.mouseDown(p, { button: 2 })
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 })
    })
    fireEvent.contextMenu(p, { clientX: 40, clientY: 50 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('DocumentEditor proofread (F-14.12)', () => {
  const SCENE = 'Into the dark woods they went, without a word.'

  it('sends the pass of the selection, and unmounting the editor dismisses it', async () => {
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
    let sent: Input<'ai:proofread'> | null = null
    let cancelled: string | null = null
    const editor = await mountReadyWithEditor({
      'document:get': () => ({ id: 'sc-1', content: doc(SCENE) }),
      'ai:proofread': (input) =>
        new Promise<AiProofreadResult>(() => {
          sent = input as Input<'ai:proofread'>
        }),
      'ai:cancel': (input) => {
        cancelled = (input as Input<'ai:cancel'>).requestId
        return { cancelled: true }
      }
    })
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 31 })
      useProofreadStore.getState().start('sc-1', editor)
    })
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent).toMatchObject({ nodeId: 'sc-1', selection: 'Into the dark woods they went,' })
    const requestId = useProofreadStore.getState().session?.requestId ?? null
    cleanup()
    expect(useProofreadStore.getState().session).toBeNull()
    await waitFor(() => expect(cancelled).toBe(requestId))
  })
})
