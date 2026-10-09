import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Fact } from '@shared/facts'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'
import { resetFactStore } from './factStore'
import type { StoryClock } from './factView'
import { Relationships } from './Relationships'

const relation = (id: string, over: Partial<Fact>): Fact => ({
  id,
  entityId: 'e-mara',
  attribute: 'relation:mentor',
  value: '',
  objectEntityId: 'e-aldous',
  nodeId: 'sc-1',
  quote: 'Mara taught him the stars',
  origin: 'ai',
  status: 'canon',
  hidden: false,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  ...over
})

const CLOCK: StoryClock = {
  order: ['sc-1', 'sc-2'],
  nowId: 'sc-1',
  titleOf: (id) => (id === 'sc-1' ? 'Scene 1' : 'Scene 2')
}
const mara = entityFixture.find((each) => each.id === 'e-mara')
const aldous = entityFixture.find((each) => each.id === 'e-aldous')
let calls: [Channel, unknown][]

beforeEach(() => {
  resetEntityStore()
  resetFactStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  useEntityStore.setState({
    ids: entityFixture.map((each) => each.id),
    byId: Object.fromEntries(entityFixture.map((each) => [each.id, each]))
  })
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'fact:create') return relation('f-new', { origin: 'author' }) as Output<C>
      if (channel === 'fact:setHidden') return relation('f-1', { hidden: true }) as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
})
afterEach(() => {
  resetEntityStore()
  resetFactStore()
})

describe('Relationships (F-9.14)', () => {
  it('reads each relationship from this sheet’s side, marks the AI’s, and dims a later one', () => {
    if (!mara || !aldous) throw new Error('fixture')
    const facts = [
      relation('f-1', {}),
      relation('f-2', {
        entityId: 'e-forest',
        attribute: 'relation:located-in',
        objectEntityId: 'e-mara',
        nodeId: 'sc-2',
        origin: 'author',
        quote: null
      })
    ]
    render(<Relationships entity={mara} facts={facts} position="sc-1" clock={CLOCK} />)
    const mentor = screen.getByRole('listitem', { name: 'Mentor of Aldous' })
    expect(within(mentor).getByTestId('relation-ai-mark')).toBeInTheDocument()
    expect(within(mentor).getByText('From Scene 1')).toBeInTheDocument()
    const holds = screen.getByRole('listitem', { name: 'Holds Dark Forest' })
    expect(holds).toHaveAttribute('data-later', 'true')
    expect(within(holds).getByRole('button', { name: 'Remove' })).toBeInTheDocument()

    render(
      <Relationships entity={aldous} facts={[relation('f-1', {})]} position={null} clock={CLOCK} />
    )
    expect(screen.getByRole('listitem', { name: 'Mentored by Mara' })).toBeInTheDocument()
  })

  it('hides a wrong AI relationship for good', async () => {
    if (!mara) throw new Error('fixture')
    render(
      <Relationships entity={mara} facts={[relation('f-1', {})]} position={null} clock={CLOCK} />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(calls).toEqual([['fact:setHidden', { id: 'f-1', hidden: true }]])
  })

  it('adds the author’s own relationship with a type, a sheet, a label, and a scene', async () => {
    if (!mara) throw new Error('fixture')
    render(<Relationships entity={mara} facts={[]} position={null} clock={CLOCK} />)
    expect(screen.getByText('None yet.')).toBeInTheDocument()
    const add = screen.getByRole('group', { name: 'Add a relationship' })
    expect(within(add).getByRole('button', { name: 'Add' })).toBeDisabled()
    await userEvent.selectOptions(within(add).getByLabelText('Relationship type'), 'rival')
    await userEvent.selectOptions(within(add).getByLabelText('Other sheet'), 'e-aldous')
    await userEvent.type(within(add).getByLabelText('Relationship label'), 'old feud')
    await userEvent.selectOptions(within(add).getByLabelText('Holds from'), 'sc-2')
    await userEvent.click(within(add).getByRole('button', { name: 'Add' }))
    expect(calls).toEqual([
      [
        'fact:create',
        {
          kind: 'relation',
          entityId: 'e-mara',
          type: 'rival',
          objectEntityId: 'e-aldous',
          label: 'old feud',
          nodeId: 'sc-2'
        }
      ]
    ])
  })
})
