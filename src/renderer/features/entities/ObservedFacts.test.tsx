import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import type { ObservedFact } from '@shared/observedFacts'
import { resetActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { resetReferenceStore } from '@renderer/features/references/referenceStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore } from '@renderer/features/shell/layoutStore'
import { resetDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { resetMentionStore } from '@renderer/features/tags/mentionStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EntityEditor } from './EntityEditor'
import { ObservedFacts } from './ObservedFacts'
import { resetEntityDraftStore } from './entityDraftStore'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'
import { observedFactFixture } from './observedFactFixture'
import { resetObservedFactStore, useObservedFactStore } from './observedFactStore'

type Handler = (input: unknown) => unknown

let facts: ObservedFact[]
let entities: Entity[]

/** Answers the entity and fact channels the way main does (an author edit turns `origin` to author). */
function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'entity:list') return entities as Output<C>
      if (channel === 'layout:set') return input as Output<C>
      if (channel === 'observedFact:listForEntity') {
        const { entityId } = input as Input<'observedFact:listForEntity'>
        return facts.filter((fact) => fact.entityId === entityId) as Output<C>
      }
      if (channel === 'observedFact:setHidden') {
        const { id, hidden } = input as Input<'observedFact:setHidden'>
        const fact = facts.find((other) => other.id === id)
        if (!fact) throw new IpcRequestError({ code: 'NOT_FOUND', message: 'No such fact' })
        return { ...fact, hidden } as Output<C>
      }
      if (channel === 'entity:update') {
        const patch = input as Input<'entity:update'>
        const stored = useEntityStore.getState().byId[patch.id]
        if (!stored) throw new Error('unknown entity')
        const merged: Entity = {
          ...stored,
          ...(patch.body === undefined ? {} : { body: patch.body }),
          fields: { ...stored.fields, ...patch.fields },
          origin: 'author'
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

/** Loads the bank and the tree and renders the entity's page. */
async function openPage(
  id: string,
  overrides: Partial<Record<Channel, Handler>> = {}
): Promise<[Channel, unknown][]> {
  const calls = install(overrides)
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  await act(async () => {
    await useEntityStore.getState().load()
  })
  useEntityStore.getState().select(id)
  render(<EntityEditor id={id} />)
  await screen.findByRole('region', { name: 'From the manuscript' })
  return calls
}

const section = (): HTMLElement => screen.getByRole('region', { name: 'From the manuscript' })
const rows = (): (string | null)[] =>
  within(within(section()).getByRole('list', { name: 'Observed facts' }))
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('aria-label'))
const row = (name: string): HTMLElement => {
  const found = within(section())
    .getAllByRole('listitem')
    .find((item) => item.getAttribute('aria-label') === name)
  if (!found) throw new Error(`no row ${name}`)
  return found
}
const updates = (calls: [Channel, unknown][]): unknown[] =>
  calls.filter(([channel]) => channel === 'entity:update').map(([, input]) => input)
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

function reset(): void {
  resetPendingSaves()
  resetEntityDraftStore()
  resetEntityStore()
  resetObservedFactStore()
  resetReferenceStore()
  resetTagStore()
  resetDocumentTagStore()
  resetMentionStore()
  resetLayoutStore()
  useTreeStore.getState().clear()
  resetActiveEditorStore()
  useDialogStore.setState({ modals: [], toasts: [] })
}

describe('ObservedFacts (F-5.16)', () => {
  beforeEach(() => {
    reset()
    facts = observedFactFixture
    entities = entityFixture
  })
  afterEach(() => {
    cleanup()
    // Gives up the wait a jump leaves open (no editor is mounted here) and the draft's debounce.
    reset()
  })

  it('renders nothing for an entity the manuscript says nothing about', async () => {
    const calls = install()
    await act(async () => {
      await useEntityStore.getState().load()
    })
    render(<EntityEditor id="e-forest" />)
    await waitFor(() =>
      expect(calls).toContainEqual(['observedFact:listForEntity', { entityId: 'e-forest' }])
    )
    expect(screen.queryByRole('region', { name: 'From the manuscript' })).toBeNull()
  })

  it('lists one row per attribute and value in sheet order, merged across scenes, with Differs', async () => {
    await openPage('e-mara')
    expect(rows()).toEqual([
      'Age: 34',
      'Age: 29',
      'Appearance: Grey eyes',
      'Goals / motivations: Find the lost chart'
    ])
    expect(row('Age: 34')).toHaveTextContent('Differs')
    expect(row('Age: 29')).toHaveTextContent('Differs')
    expect(row('Appearance: Grey eyes')).not.toHaveTextContent('Differs')
    // The age is stated in two scenes: one passage each, in reading order.
    expect(
      within(row('Age: 34'))
        .getAllByRole('button', { name: /^Go to passage in / })
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Go to passage in Scene 1', 'Go to passage in Scene 2'])
    expect(
      within(row('Age: 34')).getByRole('button', { name: 'Go to passage in Scene 2' })
    ).toHaveAttribute('title', 'Mara was thirty-four that winter')
  })

  it('Go to passage opens the scene, which closes the page', async () => {
    const user = userEvent.setup()
    await openPage('e-mara')
    await user.click(
      within(row('Age: 29')).getByRole('button', { name: 'Go to passage in Scene 4' })
    )
    expect(useTreeStore.getState().selectedId).toBe('sc-4')
    expect(useEntityStore.getState().selectedId).toBeNull()
  })

  it('Add to sheet writes the value into its field through the draft and the row says On sheet', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    await user.click(
      within(row('Goals / motivations: Find the lost chart')).getByRole('button', {
        name: 'Add to sheet'
      })
    )
    expect(updates(calls)).toEqual([{ id: 'e-mara', fields: { goals: 'Find the lost chart' } }])
    expect(screen.getByRole('textbox', { name: 'Goals / motivations' })).toHaveValue(
      'Find the lost chart'
    )
    const goals = row('Goals / motivations: Find the lost chart')
    expect(goals).toHaveTextContent('On sheet')
    expect(within(goals).queryByRole('button', { name: 'Add to sheet' })).toBeNull()

    // A filled field keeps the author's text: a new line in a text area, `; ` in a one-line field.
    await user.click(
      within(row('Appearance: Grey eyes')).getByRole('button', { name: 'Add to sheet' })
    )
    await user.click(within(row('Age: 34')).getByRole('button', { name: 'Add to sheet' }))
    expect(updates(calls).slice(1)).toEqual([
      {
        id: 'e-mara',
        fields: { appearance: 'Tall, with a scar across her left palm.\nGrey eyes' }
      },
      { id: 'e-mara', fields: { age: '27; 34' } }
    ])
    // The autosave that follows has nothing left to write.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(updates(calls)).toHaveLength(3)
  })

  it('shows On sheet at once for a value the sheet already holds', async () => {
    facts = [
      { ...observedFactFixture[3]!, value: 'A scar across her left palm', quote: 'the scar' }
    ]
    await openPage('e-mara')
    const appearance = row('Appearance: A scar across her left palm')
    expect(appearance).toHaveTextContent('On sheet')
    expect(within(appearance).queryByRole('button', { name: 'Add to sheet' })).toBeNull()
  })

  it('Add to sheet appends a labelled line to a blank page, and the AI mark goes', async () => {
    const user = userEvent.setup()
    entities = entityFixture.map((entity) =>
      entity.id === 'e-aldous' ? { ...entity, origin: 'ai' as const } : entity
    )
    const calls = await openPage('e-aldous')
    expect(screen.getByTestId('entity-editor')).toHaveTextContent(
      'Character · Blank page · Added by AI'
    )
    // Opening the page writes nothing, so the mark stays until a real edit.
    expect(updates(calls)).toEqual([])
    await user.click(
      within(row('Personality: Patient')).getByRole('button', { name: 'Add to sheet' })
    )
    expect(updates(calls)).toEqual([
      {
        id: 'e-aldous',
        body: 'The old cartographer who taught Mara to read the stars.\nPersonality: Patient'
      }
    ])
    expect(row('Personality: Patient')).toHaveTextContent('On sheet')
    expect(screen.getByTestId('entity-editor')).not.toHaveTextContent('Added by AI')
  })

  it('Hide puts every stored fact of the row away; Show hidden lists it and Restore brings it back', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    const disclosure = (n: number): HTMLElement =>
      within(section()).getByRole('button', { name: `Show hidden (${n})` })
    expect(disclosure(1)).toHaveAttribute('aria-expanded', 'false')

    await user.click(within(row('Age: 34')).getByRole('button', { name: 'Hide' }))
    expect(calls.filter(([channel]) => channel === 'observedFact:setHidden')).toEqual([
      ['observedFact:setHidden', { id: 'f-2', hidden: true }],
      ['observedFact:setHidden', { id: 'f-1', hidden: true }]
    ])
    // The one age left no longer differs from anything shown.
    expect(rows()).toEqual([
      'Age: 29',
      'Appearance: Grey eyes',
      'Goals / motivations: Find the lost chart'
    ])
    expect(row('Age: 29')).not.toHaveTextContent('Differs')

    await user.click(disclosure(2))
    expect(disclosure(2)).toHaveAttribute('aria-expanded', 'true')
    const hidden = within(section()).getByRole('list', { name: 'Hidden facts' })
    expect(
      within(hidden)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label'))
    ).toEqual(['Age: 34', 'Background: Born at sea'])

    await user.click(
      within(within(hidden).getAllByRole('listitem')[1]!).getByRole('button', { name: 'Restore' })
    )
    expect(calls.at(-1)).toEqual(['observedFact:setHidden', { id: 'f-6', hidden: false }])
    expect(rows()).toContain('Background: Born at sea')
    expect(disclosure(1)).toBeInTheDocument()
  })

  it('keeps the section, with the hidden list, when every row is hidden', async () => {
    facts = [observedFactFixture[5]!]
    await openPage('e-mara')
    expect(section()).toHaveTextContent('Every row is hidden.')
    expect(within(section()).queryByRole('list', { name: 'Observed facts' })).toBeNull()
    expect(within(section()).getByRole('button', { name: 'Show hidden (1)' })).toBeInTheDocument()
  })

  it('a refused Hide is toasted and the row stays', async () => {
    const user = userEvent.setup()
    await openPage('e-mara', {
      'observedFact:setHidden': () => {
        throw new IpcRequestError({ code: 'INTERNAL', message: 'disk full' })
      }
    })
    await user.click(within(row('Appearance: Grey eyes')).getByRole('button', { name: 'Hide' }))
    expect(toasts().some((message) => message.includes('disk full'))).toBe(true)
    expect(rows()).toContain('Appearance: Grey eyes')
  })

  it('compact shows the first three rows with their passages, a count, and no actions', async () => {
    install()
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    render(<ObservedFacts entity={entityFixture[1]!} compact />)
    await screen.findByRole('region', { name: 'From the manuscript' })
    expect(rows()).toEqual(['Age: 34', 'Age: 29', 'Appearance: Grey eyes'])
    expect(section()).toHaveTextContent('+ 1 more')
    expect(within(section()).getAllByRole('button', { name: /^Go to passage in / })).toHaveLength(4)
    expect(within(section()).queryByRole('button', { name: 'Add to sheet' })).toBeNull()
    expect(within(section()).queryByRole('button', { name: 'Hide' })).toBeNull()
    expect(within(section()).queryByRole('button', { name: /Show hidden/ })).toBeNull()
  })

  it('follows the store when main re-reads a scene', async () => {
    await openPage('e-mara')
    act(() => {
      useObservedFactStore.setState({
        byEntity: { 'e-mara': [observedFactFixture[3]!] }
      })
    })
    expect(rows()).toEqual(['Appearance: Grey eyes'])
  })
})
