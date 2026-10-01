import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORLD_CATEGORY_SUGGESTIONS } from '@shared/entities'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { openMention } from '@renderer/features/editor/openPassage'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import {
  resetReferenceStore,
  useReferenceStore
} from '@renderer/features/references/referenceStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { resetDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { resetMentionStore } from '@renderer/features/tags/mentionStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EntityEditor } from './EntityEditor'
import { resetEntityDraftStore, useEntityDraftStore } from './entityDraftStore'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'

// The jump itself is `openPassage`'s business (F-4.12) and needs a mounted editor; here only the
// call matters.
vi.mock('@renderer/features/editor/openPassage', () => ({
  openMention: vi.fn(() => Promise.resolve())
}))

type Handler = (input: unknown) => unknown

/** Answers the mutations the page uses the way main does; records every call. */
function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'entity:list') return entityFixture as Output<C>
      // The layout store writes after its own debounce when the Tag Manager is opened (F-9.4).
      if (channel === 'layout:set') return input as Output<C>
      if (channel === 'entity:update') {
        const patch = input as Input<'entity:update'>
        const stored = useEntityStore.getState().byId[patch.id]
        if (!stored) throw new Error('unknown entity')
        const merged: Entity = {
          ...stored,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.template === undefined ? {} : { template: patch.template }),
          ...(patch.body === undefined ? {} : { body: patch.body }),
          fields: { ...stored.fields, ...patch.fields }
        }
        return merged as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const failing = (message: string) => (): never => {
  throw new IpcRequestError({ code: 'INTERNAL', message })
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const page = (): HTMLElement => screen.getByTestId('entity-editor')
const field = (label: string): HTMLElement => screen.getByRole('textbox', { name: label })

/** Loads the bank, selects `id`, and renders its page. */
async function openPage(
  id: string,
  overrides: Partial<Record<Channel, Handler>> = {}
): Promise<[Channel, unknown][]> {
  const calls = install(overrides)
  await act(async () => {
    await useEntityStore.getState().load()
  })
  useEntityStore.getState().select(id)
  render(<EntityEditor id={id} />)
  return calls
}

/** Writes what the draft holds, without waiting for its debounce. */
async function flushDraft(): Promise<void> {
  await act(async () => {
    await useEntityDraftStore.getState().flush()
  })
}

/** `e-mara` as F-9.4 stores her: linked to the bank's `mara` tag. */
const linkedFixture: Entity[] = entityFixture.map((entity) =>
  entity.id === 'e-mara' ? { ...entity, tagId: 't-mara' } : entity
)

/** The Scenes rows of the open page, as "<title> <folder> [Tagged] [×n]". */
const sceneRows = (): string[] =>
  within(screen.getByRole('list', { name: /^Scenes with / }))
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')

describe('EntityEditor (F-9.3)', () => {
  beforeEach(() => {
    resetPendingSaves()
    resetEntityDraftStore()
    resetEntityStore()
    resetReferenceStore()
    resetTagStore()
    resetDocumentTagStore()
    resetMentionStore()
    resetLayoutStore()
    useTreeStore.getState().clear()
    vi.mocked(openMention).mockClear()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(() => {
    cleanup()
    resetEntityDraftStore()
    resetPendingSaves()
    resetTagStore()
    resetDocumentTagStore()
    resetMentionStore()
    // The layout store's write is debounced; leaving it pending leaks into the next file.
    resetLayoutStore()
  })

  it('pins the entity to References and unpins it again, opening the panel (F-9.6)', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara', { 'reference:set': (input) => input })
    const pin = screen.getByRole('button', { name: 'Pin to References' })
    expect(pin).toHaveAttribute('aria-pressed', 'false')
    await user.click(pin)
    expect(calls.at(-1)).toEqual(['reference:set', { pins: [{ type: 'entity', id: 'e-mara' }] }])
    expect(useReferenceStore.getState().pins).toEqual([{ type: 'entity', id: 'e-mara' }])
    expect(useLayoutStore.getState().layout.references.open).toBe(true)
    const unpin = screen.getByRole('button', { name: 'Unpin from References' })
    expect(unpin).toHaveAttribute('aria-pressed', 'true')
    await user.click(unpin)
    expect(calls.at(-1)).toEqual(['reference:set', { pins: [] }])
    expect(screen.getByRole('button', { name: 'Pin to References' })).toBeInTheDocument()
    // Unpinning leaves the panel as it is.
    expect(useLayoutStore.getState().layout.references.open).toBe(true)
  })

  it('shows the name, what the entity is, and the kind´s fields with their stored values', async () => {
    await openPage('e-mara')
    expect(screen.getByRole('article', { name: 'Mara' })).toBe(page())
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Mara')
    expect(page()).toHaveTextContent('Character · Structured')
    expect(field('Age')).toHaveValue('27')
    expect(field('Appearance')).toHaveValue('Tall, with a scar across her left palm.')
    expect(field('Goals / motivations')).toHaveValue('')
    expect(screen.queryByRole('textbox', { name: 'Page' })).toBeNull()
    expect(useEntityDraftStore.getState().draft?.id).toBe('e-mara')
  })

  it('an edited field is written with only what changed, and the status line says so', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    await user.type(field('Age'), '!')
    expect(useEntityDraftStore.getState().draft?.fields.age).toBe('27!')
    await flushDraft()
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-mara', fields: { age: '27!' } }])
    expect(within(page()).getByRole('status')).toHaveTextContent('Saved')
  })

  it('a rename follows into the page´s own label and the store', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    const name = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'Mara Vell')
    await flushDraft()
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-mara', name: 'Mara Vell' }])
    expect(screen.getByRole('article', { name: 'Mara Vell' })).toBeInTheDocument()
  })

  it('Close leaves the page, and the entity keeps its edits', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    await user.type(field('Age'), '!')
    await user.click(screen.getByRole('button', { name: 'Close Mara' }))
    expect(useEntityStore.getState().selectedId).toBeNull()
    cleanup() // the pane drops the page, which writes what was pending
    await act(async () => {
      await Promise.resolve()
    })
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-mara', fields: { age: '27!' } }])
  })

  it('the template toggle writes the pending edits first, then switches the page', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    const toggle = within(page()).getByRole('group', { name: 'Template' })
    expect(within(toggle).getByRole('button', { name: 'Structured' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await user.type(field('Age'), '!')
    await user.click(within(toggle).getByRole('button', { name: 'Blank page' }))
    expect(calls.map(([, input]) => input).slice(-2)).toEqual([
      { id: 'e-mara', fields: { age: '27!' } },
      { id: 'e-mara', template: 'blank' }
    ])
    expect(screen.getByRole('textbox', { name: 'Page' })).toHaveValue('')
    expect(page()).toHaveTextContent('Character · Blank page')
  })

  it('a blank-page entity writes its page, not fields', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-aldous')
    const body = screen.getByRole('textbox', { name: 'Page' })
    expect(body).toHaveValue('The old cartographer who taught Mara to read the stars.')
    await user.clear(body)
    await user.type(body, 'A mapmaker.')
    await flushDraft()
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-aldous', body: 'A mapmaker.' }])
    expect(screen.queryByRole('textbox', { name: 'Age' })).toBeNull()
  })

  it('a world item offers the category suggestions and has no image block', async () => {
    await openPage('e-blood')
    // An input with a `list` is a combobox, not a plain text box.
    const category = screen.getByRole('combobox', { name: 'Category' })
    const listId = category.getAttribute('list')
    expect(listId).not.toBeNull()
    const datalist = page().querySelector(`datalist#${CSS.escape(listId ?? '')}`)
    expect([...(datalist?.querySelectorAll('option') ?? [])].map((o) => o.value)).toEqual([
      ...WORLD_CATEGORY_SUGGESTIONS
    ])
    expect(screen.queryByRole('button', { name: 'Add image…' })).toBeNull()
  })

  it('Add image… asks main for a file; a cancelled dialog changes nothing', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara', { 'entity:setImage': () => null })
    await user.click(screen.getByRole('button', { name: 'Add image…' }))
    expect(calls.at(-1)).toEqual(['entity:setImage', { id: 'e-mara' }])
    expect(screen.getByRole('button', { name: 'Add image…' })).toBeInTheDocument()
    expect(page().querySelector('img')).toBeNull()
  })

  it('a chosen image is shown from the project´s assets and can be replaced or removed', async () => {
    const user = userEvent.setup()
    const mara = entityFixture[1]!
    const calls = await openPage('e-mara', {
      'entity:setImage': () => ({ ...mara, image: 'mara.0a1b2c3d.png' }),
      'entity:removeImage': () => ({ ...mara, image: null })
    })
    await user.click(screen.getByRole('button', { name: 'Add image…' }))
    const image = page().querySelector('img')
    expect(image).toHaveAttribute('src', 'mythscribe-asset://entities/mara.0a1b2c3d.png')
    expect(image).toHaveAttribute('alt', '')
    expect(screen.getByRole('button', { name: 'Replace image…' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove image' }))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
    expect(modal.options).toMatchObject({ confirmLabel: 'Remove', danger: true })
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal.id, false)
    })
    expect(calls.some(([channel]) => channel === 'entity:removeImage')).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Remove image' }))
    const second = useDialogStore.getState().modals[0]
    if (!second) throw new Error('expected a confirm')
    await act(async () => {
      useDialogStore.getState().resolveConfirm(second.id, true)
    })
    expect(calls.at(-1)).toEqual(['entity:removeImage', { id: 'e-mara' }])
    expect(page().querySelector('img')).toBeNull()
  })

  it('a failed image request toasts its cause', async () => {
    const user = userEvent.setup()
    await openPage('e-mara', { 'entity:setImage': failing('That file is not an image') })
    await user.click(screen.getByRole('button', { name: 'Add image…' }))
    expect(toasts()).toEqual(['That file is not an image'])
  })

  it('shows the entity´s tag as a chip and opens it in the Tag Manager (F-9.4)', async () => {
    const user = userEvent.setup()
    useTagStore.getState().merge(tagFixture[1]!)
    await openPage('e-mara', {
      'entity:list': () => linkedFixture,
      'documentTag:listAll': () => [],
      'mention:listForTag': () => []
    })
    const block = within(page()).getByRole('group', { name: 'Tag' })
    expect(block).toHaveTextContent('#mara')
    expect(block.querySelector('span[aria-hidden]')).toHaveStyle({ backgroundColor: '#dc2626' })
    expect(within(page()).queryByRole('button', { name: 'Create tag' })).toBeNull()

    await user.click(within(block).getByRole('button', { name: 'Open in Tag Manager' }))
    expect(useLayoutStore.getState().layout.sidebar.open).toBe(true)
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('tags')
    expect(useTagStore.getState().pendingSelection?.id).toBe('t-mara')
  })

  it('Create tag links one for an entity that has none, and the chip follows (F-9.4)', async () => {
    const user = userEvent.setup()
    const mara = entityFixture[1]!
    const calls = await openPage('e-mara', {
      'entity:linkTag': () => ({
        entity: { ...mara, tagId: 't-mara' },
        tag: tagFixture[1]!
      }),
      'documentTag:listAll': () => [],
      'mention:listForTag': () => []
    })
    const block = within(page()).getByRole('group', { name: 'Tag' })
    expect(block).toHaveTextContent('No tag yet.')

    await user.click(within(block).getByRole('button', { name: 'Create tag' }))
    expect(calls).toContainEqual(['entity:linkTag', { id: 'e-mara' }])
    expect(useEntityStore.getState().byId['e-mara']?.tagId).toBe('t-mara')
    expect(useTagStore.getState().byId['t-mara']).toEqual(tagFixture[1])
    expect(within(page()).getByRole('group', { name: 'Tag' })).toHaveTextContent('#mara')
  })

  it('a refused Create tag toasts its cause (F-9.4)', async () => {
    const user = userEvent.setup()
    await openPage('e-mara', {
      'entity:linkTag': failing('"???" has no letters or digits to make a tag from')
    })
    await user.click(screen.getByRole('button', { name: 'Create tag' }))
    expect(toasts()).toEqual(['"???" has no letters or digits to make a tag from'])
  })

  it('lists the scenes the tag reaches in tree order and jumps into them (F-9.4)', async () => {
    const user = userEvent.setup()
    useTagStore.getState().merge(tagFixture[1]!)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    const calls = await openPage('e-mara', {
      'entity:list': () => linkedFixture,
      'documentTag:listAll': () => [{ nodeId: 'sc-4', tagId: 't-mara' }],
      'mention:listForTag': () => [
        { tagId: 't-mara', nodeId: 'sc-1', count: 2, ranges: [[4, 8]] },
        { tagId: 't-mara', nodeId: 'sc-4', count: 1, ranges: [[9, 13]] }
      ]
    })
    // Both lists are asked for when the page opens.
    expect(calls.map(([channel]) => channel)).toContain('documentTag:listAll')
    expect(calls.at(-1)).toEqual(['mention:listForTag', { tagId: 't-mara' }])

    expect(await screen.findByText('In 2 scenes')).toBeInTheDocument()
    expect(sceneRows()).toEqual(['Scene 1Chapter 1×2', 'Scene 4Chapter 4Tagged×1'])

    // A mentioned row jumps to the first occurrence…
    await user.click(screen.getByRole('button', { name: /^Scene 1/ }))
    expect(vi.mocked(openMention).mock.calls.at(-1)).toEqual(['sc-1', [4, 8], 'mara'])
  })

  it('selects the document for a row that is only tagged, and says so without a tag (F-9.4)', async () => {
    const user = userEvent.setup()
    useTagStore.getState().merge(tagFixture[1]!)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    await openPage('e-mara', {
      'entity:list': () => linkedFixture,
      'documentTag:listAll': () => [{ nodeId: 'sc-2', tagId: 't-mara' }],
      'mention:listForTag': () => []
    })
    expect(await screen.findByText('In 1 scene')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Scene 2/ }))
    expect(vi.mocked(openMention)).not.toHaveBeenCalled()
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
    // F-9.3: opening a document closes the entity page.
    expect(useEntityStore.getState().selectedId).toBeNull()
  })

  it('offers the tag first for an entity that has none (F-9.4)', async () => {
    await openPage('e-forest')
    expect(page()).toHaveTextContent('Create the tag to see where Dark Forest appears.')
    expect(screen.queryByRole('list', { name: /^Scenes with / })).toBeNull()
  })

  it('an entity deleted while its page is open leaves the page', async () => {
    install()
    await act(async () => {
      await useEntityStore.getState().load()
    })
    useEntityStore.getState().select('e-mara')
    const { container } = render(<EntityEditor id="e-gone" />)
    expect(container).toBeEmptyDOMElement()
    expect(useEntityStore.getState().selectedId).toBeNull()
  })
})
