import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { LAYOUT_LIMITS, defaultLayout } from '@shared/layout'
import type { TagMentions } from '@shared/mentions'
import type { Fact } from '@shared/facts'
import type { ReferencePin, ReferencePins } from '@shared/references'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetNotesStore, useNotesStore } from '@renderer/features/editor/notesStore'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { factFixture } from '@renderer/features/entities/factFixture'
import { resetFactStore } from '@renderer/features/entities/factStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { resetDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { resetMentionStore, useMentionStore } from '@renderer/features/tags/mentionStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { DockColumn } from '@renderer/features/shell/Dock'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ReferencePanel, ReferencesToggleButton } from './ReferencePanel'
import { resetReferenceStore, useReferenceStore } from './referenceStore'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const MARA: ReferencePin = { type: 'entity', id: 'e-mara' }
const FOREST: ReferencePin = { type: 'entity', id: 'e-forest' }
const ALDOUS: ReferencePin = { type: 'entity', id: 'e-aldous' }
const SCENE_NOTES: ReferencePin = { type: 'note', id: 'sc-1' }
const MAP: ReferencePin = { type: 'image', file: 'Harbor-Map.0a1b2c3d.png' }

const LONG = 'A long history. '.repeat(20).trim()

let pins: ReferencePin[]
let entities: Entity[]
let notes: Record<string, TiptapNodeT>
let facts: Fact[]
let mentions: TagMentions[]
let linkedTags: Record<string, Output<'documentTag:list'>>
let sets: ReferencePins[]
let calls: Channel[]
let addAnswer: Output<'reference:addImages'>

function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push(channel)
      if (channel === 'reference:get') return { pins } as Output<C>
      if (channel === 'reference:set') {
        sets.push(input as ReferencePins)
        return input as Output<C>
      }
      if (channel === 'reference:addImages') return addAnswer as Output<C>
      if (channel === 'entity:list') return entities as Output<C>
      if (channel === 'fact:listForEntity') {
        const { entityId } = input as Input<'fact:listForEntity'>
        return facts.filter((fact) => fact.entityId === entityId) as Output<C>
      }
      if (channel === 'tree:list') return treeFixture as Output<C>
      if (channel === 'mention:listForNode') {
        const { nodeId } = input as Input<'mention:listForNode'>
        return mentions.filter((mention) => mention.nodeId === nodeId) as Output<C>
      }
      if (channel === 'documentTag:list') {
        const { nodeId } = input as Input<'documentTag:list'>
        return (linkedTags[nodeId] ?? []) as Output<C>
      }
      if (channel === 'layout:set') return input as Output<C>
      if (channel === 'notes:get') {
        const { id } = input as Input<'notes:get'>
        return { id, notes: notes[id] ?? null } as Output<C>
      }
      if (channel === 'notes:save') return { modified: 'm' } as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
}

/** Loads the stores the cards read, opens the panel, and renders it with the dialog host. */
async function openPanel(): Promise<void> {
  await act(async () => {
    await useEntityStore.getState().load()
    await useTreeStore.getState().load()
    await useReferenceStore.getState().load()
    useLayoutStore.getState().toggle('references')
  })
  render(
    <>
      <DockColumn column={['references']} side="left" render={() => <ReferencePanel />} />
      <DialogHost />
    </>
  )
}

const cards = (): HTMLElement[] =>
  within(screen.getByRole('list', { name: 'Pinned references' })).getAllByRole('listitem')
const titles = (): (string | null)[] => cards().map((card) => card.getAttribute('aria-label'))
const card = (title: string): HTMLElement => {
  const found = cards().find((item) => item.getAttribute('aria-label') === title)
  if (!found) throw new Error(`no card ${title}`)
  return found
}
const stored = (): readonly ReferencePin[] => useReferenceStore.getState().pins

function reset(): void {
  resetReferenceStore()
  resetEntityStore()
  resetFactStore()
  resetMentionStore()
  resetDocumentTagStore()
  resetNotesStore()
  resetLayoutStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1000)
  reset()
  pins = [MARA, SCENE_NOTES, MAP]
  entities = entityFixture
  notes = { 'sc-1': doc('She never takes the coast road.') }
  facts = []
  mentions = []
  linkedTags = {}
  sets = []
  calls = []
  addAnswer = null
  setIpcClient(client())
})
afterEach(() => {
  // The layout store and the notes store both hold debounced writes.
  reset()
  vi.unstubAllGlobals()
})

describe('ReferencesToggleButton and the panel shell (F-9.6)', () => {
  it('starts closed; the button toggles it and reports aria-pressed', async () => {
    pins = []
    render(
      <>
        <ReferencesToggleButton />
        <DockColumn column={['references']} side="left" render={() => <ReferencePanel />} />
      </>
    )
    const button = screen.getByRole('button', { name: 'References' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('references-panel')).not.toBeInTheDocument()
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('references-panel')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'References' })).toBeInTheDocument()
    expect(
      screen.getByText('Nothing pinned yet. Pin a character, a setting, notes, or an image.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    await userEvent.click(button)
    expect(screen.queryByTestId('references-panel')).not.toBeInTheDocument()
  })

  it('opens at the stored fraction and the handle resizes it within 15–35 % (F-7.2)', async () => {
    await openPanel()
    const size = (): number => useLayoutStore.getState().layout.references.size
    expect(size()).toBe(defaultLayout().references.size)
    expect(screen.getByTestId('dock-column').style.width).toBe('22vw')
    const handle = screen.getByRole('separator', { name: 'Resize references' })
    handle.focus()
    // The handle is on the panel's left edge: left grows it, right shrinks it, each to its limit.
    const [min, max] = LAYOUT_LIMITS.references
    await userEvent.keyboard('{ArrowLeft>40/}')
    expect(size()).toBe(max)
    await userEvent.keyboard('{ArrowRight>60/}')
    expect(size()).toBe(min)
  })

  it('Add image… asks main and shows the image it pinned', async () => {
    pins = [MARA]
    addAnswer = { pins: { pins: [MARA, MAP] }, skipped: [] }
    await openPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Add image…' }))
    await waitFor(() => expect(titles()).toEqual(['Mara', 'Harbor-Map.png']))
    expect(calls).toContain('reference:addImages')
  })
})

describe('the cards (F-9.6)', () => {
  it('shows one card per pin, in order, each with what its target holds', async () => {
    await openPanel()
    expect(titles()).toEqual(['Mara', 'Scene 1', 'Harbor-Map.png'])

    const mara = within(card('Mara'))
    expect(mara.getByText('Character')).toBeInTheDocument()
    expect(mara.getByText('Age')).toBeInTheDocument()
    expect(mara.getByText('27')).toBeInTheDocument()
    expect(mara.getByText('Tall, with a scar across her left palm.')).toBeInTheDocument()
    expect(mara.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()

    const scene = within(card('Scene 1'))
    expect(scene.getByText(/^Notes/)).toBeInTheDocument()
    expect(await scene.findByText('She never takes the coast road.')).toBeInTheDocument()

    const map = within(card('Harbor-Map.png'))
    expect(map.getByText('Image')).toBeInTheDocument()
    expect(map.getByRole('img', { name: 'Harbor-Map.png' })).toHaveAttribute(
      'src',
      'mythscribe-asset://references/Harbor-Map.0a1b2c3d.png'
    )
  })

  it('an entity card lists the first facts the scenes state as of now under From the scenes (F-9.13)', async () => {
    facts = factFixture
    pins = [MARA, FOREST]
    await openPanel()
    const section = await within(card('Mara')).findByRole('region', { name: 'From the scenes' })
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label'))
      // Now is the latest written scene: the age is the newest stated (D1), the hidden one is gone.
    ).toEqual(['Age: 29', 'Appearance: Grey eyes', 'Goals / motivations: Find the lost chart'])
    expect(section).not.toHaveTextContent('more')
    expect(within(section).queryByRole('button', { name: 'Hide' })).toBeNull()
    // The forest has no facts: its card carries no section.
    expect(within(card('Dark Forest')).queryByRole('region')).toBeNull()

    await userEvent.click(within(section).getByRole('button', { name: 'Go to passage in Scene 4' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-4')
  })

  it('shows the page of a blank-template entity and its thumbnail when it has an image', async () => {
    entities = entityFixture.map((e) =>
      e.id === 'e-aldous' ? { ...e, image: 'Aldous.0a1b2c3d.png' } : e
    )
    pins = [ALDOUS]
    await openPanel()
    const aldous = card('Aldous')
    expect(
      within(aldous).getByText('The old cartographer who taught Mara to read the stars.')
    ).toBeInTheDocument()
    expect(aldous.querySelector('img')).toHaveAttribute(
      'src',
      'mythscribe-asset://entities/Aldous.0a1b2c3d.png'
    )
  })

  it('says so when an entity has nothing written and when a node has no notes', async () => {
    entities = entityFixture.map((e) => (e.id === 'e-mara' ? { ...e, fields: {} } : e))
    pins = [MARA, { type: 'note', id: 'sc-2' }]
    await openPanel()
    expect(within(card('Mara')).getByText('Nothing written yet.')).toBeInTheDocument()
    expect(await within(card('Scene 2')).findByText('No notes yet.')).toBeInTheDocument()
  })

  it('clamps a long card until Show more, and back with Show less', async () => {
    entities = entityFixture.map((e) =>
      e.id === 'e-mara'
        ? {
            ...e,
            fields: { age: '27', gender: 'Woman', appearance: 'Tall', background: LONG }
          }
        : e
    )
    pins = [MARA]
    await openPanel()
    const mara = within(card('Mara'))
    // Three fields until expanded; the fourth is behind the toggle.
    expect(mara.queryByText(LONG)).not.toBeInTheDocument()
    const more = mara.getByRole('button', { name: 'Show more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(more)
    expect(mara.getByText(LONG)).toBeInTheDocument()
    expect(mara.getByText(LONG)).not.toHaveClass('line-clamp-2')
    await userEvent.click(mara.getByRole('button', { name: 'Show less' }))
    expect(mara.queryByText(LONG)).not.toBeInTheDocument()
  })

  it('Move up and Move down reorder the pins and write once each; the ends are disabled', async () => {
    await openPanel()
    expect(within(card('Mara')).getByRole('button', { name: 'Move up' })).toBeDisabled()
    expect(within(card('Harbor-Map.png')).getByRole('button', { name: 'Move down' })).toBeDisabled()
    await userEvent.click(within(card('Scene 1')).getByRole('button', { name: 'Move up' }))
    expect(titles()).toEqual(['Scene 1', 'Mara', 'Harbor-Map.png'])
    expect(sets).toEqual([{ pins: [SCENE_NOTES, MARA, MAP] }])
    await userEvent.click(within(card('Scene 1')).getByRole('button', { name: 'Move down' }))
    await userEvent.click(within(card('Scene 1')).getByRole('button', { name: 'Move down' }))
    expect(titles()).toEqual(['Mara', 'Harbor-Map.png', 'Scene 1'])
    expect(sets).toHaveLength(3)
    expect(sets[2]).toEqual({ pins: [MARA, MAP, SCENE_NOTES] })
  })

  it('reorders by drag and drop, and ignores a drop that did not start on a card', async () => {
    await openPanel()
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    // Something dragged in from elsewhere (a tree row) is not a pin.
    fireEvent.dragOver(card('Mara'), { dataTransfer })
    fireEvent.drop(card('Mara'), { dataTransfer })
    expect(sets).toHaveLength(0)

    fireEvent.dragStart(card('Harbor-Map.png'), { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'image:Harbor-Map.0a1b2c3d.png')
    fireEvent.dragOver(card('Mara'), { dataTransfer })
    expect(card('Mara')).toHaveAttribute('data-drop-target', 'true')
    fireEvent.drop(card('Mara'), { dataTransfer })
    await waitFor(() => expect(titles()).toEqual(['Harbor-Map.png', 'Mara', 'Scene 1']))
    expect(sets).toEqual([{ pins: [MAP, MARA, SCENE_NOTES] }])
    expect(card('Mara')).toHaveAttribute('data-drop-target', 'false')
  })

  it('unpins an entity and a note at once', async () => {
    await openPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Unpin Mara' }))
    expect(titles()).toEqual(['Scene 1', 'Harbor-Map.png'])
    await userEvent.click(screen.getByRole('button', { name: 'Unpin Scene 1' }))
    expect(titles()).toEqual(['Harbor-Map.png'])
    expect(sets).toEqual([{ pins: [SCENE_NOTES, MAP] }, { pins: [MAP] }])
  })

  it('asks before unpinning an image, because the file goes with it', async () => {
    await openPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Unpin Harbor-Map.png' }))
    const confirm = await screen.findByRole('dialog')
    expect(confirm).toHaveTextContent('This deletes the image file from the project folder.')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(titles()).toEqual(['Mara', 'Scene 1', 'Harbor-Map.png'])
    expect(sets).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Unpin Harbor-Map.png' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unpin' })
    )
    await waitFor(() => expect(titles()).toEqual(['Mara', 'Scene 1']))
    expect(sets).toEqual([{ pins: [MARA, SCENE_NOTES] }])
  })

  it('hides a pin whose target is gone, steps over it when moving, and drops a card deleted live', async () => {
    pins = [MARA, { type: 'entity', id: 'e-gone' }, { type: 'note', id: 'n-gone' }, FOREST]
    await openPanel()
    expect(titles()).toEqual(['Mara', 'Dark Forest'])
    await userEvent.click(within(card('Dark Forest')).getByRole('button', { name: 'Move up' }))
    expect(titles()).toEqual(['Dark Forest', 'Mara'])
    expect(stored()[0]).toEqual(FOREST)
    expect(stored()[1]).toEqual(MARA)

    // Deleted in its tab while pinned: the card goes at once, the pin on the next load.
    act(() => {
      const byId = { ...useEntityStore.getState().byId }
      delete byId['e-forest']
      useEntityStore.setState({ byId })
    })
    expect(titles()).toEqual(['Mara'])
  })

  it('Open on an entity card opens its page', async () => {
    await openPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Open Mara' }))
    expect(useEntityStore.getState().selectedId).toBe('e-mara')
  })

  it('Open on a notes card selects the node and opens the notes panel', async () => {
    await openPanel()
    act(() => useEntityStore.getState().select('e-mara'))
    await userEvent.click(screen.getByRole('button', { name: 'Open notes of Scene 1' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    expect(useEntityStore.getState().selectedId).toBeNull()
    expect(useLayoutStore.getState().layout.notes.open).toBe(true)
  })

  it('a notes card follows the notes editor while it has them loaded, and keeps the last text after', async () => {
    await openPanel()
    const scene = within(card('Scene 1'))
    expect(await scene.findByText('She never takes the coast road.')).toBeInTheDocument()
    await act(async () => {
      await useNotesStore.getState().load('sc-1')
    })
    act(() => useNotesStore.getState().edit('sc-1', doc('She took the coast road once.')))
    expect(scene.getByText('She took the coast road once.')).toBeInTheDocument()
    act(() => useNotesStore.getState().unload('sc-1'))
    expect(scene.getByText('She took the coast road once.')).toBeInTheDocument()
  })

  it('a click on a pinned image opens it large; Escape and Close leave', async () => {
    await openPanel()
    await userEvent.click(screen.getByRole('button', { name: 'View Harbor-Map.png larger' }))
    const viewer = screen.getByRole('dialog', { name: 'Harbor-Map.png' })
    expect(within(viewer).getByRole('img')).toHaveAttribute(
      'src',
      'mythscribe-asset://references/Harbor-Map.0a1b2c3d.png'
    )
    expect(within(viewer).getByRole('button', { name: 'Close image' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'View Harbor-Map.png larger' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close image' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('In this scene (F-9.7)', () => {
  const linked = (id: string, tagId: string): Entity => {
    const entity = entityFixture.find((item) => item.id === id)
    if (!entity) throw new Error(`no entity ${id}`)
    return { ...entity, tagId }
  }
  const sceneCards = (): (string | null)[] =>
    within(screen.getByRole('list', { name: 'In this scene' }))
      .getAllByRole('listitem')
      .map((item) => item.getAttribute('aria-label'))
  const base = tagFixture[0]
  const tag = base
    ? { ...base, id: 't-aldous', name: 'aldous', source: 'author' as const }
    : undefined

  beforeEach(() => {
    if (!tag) throw new Error('the tag fixture is empty')
    pins = []
    entities = [
      linked('e-mara', 't-mara'),
      linked('e-forest', 't-forest'),
      linked('e-aldous', tag.id)
    ]
    mentions = [
      { tagId: 't-mara', nodeId: 'sc-1', count: 1, ranges: [[30, 34]] },
      { tagId: 't-forest', nodeId: 'sc-1', count: 1, ranges: [[4, 15]] },
      { tagId: 't-mara', nodeId: 'sc-2', count: 1, ranges: [[1, 5]] }
    ]
    linkedTags = { 'sc-1': [tag] }
  })

  it('is not shown while no scene is open', async () => {
    await openPanel()
    expect(screen.queryByRole('region', { name: 'In this scene' })).not.toBeInTheDocument()
    expect(calls).not.toContain('mention:listForNode')
  })

  it('shows a card for every entity the open scene names or is tagged with, sheet included', async () => {
    await openPanel()
    act(() => useTreeStore.getState().select('sc-1'))
    await waitFor(() => expect(sceneCards()).toEqual(['Dark Forest', 'Mara', 'Aldous']))
    const section = screen.getByRole('region', { name: 'In this scene' })
    expect(section).toHaveTextContent('Tall, with a scar across her left palm.')
    expect(within(section).queryByRole('button', { name: 'Move up' })).not.toBeInTheDocument()
    expect(screen.getByText('Nothing pinned yet.', { exact: false })).toBeInTheDocument()
  })

  it('follows the scene the author opens and the scan of the open scene', async () => {
    await openPanel()
    act(() => useTreeStore.getState().select('sc-1'))
    await waitFor(() => expect(sceneCards()).toHaveLength(3))
    act(() => useTreeStore.getState().select('sc-2'))
    await waitFor(() => expect(sceneCards()).toEqual(['Mara']))
    mentions = [{ tagId: 't-forest', nodeId: 'sc-2', count: 1, ranges: [[2, 13]] }]
    await act(async () => {
      await useMentionStore.getState().loadForNode('sc-2')
    })
    expect(sceneCards()).toEqual(['Dark Forest'])
    act(() => useTreeStore.getState().select('sc-3'))
    await waitFor(() =>
      expect(
        screen.getByText('No one from your story bible is named in this scene yet.')
      ).toBeInTheDocument()
    )
  })

  it('Pin keeps a card: it moves to the pins and stays when the scene changes', async () => {
    await openPanel()
    act(() => useTreeStore.getState().select('sc-1'))
    await waitFor(() => expect(sceneCards()).toHaveLength(3))
    await userEvent.click(screen.getByRole('button', { name: 'Pin Dark Forest' }))
    expect(sceneCards()).toEqual(['Mara', 'Aldous'])
    expect(titles()).toEqual(['Dark Forest'])
    expect(sets.at(-1)).toEqual({ pins: [FOREST] })
    act(() => useTreeStore.getState().select('sc-3'))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'In this scene' })).toBeNull())
    expect(titles()).toEqual(['Dark Forest'])
  })
})
