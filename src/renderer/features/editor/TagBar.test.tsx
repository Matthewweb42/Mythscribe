import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiRecommendTagsResult, Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import {
  resetDocumentTagStore,
  useDocumentTagStore
} from '@renderer/features/tags/documentTagStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { resetSceneMetaStore } from './sceneMetaStore'
import { TagBar } from './TagBar'

type Handler = (input: unknown) => unknown

/**
 * A fake main: the bank is the fixture, `sc-1` starts with `dark-forest` linked, and add/remove
 * answer with the tag and a moved usage count, like the real store does.
 */
function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const links: Record<string, string[]> = { 'sc-1': ['t-forest'] }
  const tagOf = (id: string): Tag => {
    const tag = useTagStore.getState().byId[id]
    if (!tag) throw new Error(`no tag ${id}`)
    return tag
  }
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'tag:list') return tagFixture as Output<C>
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
      if (channel === 'documentTag:remove') {
        const { nodeId, tagId } = input as Input<'documentTag:remove'>
        const tag = tagOf(tagId)
        if (!links[nodeId]?.includes(tagId)) return tag as Output<C>
        links[nodeId] = links[nodeId].filter((id) => id !== tagId)
        return { ...tag, usageCount: tag.usageCount - 1 } as Output<C>
      }
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        return { id, meta: { location: '', pov: '', timeline: '' } } as Output<C>
      }
      if (channel === 'proposal:settle') return null as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const bar = (): HTMLElement => screen.getByRole('region', { name: 'Tags' })
const chips = (): HTMLElement[] => within(bar()).queryAllByRole('listitem')
const chipNames = (): string[] =>
  chips().map((chip) => within(chip).getByRole('button').getAttribute('aria-label') ?? '')
const addButton = (): HTMLElement => within(bar()).getByRole('button', { name: 'Add tag' })
const search = (): HTMLElement => screen.getByRole('searchbox', { name: 'Search tags' })
const options = (): string[] =>
  within(screen.getByRole('listbox', { name: 'Unassigned tags' }))
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

/** A document of `n` characters in one paragraph, put in the document store for `id`. */
function loadText(id: string, n: number): void {
  act(() => {
    useDocumentStore.setState({
      docs: {
        [id]: {
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(n) }] }]
          },
          dirty: false
        }
      }
    })
  })
}
const recommendButton = (): HTMLElement => within(bar()).getByRole('button', { name: 'Recommend' })
const suggestionNames = (): string[] =>
  within(within(bar()).getByRole('list', { name: 'Suggested tags' }))
    .getAllByRole('listitem')
    .map((chip) => chip.querySelector('span:not([aria-hidden])')?.textContent ?? '')
const suggested = (...ids: string[]): AiRecommendTagsResult => ({
  ok: true,
  suggestions: ids.map((id) => tagFixture.find((t) => t.id === id)!),
  usage: { inputTokens: 40, outputTokens: 10 },
  costUsd: 0.0012,
  cached: false,
  model: 'gpt-5.4-mini',
  promptVersion: 'tags.v1',
  proposalId: 'prop-1'
})
/** The same result as a different proposal, so a test can settle two in a row (the store guards per id). */
const asProposal = (result: AiRecommendTagsResult, proposalId: string): AiRecommendTagsResult =>
  result.ok ? { ...result, proposalId } : result
/** Answers each Recommend request with the next result; a run past the end is a test error. */
const answerInOrder = (...results: AiRecommendTagsResult[]): (() => AiRecommendTagsResult) => {
  const queue = [...results]
  return () => {
    const next = queue.shift()
    if (!next) throw new Error('no more canned results')
    return next
  }
}
const settlements = (calls: [Channel, unknown][]): unknown[] =>
  calls.filter(([channel]) => channel === 'proposal:settle').map(([, input]) => input)
const recommendInputs = (calls: [Channel, unknown][]): unknown[] =>
  calls.filter(([channel]) => channel === 'ai:recommendTags').map(([, input]) => input)
const regenerateButton = (): HTMLElement =>
  within(bar()).getByRole('button', { name: 'Regenerate…' })
const noteDialog = (): HTMLElement =>
  screen.getByRole('dialog', { name: "What's off about these?" })

/** Renders the bar for `id` once the bank is loaded, and waits for its links. */
async function mount(id = 'sc-1'): Promise<ReturnType<typeof render>> {
  await useTagStore.getState().load()
  const view = render(<TagBar id={id} />)
  await waitFor(() => expect(useDocumentTagStore.getState().tagIdsByNode[id]).toBeDefined())
  return view
}

beforeEach(() => {
  resetTagStore()
  resetDocumentTagStore()
  resetLayoutStore()
  resetSceneMetaStore()
  resetDocumentStore()
  resetProposalStore()
  useTreeStore.setState({ ...buildIndex([]), loaded: true })
  useDialogStore.setState({ modals: [], toasts: [] })
  vi.stubGlobal('innerHeight', 800)
})
afterEach(() => {
  resetProposalStore()
  vi.unstubAllGlobals()
})

describe('TagBar (F-4.4)', () => {
  it('loads the document links and shows each linked tag as a chip with its color and a remove button', async () => {
    const calls = install()
    await mount()
    expect(calls).toContainEqual(['documentTag:list', { nodeId: 'sc-1' }])
    expect(chipNames()).toEqual(['Remove dark-forest'])
    const chip = chips()[0]!
    expect(chip).toHaveTextContent('dark-forest')
    expect(chip.querySelector('span[aria-hidden]')).toHaveStyle({ backgroundColor: '#ea580c' })
    expect(within(bar()).getByRole('button', { name: /^Tags/ })).toHaveTextContent('Tags1')
    expect(within(bar()).getByRole('list', { name: 'Document tags' })).toBeInTheDocument()
  })

  it('reads the chip from the bank, so a rename or recolor there shows at once', async () => {
    install()
    await mount()
    act(() => {
      useTagStore.getState().merge({ ...tagFixture[0]!, name: 'gloomy-wood', color: '#112233' })
    })
    expect(chipNames()).toEqual(['Remove gloomy-wood'])
    expect(chips()[0]!.querySelector('span[aria-hidden]')).toHaveStyle({
      backgroundColor: '#112233'
    })
  })

  it('removing a chip unlinks it and moves the usage count in the bank', async () => {
    const calls = install()
    await mount()
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove dark-forest' }))
    await waitFor(() => expect(chips()).toHaveLength(0))
    expect(calls.at(-1)).toEqual(['documentTag:remove', { nodeId: 'sc-1', tagId: 't-forest' }])
    expect(useTagStore.getState().byId['t-forest']?.usageCount).toBe(2)
    expect(within(bar()).getByText('No tags on this document.')).toBeInTheDocument()
    expect(within(bar()).getByRole('button', { name: /^Tags/ })).toHaveTextContent('Tags0')
  })

  it('Add tag opens a picker of the unassigned tags only; typing filters; Enter links the active one and closes', async () => {
    const calls = install()
    await mount()
    await userEvent.click(addButton())
    expect(addButton()).toHaveAttribute('aria-expanded', 'true')
    expect(search()).toHaveFocus()
    expect(options()).toEqual(['mara', 'moody'])
    await userEvent.keyboard('mo')
    expect(options()).toEqual(['moody'])
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(chipNames()).toEqual(['Remove dark-forest', 'Remove moody']))
    expect(calls.at(-1)).toEqual(['documentTag:add', { nodeId: 'sc-1', tagId: 't-moody' }])
    expect(useTagStore.getState().byId['t-moody']?.usageCount).toBe(1)
    expect(screen.queryByRole('searchbox', { name: 'Search tags' })).not.toBeInTheDocument()
    expect(addButton()).toHaveAttribute('aria-expanded', 'false')
  })

  it('ArrowDown and ArrowUp move the active option; a click picks too', async () => {
    install()
    await mount()
    await userEvent.click(addButton())
    const listbox = (): HTMLElement => screen.getByRole('listbox', { name: 'Unassigned tags' })
    const selected = (): string[] =>
      within(listbox())
        .getAllByRole('option', { selected: true })
        .map((o) => o.textContent ?? '')
    expect(selected()).toEqual(['mara'])
    await userEvent.keyboard('{ArrowDown}')
    expect(selected()).toEqual(['moody'])
    expect(search()).toHaveAttribute(
      'aria-activedescendant',
      within(listbox()).getByRole('option', { name: 'moody' }).id
    )
    await userEvent.keyboard('{ArrowDown}')
    expect(selected()).toEqual(['moody']) // stays on the last option
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(selected()).toEqual(['mara'])
    await userEvent.click(within(listbox()).getByRole('option', { name: 'mara' }))
    await waitFor(() => expect(chipNames()).toEqual(['Remove dark-forest', 'Remove mara']))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('Escape and an outside click close the picker without linking', async () => {
    const calls = install()
    await mount()
    await userEvent.click(addButton())
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('searchbox', { name: 'Search tags' })).not.toBeInTheDocument()
    await userEvent.click(addButton())
    expect(search()).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('searchbox', { name: 'Search tags' })).not.toBeInTheDocument()
    expect(calls.filter(([channel]) => channel === 'documentTag:add')).toHaveLength(0)
    expect(chipNames()).toEqual(['Remove dark-forest'])
  })

  it('tells the author where tags are created when the bank is empty, and when every tag is linked', async () => {
    install({ 'tag:list': () => [], 'documentTag:list': () => [] })
    const view = await mount()
    await userEvent.click(addButton())
    expect(screen.getByText(/Create tags in the Tags tab/)).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    view.unmount()
    resetTagStore()
    resetDocumentTagStore()
    install({ 'documentTag:list': () => tagFixture })
    await mount('sc-2')
    await userEvent.click(within(bar()).getByRole('button', { name: 'Add tag' }))
    expect(screen.getByText('Every tag is already on this document.')).toBeInTheDocument()
    await userEvent.keyboard('zzz')
    expect(screen.getByText('No tags match.')).toBeInTheDocument()
  })

  it('a failed link or unlink toasts and leaves the chips as they were', async () => {
    const failure = (): never => {
      throw new IpcRequestError({ code: 'NOT_FOUND', message: 'Tag not found' })
    }
    install({ 'documentTag:add': failure, 'documentTag:remove': failure })
    await mount()
    await userEvent.click(addButton())
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(toasts()).toEqual(['Tag not found']))
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove dark-forest' }))
    await waitFor(() => expect(toasts()).toEqual(['Tag not found', 'Tag not found']))
    expect(chipNames()).toEqual(['Remove dark-forest'])
  })

  it('collapses and expands through the layout store, hiding the chips, the picker, and the handle', async () => {
    install()
    await mount()
    const toggle = within(bar()).getByRole('button', { name: /^Tags/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(bar().style.height).toBe('120px')
    expect(within(bar()).getByRole('separator', { name: 'Resize tag bar' })).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(useLayoutStore.getState().layout.tagBar).toEqual({
      open: false,
      height: 120,
      split: 0.4
    })
    expect(chips()).toHaveLength(0)
    expect(within(bar()).queryByRole('button', { name: 'Add tag' })).not.toBeInTheDocument()
    expect(within(bar()).queryByRole('separator')).not.toBeInTheDocument()
    expect(bar().style.height).toBe('')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(chipNames()).toEqual(['Remove dark-forest'])
  })

  it('the bottom handle resizes the bar in px within the floor and 60 % of the window', async () => {
    install()
    await mount()
    const handle = within(bar()).getByRole('separator', { name: 'Resize tag bar' })
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal')
    expect(handle).toHaveAttribute('aria-valuenow', '120')
    expect(handle).toHaveAttribute('aria-valuemin', '100')
    expect(handle).toHaveAttribute('aria-valuemax', '480')
    fireEvent.pointerDown(handle, { clientY: 300, button: 0 })
    fireEvent.pointerMove(window, { clientY: 380 })
    expect(useLayoutStore.getState().layout.tagBar.height).toBe(200)
    expect(bar().style.height).toBe('200px')
    fireEvent.pointerMove(window, { clientY: 1380 })
    expect(useLayoutStore.getState().layout.tagBar.height).toBe(480)
    fireEvent.pointerMove(window, { clientY: 0 })
    fireEvent.pointerUp(window)
    expect(useLayoutStore.getState().layout.tagBar.height).toBe(100)
    expect(handle).toHaveAttribute('aria-valuenow', '100')
  })

  it('switching documents loads the new links and closes an open picker', async () => {
    const calls = install()
    const view = await mount()
    await userEvent.click(addButton())
    expect(search()).toBeInTheDocument()
    view.rerender(<TagBar id="sc-2" />)
    await waitFor(() => expect(useDocumentTagStore.getState().tagIdsByNode['sc-2']).toEqual([]))
    expect(calls).toContainEqual(['documentTag:list', { nodeId: 'sc-2' }])
    expect(screen.queryByRole('searchbox', { name: 'Search tags' })).not.toBeInTheDocument()
    expect(chips()).toHaveLength(0)
  })

  it('lists the inline tags of the document\u2019s live content with occurrence counts (F-4.6)', async () => {
    install()
    await mount()
    expect(within(bar()).queryByRole('list', { name: 'Inline tags' })).not.toBeInTheDocument()
    const token = (id: string) => ({ type: 'inlineTag', attrs: { id, name: id } })
    act(() => {
      useDocumentStore.setState({
        docs: {
          'sc-1': {
            content: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [token('t-moody'), token('t-forest')] },
                { type: 'paragraph', content: [token('t-moody'), token('t-deleted')] }
              ]
            },
            dirty: false
          }
        }
      })
    })
    const rows = within(within(bar()).getByRole('list', { name: 'Inline tags' })).getAllByRole(
      'listitem'
    )
    // Order of first appearance; a token whose tag left the bank is not listed.
    expect(rows.map((row) => row.textContent)).toEqual(['moody ×2', 'dark-forest ×1'])
    expect(rows[0]!.querySelector('span[aria-hidden]')).toHaveStyle({ backgroundColor: '#2563eb' })
    // Chips are the explicit links only: an inline occurrence adds no chip by itself.
    expect(
      within(within(bar()).getByRole('list', { name: 'Document tags' })).getAllByRole('listitem')
    ).toHaveLength(1)
    act(() => {
      useDocumentStore.setState({
        docs: {
          'sc-1': { content: { type: 'doc', content: [{ type: 'paragraph' }] }, dirty: true }
        }
      })
    })
    expect(within(bar()).queryByRole('list', { name: 'Inline tags' })).not.toBeInTheDocument()
  })

  it('shows the metadata pane behind a persisted split only for a node with a hierarchy level (F-4.5)', async () => {
    install()
    await mount()
    expect(screen.queryByRole('group', { name: 'Scene metadata' })).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize metadata pane' })).toBeNull()
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    const pane = await screen.findByRole('group', { name: 'Scene metadata' })
    expect(pane).toBeInTheDocument()
    const split = screen.getByRole('separator', { name: 'Resize metadata pane' })
    expect(split).toHaveAttribute('aria-valuenow', '40')
    expect(split).toHaveAttribute('aria-valuemin', '30')
    expect(split).toHaveAttribute('aria-valuemax', '70')
    expect(chipNames()).toEqual(['Remove dark-forest'])
    // jsdom lays nothing out: give the pane row a width so a key step becomes a fraction.
    const toggle = screen.getByRole('button', { name: /^Tags/ })
    const row = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    if (!row) throw new Error('pane row not found')
    Object.defineProperty(row, 'clientWidth', { value: 800, configurable: true })
    await act(async () => {
      fireEvent.keyDown(split, { key: 'ArrowLeft' })
    })
    expect(useLayoutStore.getState().layout.tagBar.split).toBeLessThan(0.4)
    expect(useLayoutStore.getState().layout.tagBar.split).toBeGreaterThanOrEqual(0.3)
  })

  describe('Recommend (F-4.7)', () => {
    it('is disabled with a title until the live text has 50 characters; a folder never has any', async () => {
      install()
      await mount()
      expect(recommendButton()).toBeDisabled()
      expect(recommendButton()).toHaveAttribute(
        'title',
        'Add at least 50 characters to get tag suggestions'
      )
      loadText('sc-1', 49)
      expect(recommendButton()).toBeDisabled()
      loadText('sc-1', 50)
      expect(recommendButton()).toBeEnabled()
      expect(recommendButton()).not.toHaveAttribute('title')
    })

    it('asks main once, shows a spinner while pending, then chips for the unlinked bank tags with the cost note', async () => {
      let resolve: (result: AiRecommendTagsResult) => void = () => {}
      const calls = install({
        'ai:recommendTags': () =>
          new Promise<AiRecommendTagsResult>((r) => {
            resolve = r
          })
      })
      await mount()
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      expect(recommendButton()).toBeDisabled()
      expect(recommendButton().querySelector('.animate-spin')).not.toBeNull()
      expect(within(bar()).getByRole('status')).toHaveTextContent('Asking for tag suggestions…')
      expect(calls.filter(([channel]) => channel === 'ai:recommendTags')).toEqual([
        ['ai:recommendTags', { nodeId: 'sc-1' }]
      ])
      await act(async () => {
        resolve(suggested('t-mara', 't-moody'))
      })
      expect(recommendButton()).toBeEnabled()
      expect(suggestionNames()).toEqual(['mara', 'moody'])
      expect(screen.getByTestId('tag-recommend-cost')).toHaveTextContent('gpt-5.4-mini · $0.0012')
      expect(screen.getByTestId('tag-recommend-cost')).not.toHaveTextContent('cached')
      // The linked chips are untouched: nothing enters the document without an accept.
      expect(chipNames().filter((n) => n.startsWith('Remove'))).toEqual(['Remove dark-forest'])
      expect(calls.filter(([channel]) => channel === 'documentTag:add')).toHaveLength(0)
    })

    it('accepting a chip links it and removes the chip; the last accept clears the result', async () => {
      const calls = install({ 'ai:recommendTags': () => suggested('t-mara', 't-moody') })
      await mount()
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara', 'moody']))
      await userEvent.click(within(bar()).getByRole('button', { name: 'Accept moody' }))
      await waitFor(() => expect(suggestionNames()).toEqual(['mara']))
      expect(calls.at(-1)).toEqual(['documentTag:add', { nodeId: 'sc-1', tagId: 't-moody' }])
      expect(
        within(within(bar()).getByRole('list', { name: 'Document tags' })).getAllByRole('listitem')
      ).toHaveLength(2)
      expect(useTagStore.getState().byId['t-moody']?.usageCount).toBe(1)
      await userEvent.click(within(bar()).getByRole('button', { name: 'Accept mara' }))
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: 'Tag suggestions' })).not.toBeInTheDocument()
      )
      expect(useDocumentTagStore.getState().tagIdsByNode['sc-1']).toEqual([
        't-forest',
        't-moody',
        't-mara'
      ])
    })

    it('Accept all links every remaining chip and clears the result; Dismiss clears without linking', async () => {
      const calls = install({ 'ai:recommendTags': () => suggested('t-mara', 't-moody') })
      await mount()
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara', 'moody']))
      await userEvent.click(within(bar()).getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByRole('group', { name: 'Tag suggestions' })).not.toBeInTheDocument()
      expect(calls.filter(([channel]) => channel === 'documentTag:add')).toHaveLength(0)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara', 'moody']))
      await userEvent.click(within(bar()).getByRole('button', { name: 'Accept all' }))
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: 'Tag suggestions' })).not.toBeInTheDocument()
      )
      expect(calls.filter(([channel]) => channel === 'documentTag:add')).toEqual([
        ['documentTag:add', { nodeId: 'sc-1', tagId: 't-mara' }],
        ['documentTag:add', { nodeId: 'sc-1', tagId: 't-moody' }]
      ])
      expect(useDocumentTagStore.getState().tagIdsByNode['sc-1']).toEqual([
        't-forest',
        't-mara',
        't-moody'
      ])
    })

    it('a failed link toasts and keeps the chip', async () => {
      install({
        'ai:recommendTags': () => suggested('t-mara'),
        'documentTag:add': () => {
          throw new IpcRequestError({ code: 'NOT_FOUND', message: 'Tag not found' })
        }
      })
      await mount()
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara']))
      await userEvent.click(within(bar()).getByRole('button', { name: 'Accept mara' }))
      await waitFor(() => expect(toasts()).toEqual(['Tag not found']))
      expect(suggestionNames()).toEqual(['mara'])
      await userEvent.click(within(bar()).getByRole('button', { name: 'Accept all' }))
      await waitFor(() => expect(toasts()).toEqual(['Tag not found', 'Tag not found']))
      expect(suggestionNames()).toEqual(['mara'])
    })

    it('shows an expected failure inline with its next step, "No new tags fit." with the cached note, and toasts a transport error', async () => {
      const results: AiRecommendTagsResult[] = [
        {
          ok: false,
          code: 'DISABLED',
          message: 'Tag suggestions is turned off for this project.',
          nextStep: 'Turn the AI dial up in Settings, or enable the feature there.'
        },
        {
          ok: true,
          suggestions: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          cached: true,
          model: 'gpt-5.4-mini',
          promptVersion: 'tags.v1',
          proposalId: 'prop-2'
        }
      ]
      install({
        'ai:recommendTags': () => {
          const next = results.shift()
          if (!next) throw new IpcRequestError({ code: 'INTERNAL', message: 'bridge down' })
          return next
        }
      })
      await mount()
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      await waitFor(() =>
        expect(screen.getByTestId('tag-recommend-result')).toHaveTextContent(
          'Tag suggestions is turned off for this project. Turn the AI dial up in Settings, or enable the feature there.'
        )
      )
      expect(screen.getByTestId('tag-recommend-result')).toHaveClass('text-danger')
      await userEvent.click(recommendButton())
      await waitFor(() =>
        expect(screen.getByTestId('tag-recommend-result')).toHaveTextContent('No new tags fit.')
      )
      expect(screen.getByTestId('tag-recommend-cost')).toHaveTextContent(
        'gpt-5.4-mini · $0.0000 · cached'
      )
      expect(within(bar()).queryByRole('button', { name: 'Accept all' })).not.toBeInTheDocument()
      await userEvent.click(recommendButton())
      await waitFor(() => expect(toasts()).toEqual(['bridge down']))
      expect(screen.queryByRole('group', { name: 'Tag suggestions' })).not.toBeInTheDocument()
      expect(recommendButton()).toBeEnabled()
    })

    it('flushes unsaved typing before asking, so main sends what the author sees', async () => {
      const calls = install({
        'ai:recommendTags': () => suggested('t-mara'),
        'document:save': () => ({ wordCount: 1, modified: '2026-09-13T10:00:00.000Z' })
      })
      await mount()
      loadText('sc-1', 80)
      act(() => {
        useDocumentStore.getState().edit('sc-1', {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y'.repeat(80) }] }]
        })
      })
      expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(true)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara']))
      const order = calls.map(([channel]) => channel)
      expect(order.indexOf('document:save')).toBeGreaterThan(-1)
      expect(order.indexOf('document:save')).toBeLessThan(order.indexOf('ai:recommendTags'))
      expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(false)
    })

    it('switching documents drops the result without a new request', async () => {
      const calls = install({ 'ai:recommendTags': () => suggested('t-mara') })
      const view = await mount()
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara']))
      view.rerender(<TagBar id="sc-2" />)
      await waitFor(() => expect(useDocumentTagStore.getState().tagIdsByNode['sc-2']).toEqual([]))
      expect(screen.queryByRole('group', { name: 'Tag suggestions' })).not.toBeInTheDocument()
      expect(recommendButton()).toBeDisabled()
      expect(calls.filter(([channel]) => channel === 'ai:recommendTags')).toHaveLength(1)
    })
  })

  describe('Proposal review (F-14.5)', () => {
    it('Dismiss settles the proposal rejected when no chip was linked, accepted in part when one was', async () => {
      const calls = install({
        'ai:recommendTags': answerInOrder(
          suggested('t-mara', 't-moody'),
          asProposal(suggested('t-mara', 't-moody'), 'prop-2'),
          asProposal(suggested(), 'prop-3')
        )
      })
      await mount()
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara', 'moody']))
      await userEvent.click(within(bar()).getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByRole('group', { name: 'Tag suggestions' })).not.toBeInTheDocument()
      expect(settlements(calls)).toEqual([{ id: 'prop-1', status: 'rejected', note: null }])
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara', 'moody']))
      await userEvent.click(within(bar()).getByRole('button', { name: 'Accept moody' }))
      await waitFor(() => expect(suggestionNames()).toEqual(['mara']))
      await userEvent.click(within(bar()).getByRole('button', { name: 'Dismiss' }))
      expect(settlements(calls)).toEqual([
        { id: 'prop-1', status: 'rejected', note: null },
        { id: 'prop-2', status: 'acceptedPart', note: null }
      ])
      // An empty answer ("No new tags fit.") dismissed is rejected too: nothing was linked.
      await userEvent.click(recommendButton())
      await waitFor(() =>
        expect(screen.getByTestId('tag-recommend-result')).toHaveTextContent('No new tags fit.')
      )
      await userEvent.click(within(bar()).getByRole('button', { name: 'Dismiss' }))
      expect(settlements(calls).at(-1)).toEqual({ id: 'prop-3', status: 'rejected', note: null })
    })

    it('accepting every chip, one at a time or with Accept all, settles the proposal accepted', async () => {
      const calls = install({
        'ai:recommendTags': answerInOrder(
          suggested('t-mara', 't-moody'),
          asProposal(suggested('t-mara', 't-moody'), 'prop-2')
        )
      })
      await mount()
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara', 'moody']))
      await userEvent.click(within(bar()).getByRole('button', { name: 'Accept mara' }))
      await waitFor(() => expect(suggestionNames()).toEqual(['moody']))
      expect(settlements(calls)).toEqual([])
      await userEvent.click(within(bar()).getByRole('button', { name: 'Accept moody' }))
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: 'Tag suggestions' })).not.toBeInTheDocument()
      )
      expect(settlements(calls)).toEqual([{ id: 'prop-1', status: 'accepted', note: null }])
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara', 'moody']))
      await userEvent.click(within(bar()).getByRole('button', { name: 'Accept all' }))
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: 'Tag suggestions' })).not.toBeInTheDocument()
      )
      expect(settlements(calls)).toEqual([
        { id: 'prop-1', status: 'accepted', note: null },
        { id: 'prop-2', status: 'accepted', note: null }
      ])
    })

    it('Regenerate… asks for a note, settles the proposal regenerated with it, and carries the note and the proposal id into the next request', async () => {
      const calls = install({
        'ai:recommendTags': answerInOrder(
          suggested('t-mara', 't-moody'),
          asProposal(suggested('t-moody'), 'prop-2'),
          asProposal(suggested('t-mara'), 'prop-3')
        )
      })
      await useTagStore.getState().load()
      render(
        <>
          <TagBar id="sc-1" />
          <DialogHost />
        </>
      )
      await waitFor(() => expect(useDocumentTagStore.getState().tagIdsByNode['sc-1']).toBeDefined())
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara', 'moody']))
      await userEvent.click(regenerateButton())
      const dialog = noteDialog()
      expect(dialog).toHaveTextContent('Optional.')
      const input = within(dialog).getByRole('textbox', { name: "What's off about these?" })
      expect(input).toHaveFocus()
      // Over the stored bound the dialog refuses and nothing leaves.
      await userEvent.paste('x'.repeat(301))
      await userEvent.click(within(dialog).getByRole('button', { name: 'Regenerate' }))
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Keep the note under 300 characters.'
      )
      expect(settlements(calls)).toEqual([])
      await userEvent.clear(input)
      await userEvent.type(input, '  Too generic for this scene.  ')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Regenerate' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      await waitFor(() => expect(suggestionNames()).toEqual(['moody']))
      expect(settlements(calls)).toEqual([
        { id: 'prop-1', status: 'regenerated', note: 'Too generic for this scene.' }
      ])
      expect(recommendInputs(calls)).toEqual([
        { nodeId: 'sc-1' },
        { nodeId: 'sc-1', note: 'Too generic for this scene.', regeneratedFrom: 'prop-1' }
      ])
      // Nothing was linked by asking again.
      expect(calls.filter(([channel]) => channel === 'documentTag:add')).toHaveLength(0)
      // A blank note is sent as none, and the chain points at the proposal just replaced.
      await userEvent.click(regenerateButton())
      await userEvent.click(within(noteDialog()).getByRole('button', { name: 'Regenerate' }))
      await waitFor(() => expect(suggestionNames()).toEqual(['mara']))
      expect(settlements(calls).at(-1)).toEqual({ id: 'prop-2', status: 'regenerated', note: null })
      expect(recommendInputs(calls).at(-1)).toEqual({
        nodeId: 'sc-1',
        note: null,
        regeneratedFrom: 'prop-2'
      })
    })

    it('cancelling the note keeps the chips and sends nothing', async () => {
      const calls = install({ 'ai:recommendTags': () => suggested('t-mara', 't-moody') })
      await useTagStore.getState().load()
      render(
        <>
          <TagBar id="sc-1" />
          <DialogHost />
        </>
      )
      await waitFor(() => expect(useDocumentTagStore.getState().tagIdsByNode['sc-1']).toBeDefined())
      loadText('sc-1', 80)
      await userEvent.click(recommendButton())
      await waitFor(() => expect(suggestionNames()).toEqual(['mara', 'moody']))
      await userEvent.click(regenerateButton())
      await userEvent.type(
        within(noteDialog()).getByRole('textbox', { name: "What's off about these?" }),
        'never mind'
      )
      await userEvent.click(within(noteDialog()).getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(suggestionNames()).toEqual(['mara', 'moody'])
      expect(settlements(calls)).toEqual([])
      expect(recommendInputs(calls)).toEqual([{ nodeId: 'sc-1' }])
      await userEvent.click(regenerateButton())
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(settlements(calls)).toEqual([])
      expect(recommendInputs(calls)).toHaveLength(1)
    })
  })
})
