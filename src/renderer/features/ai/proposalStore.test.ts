import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { proposalStore, resetProposalStore } from './proposalStore'

let calls: { channel: Channel; input: unknown }[]
let failWith: string | null

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    calls.push({ channel, input })
    if (channel !== 'proposal:settle') throw new Error(`unexpected ${channel}`)
    if (failWith !== null) throw new Error(failWith)
    return null as Output<C>
  },
  on: () => () => {}
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  failWith = null
  setIpcClient(client)
})

describe('proposalStore (F-14.5)', () => {
  it('settles a proposal over proposal:settle with the status and the note', async () => {
    await proposalStore.settle('p1', 'regenerated', 'Too purple.')
    await proposalStore.settle('p2', 'accepted')
    expect(calls).toEqual([
      {
        channel: 'proposal:settle',
        input: { id: 'p1', status: 'regenerated', note: 'Too purple.' }
      },
      { channel: 'proposal:settle', input: { id: 'p2', status: 'accepted', note: null } }
    ])
    expect(toasts()).toEqual([])
  })

  it('settles each id once: a second call, even with another status, sends nothing', async () => {
    await proposalStore.settle('p1', 'rejected')
    await proposalStore.settle('p1', 'accepted')
    await Promise.all([
      proposalStore.settle('p2', 'accepted'),
      proposalStore.settle('p2', 'rejected')
    ])
    expect(calls.map((c) => (c.input as Input<'proposal:settle'>).id)).toEqual(['p1', 'p2'])
  })

  it('toasts a failed settlement and does not retry it', async () => {
    failWith = 'disk full'
    await proposalStore.settle('p1', 'acceptedPart')
    expect(toasts()).toEqual(['disk full'])
    await proposalStore.settle('p1', 'acceptedPart')
    expect(calls).toHaveLength(1)
  })

  it('resetProposalStore forgets the settled ids', async () => {
    await proposalStore.settle('p1', 'accepted')
    resetProposalStore()
    await proposalStore.settle('p1', 'accepted')
    expect(calls).toHaveLength(2)
  })
})
