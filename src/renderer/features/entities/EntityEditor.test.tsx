import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORLD_CATEGORY_SUGGESTIONS } from '@shared/entities'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { EMPTY_SCENE_META } from '@shared/sceneMeta'
import { resetActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
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
import { resetTimelineStore, useTimelineStore } from '@renderer/features/timeline/timelineStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EntityEditor } from './EntityEditor'
import { resetEntityDraftStore, useEntityDraftStore } from './entityDraftStore'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'
import { factFixture } from './factFixture'
import { resetFactStore } from './factStore'
import { resetSheetSyncStore } from './sheetSyncStore'
import { defaultAiSettings } from '@shared/aiSettings'
import { NO_SHEET_SYNC } from '@shared/sheetSync'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'

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
      // F-9.13: the page asks for the record's dated facts; none unless a test supplies them.
      if (channel === 'fact:listForEntity') return [] as Output<C>
      // The layout store writes after its own debounce when the Tag Manager is opened (F-9.4).
      if (channel === 'layout:set') return input as Output<C>
      // F-11.2c: the usage log holds every manuscript document's scene metadata; all empty here.
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        return { id, meta: { ...EMPTY_SCENE_META } } as Output<C>
      }
      if (channel === 'entity:update') {
        const patch = input as Input<'entity:update'>
        const stored = useEntityStore.getState().byId[patch.id]
        if (!stored) throw new Error('unknown entity')
        const merged: Entity = {
          ...stored,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.template === undefined ? {} : { template: patch.template }),
          ...(patch.body === undefined ? {} : { body: patch.body }),
          ...(patch.aliases === undefined ? {} : { aliases: patch.aliases }),
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
/** A character's or setting's scene list: the appearance log (F-11.2c), which replaced F-9.4's Scenes. */
const scenesList = (): HTMLElement => screen.getByRole('list', { name: 'Appearances' })
const sceneRows = (): string[] =>
  within(scenesList())
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')

describe('EntityEditor (F-9.3)', () => {
  beforeEach(() => {
    resetPendingSaves()
    resetSceneMetaStore()
    resetEntityDraftStore()
    resetEntityStore()
    resetFactStore()
    resetReferenceStore()
    resetTagStore()
    resetDocumentTagStore()
    resetMentionStore()
    resetLayoutStore()
    resetTimelineStore()
    useTreeStore.getState().clear()
    resetActiveEditorStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(() => {
    cleanup()
    // Gives up the wait the F-9.4 jump leaves open (no editor is mounted here).
    resetActiveEditorStore()
    resetEntityDraftStore()
    resetSceneMetaStore()
    resetPendingSaves()
    resetTagStore()
    resetDocumentTagStore()
    resetMentionStore()
    // The layout store's write is debounced; leaving it pending leaks into the next file.
    resetLayoutStore()
    resetTimelineStore()
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

  it('edits the sheet´s aliases, which main writes on its tag when it has one (F-4.14)', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    const aliases = screen.getByRole('group', { name: 'Aliases' })
    await user.type(
      within(aliases).getByRole('textbox', { name: 'Add alias' }),
      'The Navigator{Enter}'
    )
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-mara', aliases: ['The Navigator'] }])
    expect(await within(aliases).findByText('The Navigator')).toBeInTheDocument()
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
    expect(calls).toContainEqual(['mention:listForTag', { tagId: 't-mara' }])

    expect(await screen.findByText('In 2 scenes')).toBeInTheDocument()
    expect(sceneRows()).toEqual(['Scene 1Chapter 1×2', 'Scene 4Chapter 4Tagged×1'])

    // A mentioned row jumps to the first occurrence: `openMention` (F-4.12) selects the scene at
    // once and waits for its editor, which nothing mounts here. The real module on purpose: a
    // `vi.mock` does not reach an `EntityEditor` another file in this worker already imported.
    await user.click(within(scenesList()).getByRole('button', { name: /^Scene 1/ }))
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
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
    await user.click(within(scenesList()).getByRole('button', { name: /^Scene 2/ }))
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
    // F-9.3: opening a document closes the entity page.
    expect(useEntityStore.getState().selectedId).toBeNull()
  })

  it('offers the tag first for a world item that has none (F-9.4)', async () => {
    await openPage('e-blood')
    expect(page()).toHaveTextContent('Create the tag to see where Blood magic appears.')
    expect(screen.queryByRole('list', { name: /^Scenes with / })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Appearances' })).toBeNull()
  })

  it('a world item lists its scenes; a setting has the appearance log instead (F-9.4, F-11.2c)', async () => {
    useTagStore.getState().merge(tagFixture[1]!)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    await openPage('e-blood', {
      'entity:list': () =>
        entityFixture.map((entity) =>
          entity.id === 'e-blood' || entity.id === 'e-forest'
            ? { ...entity, tagId: 't-mara' }
            : entity
        ),
      'documentTag:listAll': () => [{ nodeId: 'sc-2', tagId: 't-mara' }],
      'mention:listForTag': () => []
    })
    expect(await screen.findByRole('list', { name: 'Scenes with Blood magic' })).toHaveTextContent(
      'Scene 2Chapter 2Tagged'
    )
    cleanup()
    render(<EntityEditor id="e-forest" />)
    expect(screen.queryByRole('list', { name: /^Scenes with / })).toBeNull()
    expect(await screen.findByRole('list', { name: 'Appearances' })).toHaveTextContent(
      'Scene 2Chapter 2Tagged'
    )
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

  it('shows Mara´s age at every timeline event with a year, from the Born field as typed (F-11.2b)', async () => {
    const user = userEvent.setup()
    useTimelineStore.setState({
      loaded: true,
      events: [
        { id: 'a', label: 'The flood', when: 'Spring', year: 1160, note: '' },
        { id: 'b', label: 'Undated', when: '', year: null, note: '' },
        { id: 'c', label: 'The siege begins', when: '', year: 1200, note: '' }
      ]
    })
    await openPage('e-mara')
    // Blank Born: nothing to show.
    expect(screen.queryByRole('region', { name: 'Age on the timeline' })).toBeNull()
    await user.type(field('Born (story year)'), 'Year 1170')
    expect(screen.getByText(/Use a whole number to track age/)).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Age on the timeline' })).toBeNull()
    await user.clear(field('Born (story year)'))
    await user.type(field('Born (story year)'), '1170')
    const section = screen.getByRole('region', { name: 'Age on the timeline' })
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['The floodSpringYear 1160not born yet', 'The siege beginsYear 1200age 30'])
  })

  it('says when no timeline event has a year, and shows no ages for a setting (F-11.2b)', async () => {
    useTimelineStore.setState({
      loaded: true,
      events: [{ id: 'b', label: 'Undated', when: '', year: null, note: '' }]
    })
    await openPage('e-mara', {
      'entity:list': () =>
        entityFixture.map((entity) =>
          entity.id === 'e-mara'
            ? { ...entity, fields: { ...entity.fields, born: '1170' } }
            : entity
        )
    })
    const section = screen.getByRole('region', { name: 'Age on the timeline' })
    expect(section).toHaveTextContent('No timeline event has a year yet.')
    cleanup()
    render(<EntityEditor id="e-forest" />)
    expect(screen.queryByRole('region', { name: 'Age on the timeline' })).toBeNull()
  })

  describe('dated facts on the sheet (F-9.13)', () => {
    const maraFacts = factFixture.filter((fact) => fact.entityId === 'e-mara')
    const ageFacts = (): HTMLElement => screen.getByRole('list', { name: 'Age from the scenes' })

    async function openMara(): Promise<[Channel, unknown][]> {
      useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
      const calls = await openPage('e-mara', {
        'fact:listForEntity': () => maraFacts,
        'fact:setHidden': (input) => ({
          ...maraFacts.find((fact) => fact.id === (input as Input<'fact:setHidden'>).id),
          hidden: true
        })
      })
      await screen.findByRole('list', { name: 'Age from the scenes' })
      return calls
    }

    it('shows the newest value as of now under a replace field, marked as the AI’s, beside the author’s text', async () => {
      await openMara()
      // Now is the latest written scene (Scene 6): Scene 4's age is the newest stated (D1).
      expect(field('Age')).toHaveValue('27')
      const age = within(ageFacts()).getByRole('listitem', { name: 'Age: 29' })
      expect(within(age).getByTestId('fact-ai-mark')).toHaveTextContent('AI')
      expect(age).toHaveTextContent('From Scene 4')
      expect(within(age).getByRole('button', { name: 'Go to passage in Scene 4' })).toBeVisible()
      // Accumulate fields list what was stated so far; the hidden background waits under Show hidden.
      expect(
        within(screen.getByRole('list', { name: 'Appearance from the scenes' })).getByRole(
          'listitem',
          { name: 'Appearance: Grey eyes' }
        )
      ).toBeVisible()
      expect(screen.getByRole('button', { name: 'Show hidden (1)' })).toBeVisible()
    })

    it('reads the sheet as of another scene, and shows later values in the history', async () => {
      await openMara()
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'As of' }), 'Scene 2')
      const age = within(ageFacts()).getByRole('listitem', { name: 'Age: 34' })
      expect(within(age).getAllByRole('button', { name: /^Go to passage in / })).toHaveLength(2)
      await userEvent.click(screen.getByRole('button', { name: 'Age history (2)' }))
      const history = screen.getByRole('list', { name: 'Age history' })
      expect(within(history).getByRole('listitem', { name: 'Age: 29' })).toHaveTextContent(
        '(later)'
      )
    })

    it('hides a wrong value, re-statuses one, and sets the sheet’s status', async () => {
      const calls = await openMara()
      const age = within(ageFacts()).getByRole('listitem', { name: 'Age: 29' })
      await userEvent.selectOptions(
        within(age).getByRole('combobox', { name: 'Status of Age: 29' }),
        'Plan'
      )
      expect(calls).toContainEqual(['fact:setStatus', { id: 'f-3', status: 'plan' }])
      await userEvent.click(within(age).getByRole('button', { name: 'Hide' }))
      expect(calls).toContainEqual(['fact:setHidden', { id: 'f-3', hidden: true }])
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Idea')
      expect(calls).toContainEqual(['entity:update', { id: 'e-mara', status: 'idea' }])
    })

    it('dates an author line at a scene from the field history (D4)', async () => {
      const calls = await openMara()
      await userEvent.click(screen.getByRole('button', { name: 'Age history (2)' }))
      const group = screen.getByRole('group', { name: 'Age from a scene' })
      await userEvent.selectOptions(
        within(group).getByRole('combobox', { name: 'Scene' }),
        'Scene 2'
      )
      await userEvent.type(
        within(group).getByRole('textbox', { name: 'Age from that scene on' }),
        '35'
      )
      await userEvent.click(within(group).getByRole('button', { name: 'Add' }))
      expect(calls).toContainEqual([
        'entity:update',
        { id: 'e-mara', fields: { age: '35' }, asOf: 'sc-2' }
      ])
    })
  })
})

describe('EntityEditor: the sheet’s own fields and its two views (F-9.18)', () => {
  beforeEach(() => {
    resetPendingSaves()
    resetEntityDraftStore()
    resetEntityStore()
    resetFactStore()
    resetTagStore()
    resetTimelineStore()
    resetAiSettingsStore()
    resetSheetSyncStore()
    useTreeStore.getState().clear()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(() => {
    cleanup()
    resetActiveEditorStore()
    resetEntityDraftStore()
    resetPendingSaves()
    resetTagStore()
    resetLayoutStore()
    resetTimelineStore()
    resetAiSettingsStore()
    resetSheetSyncStore()
  })

  const withOwnField: Entity[] = entityFixture.map((entity) =>
    entity.id === 'e-mara'
      ? {
          ...entity,
          extraFields: [{ id: 'weapon', label: 'Weapon', multiline: true }],
          fields: { ...entity.fields, weapon: 'A bone bow.' }
        }
      : entity
  )

  it('shows the sheet’s own fields after the template, and removes one into Notes', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara', {
      'entity:list': () => withOwnField,
      'entity:removeField': () => ({
        ...withOwnField.find((entity) => entity.id === 'e-mara'),
        extraFields: [],
        fields: { notes: 'Weapon: A bone bow.' }
      })
    })
    expect(field('Weapon')).toHaveValue('A bone bow.')
    expect(page()).toHaveTextContent('this sheet only')
    await user.click(screen.getByRole('button', { name: 'Remove the field Weapon' }))
    expect(
      calls.some(
        ([channel, input]) =>
          channel === 'entity:removeField' &&
          JSON.stringify(input) === '{"id":"e-mara","fieldId":"weapon"}'
      )
    ).toBe(true)
    expect(useEntityStore.getState().byId['e-mara']?.extraFields).toEqual([])
  })

  it('adds a field to this sheet only', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara', {
      'entity:addField': (input) => {
        const { label } = input as Input<'entity:addField'>
        const mara = entityFixture.find((entity) => entity.id === 'e-mara')
        return { ...mara, extraFields: [{ id: 'weapon', label, multiline: true }] }
      }
    })
    await user.click(screen.getByRole('button', { name: 'Add a field to this sheet…' }))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'prompt') throw new Error('expected a prompt')
    expect(modal.options.title).toBe('Add a field to this sheet')
    await act(async () => {
      useDialogStore.getState().resolvePrompt(modal.id, ' Weapon ')
      await Promise.resolve()
    })
    expect(calls.some(([channel]) => channel === 'entity:addField')).toBe(true)
    expect(await screen.findByRole('textbox', { name: 'Weapon' })).toHaveValue('')
  })

  it('takes a row the sync wrote in main, unless the author has an edit still to save', async () => {
    await openPage('e-mara')
    const mara = useEntityStore.getState().byId['e-mara']
    if (mara === undefined) throw new Error('no Mara')
    act(() => useEntityStore.getState().merge({ ...mara, body: 'Written up.' }))
    expect(useEntityDraftStore.getState().draft?.body).toBe('Written up.')
    act(() => useEntityDraftStore.getState().edit({ body: 'My own words.' }))
    act(() => useEntityStore.getState().merge({ ...mara, body: 'Written up again.' }))
    expect(useEntityDraftStore.getState().draft?.body).toBe('My own words.')
  })

  it('says the page is out of date and how to fix it when AI is off', async () => {
    const stale: Entity[] = entityFixture.map((entity) =>
      entity.id === 'e-mara'
        ? { ...entity, template: 'blank', sync: { ...NO_SHEET_SYNC, state: 'pageStale' } }
        : entity
    )
    await openPage('e-mara', { 'entity:list': () => stale })
    expect(screen.getByTestId('sheet-sync-stale')).toHaveTextContent(
      'This page does not have your latest field edits yet.'
    )
    expect(screen.getByTestId('sheet-sync-stale')).toHaveTextContent('Turn on Use AI')
    expect(screen.queryByRole('button', { name: 'Write up now' })).toBeNull()
  })

  it('writes up now on request, and marks what the AI wrote once the sync lands', async () => {
    const user = userEvent.setup()
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
    const stale: Entity[] = entityFixture.map((entity) =>
      entity.id === 'e-mara'
        ? { ...entity, template: 'blank', sync: { ...NO_SHEET_SYNC, state: 'pageStale' } }
        : entity
    )
    const calls = await openPage('e-mara', {
      'entity:list': () => stale,
      'sheetSync:run': () => true
    })
    await user.click(screen.getByRole('button', { name: 'Write up now' }))
    expect(calls.some(([channel]) => channel === 'sheetSync:run')).toBe(true)
    const mara = stale.find((entity) => entity.id === 'e-mara')
    if (mara === undefined) throw new Error('no Mara')
    // The sync lands in main and reaches the page as entity:changed.
    act(() =>
      useEntityStore.getState().merge({
        ...mara,
        body: 'Mara is 27.',
        sync: { ...NO_SHEET_SYNC, state: 'synced', aiParagraphs: 1, paragraphs: 1 }
      })
    )
    expect(field('Page')).toHaveValue('Mara is 27.')
    expect(screen.getByTestId('sheet-provenance')).toHaveTextContent(
      'Written up by AI from your fields.'
    )
    expect(screen.queryByTestId('sheet-sync-stale')).toBeNull()
  })
})
