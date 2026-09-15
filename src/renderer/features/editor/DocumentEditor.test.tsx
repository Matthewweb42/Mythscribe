import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import {
  resetDocumentTagStore,
  useDocumentTagStore
} from '@renderer/features/tags/documentTagStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetActiveEditorStore, useActiveEditorStore } from './activeEditorStore'
import { DocumentEditor } from './DocumentEditor'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { resetSceneMetaStore } from './sceneMetaStore'
import { resetVoiceStore } from '@renderer/features/ai/voiceStore'
import { resetEditorSettingsStore } from './settingsStore'

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
      if (channel === 'tag:create') {
        const value = input as Input<'tag:create'>
        const tag: Tag = {
          id: `t-new-${++counter}`,
          name: toTagName(value.name),
          category: value.category,
          color: value.color ?? '#6b7280',
          parentId: null,
          usageCount: 0,
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
        return (links[nodeId] ?? []).map(tagOf) as Output<C>
      }
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
  render(
    <DocumentEditor
      id="sc-1"
      format="novel"
      onFocus={(focused) => {
        editor = focused
      }}
    />
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
  overrides: Partial<Record<Channel, Handler>> = {}
): Promise<Editor> {
  install(overrides)
  await act(async () => {
    await useTagStore.getState().load()
  })
  let editor: Editor | null = null
  render(
    <DocumentEditor
      id="sc-1"
      format="novel"
      onFocus={(focused) => {
        editor = focused
      }}
    />
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
  resetLayoutStore()
  resetSceneMetaStore()
  resetVoiceStore()
  resetActiveEditorStore()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetDocumentStore()
  resetEditorSettingsStore()
  resetPendingSaves()
  resetTagStore()
  resetDocumentTagStore()
  resetLayoutStore()
  resetSceneMetaStore()
  resetVoiceStore()
  resetActiveEditorStore()
})

describe('DocumentEditor focus mode (F-6.1)', () => {
  it('carries the Focus mode button in the toolbar and drops the toolbar and tag bar while active', async () => {
    await mountReady()
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    expect(within(toolbar).getByRole('button', { name: 'Focus mode' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(bar()).toBeInTheDocument()

    act(() => useFocusStore.setState({ active: true }))
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Tags' })).not.toBeInTheDocument()
    // The surface and the status bar stay, and the document is still the same instance.
    expect(box()).toHaveAttribute('contenteditable', 'true')
    expect(box()).toHaveTextContent('Into the')
    expect(screen.getByTestId('status-words')).toBeInTheDocument()

    act(() => useFocusStore.setState({ active: false }))
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
    expect(bar()).toBeInTheDocument()
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
