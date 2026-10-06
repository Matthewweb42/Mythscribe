import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { TagMentions } from '@shared/mentions'
import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import type { TimelineEvent } from '@shared/timeline'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { resetMentionStore } from '@renderer/features/tags/mentionStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { TimelineTab } from './TimelineTab'
import { resetTimelineStore, useTimelineStore } from './timelineStore'

const event = (
  id: string,
  label: string,
  when = '',
  year: number | null = null
): TimelineEvent => ({
  id,
  label,
  when,
  year,
  note: ''
})

const meta = (over: Partial<SceneMeta>): SceneMeta => ({ ...EMPTY_SCENE_META, ...over })

/** Scene 1 is on the fall, Scene 2 on the siege (so it reads as a flashback), Chapter 1 on the siege. */
const stored: Record<string, SceneMeta> = {
  'sc-1': meta({ timeline: 'The fall', eventId: 'b' }),
  'sc-2': meta({ timeline: 'Spring: The siege', eventId: 'a', pov: ' tobin ' }),
  'ch-1': meta({ timeline: 'Spring: The siege', eventId: 'a' }),
  'sc-3': meta({ timeline: 'Gone', eventId: 'deleted' })
}

/** Per-test replacements of `stored`, and the mentions main recorded per document (F-11.2c). */
let metaOverrides: Record<string, SceneMeta> = {}
let nodeMentions: Record<string, TagMentions[]> = {}

let sets: Input<'timeline:set'>[] = []

function install(): void {
  sets = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        return {
          id,
          meta: metaOverrides[id] ?? stored[id] ?? { ...EMPTY_SCENE_META }
        } as Output<C>
      }
      if (channel === 'mention:listForNode') {
        const { nodeId } = input as Input<'mention:listForNode'>
        return (nodeMentions[nodeId] ?? []) as Output<C>
      }
      // F-11.2b: Mara's tag is on Chapter 1, which is on the siege.
      if (channel === 'documentTag:listAll') {
        return [{ nodeId: 'ch-1', tagId: 't-mara' }] as Output<C>
      }
      if (channel === 'timeline:set') {
        const value = input as Input<'timeline:set'>
        sets.push(value)
        return { timeline: value, changedNodeIds: [] } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const events = (): HTMLElement[] => screen.queryAllByTestId('timeline-event')
const eventIds = (): (string | null)[] => events().map((li) => li.getAttribute('data-event'))
const eventItem = (label: string): HTMLElement => {
  const found = events().find((li) => li.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no event ${label}`)
  return found
}

async function renderTab(list: TimelineEvent[]): Promise<void> {
  useTimelineStore.setState({ events: list, loaded: true })
  render(<TimelineTab />)
  await waitFor(() => expect(screen.getByTestId('timeline-unplaced')).toBeInTheDocument())
}

beforeEach(() => {
  metaOverrides = {}
  nodeMentions = {}
  resetMentionStore()
  resetPendingSaves()
  resetSceneMetaStore()
  resetTimelineStore()
  resetEntityStore()
  resetDocumentTagStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), selectedId: null, loaded: true })
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
})
afterEach(() => {
  resetSceneMetaStore()
  resetTimelineStore()
  resetEntityStore()
  resetDocumentTagStore()
  resetMentionStore()
  resetPendingSaves()
  setIpcClient(null)
})

describe('TimelineTab (F-11.2)', () => {
  it('shows the empty state and counts every manuscript document as not on the timeline', async () => {
    await renderTab([])
    expect(screen.getByText('No events yet.')).toBeInTheDocument()
    expect(screen.getByTestId('timeline-unplaced')).toHaveTextContent('Not on the timeline: 6')
  })

  it('lists the events in story order with their linked nodes in reading order', async () => {
    await renderTab([event('a', 'The siege', 'Spring', 1200), event('b', 'The fall', '', 1199)])
    expect(eventIds()).toEqual(['a', 'b'])
    await waitFor(() =>
      expect(
        within(eventItem('The siege'))
          .getAllByRole('button', { name: /Chapter 1|Scene 2/ })
          .map((b) => b.textContent)
      ).toEqual(['Chapter 1', 'Scene 2'])
    )
    expect(within(eventItem('The fall')).getByRole('button', { name: 'Scene 1' })).toBeVisible()
    // Scene 3 links to a deleted event: it counts as not on the timeline.
    expect(screen.getByTestId('timeline-unplaced')).toHaveTextContent('Not on the timeline: 4')
    expect(eventItem('The fall')).toHaveAttribute('data-warning', 'true')
    expect(within(eventItem('The fall')).getByText('Year is before an earlier event')).toBeVisible()
    expect(eventItem('The siege')).not.toHaveAttribute('data-warning')

    await userEvent.click(within(eventItem('The fall')).getByRole('button', { name: 'Scene 1' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
  })

  it('adds an event from the form, label required', async () => {
    const user = userEvent.setup()
    await renderTab([])
    const form = screen.getByRole('form', { name: 'Add event' })
    const add = within(form).getByRole('button', { name: 'Add event' })
    expect(add).toBeDisabled()
    await user.type(within(form).getByLabelText('Event'), 'The siege begins')
    await user.type(within(form).getByLabelText('When'), 'Spring')
    await user.type(within(form).getByLabelText('Year'), 'soon')
    expect(add).toBeDisabled()
    await user.clear(within(form).getByLabelText('Year'))
    await user.type(within(form).getByLabelText('Year'), '1201')
    await user.click(add)
    await waitFor(() => expect(eventIds()).toHaveLength(1))
    expect(sets.at(-1)?.events).toEqual([
      expect.objectContaining({ label: 'The siege begins', when: 'Spring', year: 1201, note: '' })
    ])
    expect(within(form).getByLabelText('Event')).toHaveValue('')
  })

  it('edits an event in place', async () => {
    const user = userEvent.setup()
    await renderTab([event('a', 'The siege', 'Spring')])
    await user.click(screen.getByRole('button', { name: 'Edit The siege' }))
    const form = screen.getByRole('form', { name: 'Edit event' })
    await user.clear(within(form).getByLabelText('Event'))
    await user.type(within(form).getByLabelText('Event'), 'The long siege')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit event' })).toBeNull())
    expect(sets.at(-1)?.events).toEqual([event('a', 'The long siege', 'Spring')])
    expect(eventItem('The long siege')).toBeInTheDocument()
  })

  it('reorders with Alt+ArrowUp/Down on the event', async () => {
    await renderTab([event('a', 'A'), event('b', 'B'), event('c', 'C')])
    await act(async () => {
      fireEvent.keyDown(eventItem('A'), { key: 'ArrowDown', altKey: true })
    })
    await waitFor(() => expect(eventIds()).toEqual(['b', 'a', 'c']))
    await act(async () => {
      fireEvent.keyDown(eventItem('C'), { key: 'ArrowUp', altKey: true })
    })
    await waitFor(() => expect(eventIds()).toEqual(['b', 'c', 'a']))
    // Without Alt nothing moves.
    fireEvent.keyDown(eventItem('B'), { key: 'ArrowDown' })
    expect(eventIds()).toEqual(['b', 'c', 'a'])
    expect(sets).toHaveLength(2)
  })

  it('deletes an event only after the confirm', async () => {
    const user = userEvent.setup()
    await renderTab([event('a', 'The siege'), event('b', 'The fall')])
    await user.click(screen.getByRole('button', { name: 'Delete The siege' }))
    let modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
    expect(modal.options).toMatchObject({ confirmLabel: 'Delete', danger: true })
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal?.id ?? '', false)
    })
    expect(sets).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Delete The siege' }))
    modal = useDialogStore.getState().modals[0]
    if (!modal) throw new Error('expected a confirm')
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal?.id ?? '', true)
    })
    await waitFor(() => expect(eventIds()).toEqual(['b']))
    expect(sets.at(-1)?.events).toEqual([event('b', 'The fall')])
  })

  it('the reading-order view places documents on the track and marks a flashback', async () => {
    const user = userEvent.setup()
    await renderTab([event('a', 'The siege', 'Spring'), event('b', 'The fall')])
    await user.click(screen.getByRole('button', { name: 'Reading order' }))
    expect(screen.getByRole('button', { name: 'Reading order' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const rows = screen.getAllByTestId('timeline-row')
    expect(rows.map((r) => r.getAttribute('data-node'))).toEqual([
      'sc-1',
      'sc-2',
      'sc-3',
      'sc-4',
      'sc-5',
      'sc-6'
    ])
    const row = (index: number): HTMLElement => {
      const found = rows[index]
      if (!found) throw new Error(`no row ${index}`)
      return found
    }
    await waitFor(() => expect(row(1)).toHaveAttribute('data-flashback', 'true'))
    expect(within(row(1)).getByText('Earlier')).toBeVisible()
    expect(within(row(1)).getByText('The siege')).toBeVisible()
    expect(row(0)).not.toHaveAttribute('data-flashback')
    expect(within(row(0)).getByText('The fall')).toBeVisible()
    expect(within(row(2)).getByText('—')).toBeVisible()
  })

  it('lists the ages of the characters tagged on or POV of an event´s scenes (F-11.2b)', async () => {
    const characters = [
      ...entityFixture.map((entity) =>
        entity.id === 'e-mara'
          ? { ...entity, tagId: 't-mara', fields: { ...entity.fields, born: '1170' } }
          : entity
      ),
      { ...entityFixture[1]!, id: 'e-tobin', name: 'Tobin', fields: { born: '1205' } },
      // Born, but in no scene of any event.
      { ...entityFixture[1]!, id: 'e-ines', name: 'Ines', fields: { born: '1180' } }
    ]
    useEntityStore.setState({
      byId: Object.fromEntries(characters.map((entity) => [entity.id, entity])),
      ids: characters.map((entity) => entity.id),
      loaded: true
    })
    await renderTab([event('a', 'The siege', 'Spring', 1200), event('b', 'The fall')])
    await waitFor(() =>
      expect(within(eventItem('The siege')).getByTestId('event-ages')).toHaveTextContent(
        'Ages: Mara 30, Tobin not born yet'
      )
    )
    // No year, no ages.
    expect(within(eventItem('The fall')).queryByTestId('event-ages')).toBeNull()
  })

  it('flags a character in two locations at one event (F-11.2c)', async () => {
    // Tobin is POV of Scene 2 at the Keep and mentioned in Scene 4 at the Harbor, both on the siege.
    metaOverrides = {
      'sc-2': meta({ eventId: 'a', pov: 'Tobin', location: 'Keep' }),
      'sc-4': meta({ eventId: 'a', location: 'Harbor' })
    }
    nodeMentions = { 'sc-4': [{ tagId: 't-tobin', nodeId: 'sc-4', count: 1, ranges: [[1, 6]] }] }
    const characters = [
      ...entityFixture,
      { ...entityFixture[1]!, id: 'e-tobin', name: 'Tobin', tagId: 't-tobin' }
    ]
    useEntityStore.setState({
      byId: Object.fromEntries(characters.map((entity) => [entity.id, entity])),
      ids: characters.map((entity) => entity.id),
      loaded: true
    })
    await renderTab([event('a', 'The siege'), event('b', 'The fall')])
    await waitFor(() =>
      expect(within(eventItem('The siege')).getByTestId('event-conflict')).toHaveTextContent(
        'Tobin: Keep, Harbor'
      )
    )
    expect(within(eventItem('The fall')).queryByTestId('event-conflict')).toBeNull()
  })
})
