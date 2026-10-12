import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import type { ClaimInfo } from '@shared/memory/views'
import { recordFixture } from '@renderer/features/records/recordFixture'
import { resetRecordStore, useRecordStore } from '@renderer/features/records/recordStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { DismissedDialog } from '@renderer/features/thisScene/DismissedDialog'
import { resetDismissedStore, useDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { ClaimLine } from './ClaimLine'
import { claimViewFixture, installFakeMain, type FakeMain } from './memoryFixture'
import { resetMemoryStore } from './memoryStore'
import { claimInfoLines } from './memoryView'

/**
 * F-16.18 (plan P2a §4): every AI line has ⓘ (the quote with *Go there*, where and when it was
 * read, how it was proved, the spot check, the reading's cost) and *Not right* (*Not about Mara*,
 * one check for the record picked; *Wrong value*, to Dismissed, whose *Undo* brings it back).
 */

const MARA = recordFixture('r-mara', 'character', ['Mara Vell'])
const ELLA = recordFixture('r-ella', 'character', ['Ella Harrow'])

const INFO: ClaimInfo = {
  claim: claimViewFixture('c-1', { ref: '1.2', para: 2 }),
  sceneTitle: 'The Quay',
  spot: { verdict: 'agree', tier: 'strong', at: '2026-10-12T10:00:00.000Z' },
  reading: {
    id: 'rd-1',
    purpose: 'first',
    model: 'deepseek-v4-flash',
    promptVersion: 'reader.v1',
    created: '2026-10-12T09:00:00.000Z',
    costUsd: 0.0009
  }
}

const DISMISSED = {
  id: 'd-1',
  kind: 'notRight' as const,
  key: 'k',
  recordId: 'r-mara',
  nodeId: 'sc-1',
  label: 'Mara Vell: Eyes grey',
  quote: "Mara's eyes were grey",
  created: '2026-10-12T10:00:00.000Z'
}

let main: FakeMain
let rows: (typeof DISMISSED)[]

beforeEach(async () => {
  resetMemoryStore()
  resetDismissedStore()
  resetRecordStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  rows = []
  main = installFakeMain({
    'record:list': () => [MARA, ELLA],
    'memory:claim': () => INFO,
    'memory:notRight': (input) => {
      const { choice } = input as Input<'memory:notRight'>
      if (choice.kind === 'notAbout') return { ok: true, outcome: 'moved', dismissed: null }
      rows = [DISMISSED]
      return { ok: true, outcome: 'dismissed', dismissed: DISMISSED }
    },
    'dismissed:list': () => ({ items: rows, count: rows.length }),
    'dismissed:undo': () => {
      rows = []
      return DISMISSED
    }
  })
  await act(async () => await useRecordStore.getState().load())
})
afterEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  resetRecordStore()
  setIpcClient(null)
})

const line = (): React.JSX.Element => (
  <ul>
    <ClaimLine claimId="c-1" text="Eyes: grey" note="1.2" recordId="r-mara" />
  </ul>
)

describe('ClaimLine (F-16.18)', () => {
  it('ⓘ shows the quote with Go there, how it was proved, the spot check and the cost', async () => {
    render(line())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Where this comes from: Eyes: grey' }))
    })
    const info = await screen.findByTestId('claim-info')
    expect(info).toHaveTextContent("Mara's eyes were grey")
    expect(within(info).getByRole('button', { name: 'Go there' })).toBeInTheDocument()
    expect(info).toHaveTextContent('Read by AI from 1.2 ¶3 on 12 Oct')
    expect(info).toHaveTextContent('quote checked in code')
    expect(info).toHaveTextContent('spot check by the strong model: agreed on 12 Oct')
    expect(info).toHaveTextContent('that reading cost 0.09¢ (deepseek-v4-flash)')
    expect(main.sent('memory:claim')).toEqual([{ claimId: 'c-1' }])
  })

  it('words a line the checker proved, and one in another voice', () => {
    const lines = claimInfoLines({
      ...INFO,
      spot: null,
      reading: null,
      claim: { ...INFO.claim, proof: 'verified', voice: 'dialogue', mode: 'memory' }
    })
    expect(lines).toEqual([
      'Read by AI from 1.2 ¶3',
      'checked by a second AI read',
      'said as dialogue, memory'
    ])
  })

  it('Not right › Wrong value sends it to Dismissed, whose Undo takes the tombstone away', async () => {
    render(
      <>
        {line()}
        <DismissedDialog />
      </>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Not right' }))
    const choices = screen.getByRole('group', { name: 'What is not right' })
    expect(within(choices).getByRole('button', { name: 'Not about Mara Vell' })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(choices).getByRole('button', { name: 'Wrong value' }))
    })
    expect(main.sent('memory:notRight')).toEqual([
      { claimId: 'c-1', choice: { kind: 'wrongValue' }, requestId: expect.any(String) as string }
    ])
    expect(useDismissedStore.getState().items).toEqual([DISMISSED])
    act(() => useDismissedStore.getState().setOpen(true))
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Undo: Mara Vell: Eyes grey' }))
    })
    expect(main.sent('dismissed:undo')).toEqual([{ id: 'd-1' }])
    expect(useDismissedStore.getState().items).toEqual([])
  })

  it('Not right › Not about Mara checks it for the record picked', async () => {
    render(line())
    fireEvent.click(screen.getByRole('button', { name: 'Not right' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not about Mara Vell' }))
    fireEvent.change(screen.getByLabelText('It is about'), { target: { value: 'r-ella' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    })
    expect(main.sent('memory:notRight')).toEqual([
      {
        claimId: 'c-1',
        choice: { kind: 'notAbout', recordId: 'r-ella' },
        requestId: expect.any(String) as string
      }
    ])
    expect(useDialogStore.getState().toasts.map((toast) => toast.message)).toContain(
      'Moved to Ella Harrow.'
    )
    expect(screen.queryByRole('group', { name: 'What is not right' })).toBeNull()
  })

  it('dims a stale line with why', () => {
    render(
      <ul>
        <ClaimLine
          claimId="c-1"
          text="Hair: red"
          stale
          staleNote="re-checking after you pause"
          recordId="r-mara"
        />
      </ul>
    )
    expect(screen.getByTestId('claim-line')).toHaveTextContent('re-checking after you pause')
    expect(screen.getByText('Hair: red').className).toContain('opacity-60')
  })
})
