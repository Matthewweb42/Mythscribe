import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import type { SheetLineView } from '@shared/memory/views'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import {
  installFakeMain,
  sheetMemoryFixture,
  type FakeMain
} from '@renderer/features/memory/memoryFixture'
import { resetMemoryStore } from '@renderer/features/memory/memoryStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { FromTheBook } from './FromTheBook'
import { recordFixture } from './recordFixture'
import { resetRecordStore, useRecordStore } from './recordStore'

/**
 * F-16.18 (plan P2a §4): a sheet's "From the book, as of [scene ▾]": the open scene by default,
 * the groups in order with each line's note, other voices apart, and the lines later in the book.
 */

const MARA = recordFixture('r-mara', 'character', ['Mara Vell'])
const TOMAS = recordFixture('r-tomas', 'character', ['Tomas Harrow'])

const value = (claimId: string, text: string, ref: string, stale = false) => ({
  claimId,
  value: text,
  ref,
  nodeId: 'sc-1',
  para: 0,
  stale
})
const sheetLine = (over: Partial<SheetLineView>): SheetLineView => ({
  slot: 'eyes',
  label: 'Eyes',
  objectId: null,
  value: value('c-eyes', 'grey-blue', '1.1'),
  also: [],
  since: null,
  ...over
})

let main: FakeMain
let firstScene: string
let secondScene: string

beforeEach(async () => {
  resetMemoryStore()
  resetRecordStore()
  const index = buildIndex(treeFixture)
  const scenes = Object.values(index.byId).filter(
    (node) => node.kind === 'document' && index.sectionOf[node.id] === 'manuscript'
  )
  firstScene = scenes[0]?.id ?? ''
  secondScene = scenes[1]?.id ?? firstScene
  useTreeStore.setState({ ...index, loaded: true, selectedId: firstScene })
  main = installFakeMain({
    'record:list': () => [MARA, TOMAS],
    'memory:sheet': (input) => {
      const { recordId, asOf } = input as Input<'memory:sheet'>
      return sheetMemoryFixture(recordId, {
        asOf,
        asOfRef: asOf === null ? null : '1.1',
        fixed: [
          sheetLine({
            also: [value('c-eyes-2', 'grey', '2.1')]
          })
        ],
        lasting: [
          sheetLine({
            slot: 'hair',
            label: 'Hair',
            value: value('c-hair', 'red', '1.1'),
            since: '1.1'
          })
        ],
        transient: [
          sheetLine({
            slot: 'location',
            label: 'Last seen at',
            value: value('c-where', 'the quay', '1.1', true),
            since: '1.1'
          })
        ],
        others: [
          {
            claimId: 'c-said',
            slot: 'alive',
            label: 'Alive',
            objectId: null,
            value: 'no',
            voice: 'dialogue',
            mode: 'now',
            speakerId: 'r-tomas',
            ref: '1.1',
            nodeId: 'sc-1',
            stale: false
          }
        ],
        later: asOf === null ? 0 : 3
      })
    }
  })
  await act(async () => await useRecordStore.getState().load())
})
afterEach(() => {
  resetMemoryStore()
  resetRecordStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('FromTheBook (F-16.18)', () => {
  it('reads as of the open scene, by group, other voices apart, and the lines later', async () => {
    render(<FromTheBook recordId="r-mara" />)
    const section = screen.getByRole('region', { name: 'From the book' })
    expect(within(section).getByLabelText('as of')).toHaveValue(firstScene)
    expect(main.sent('memory:sheet')).toEqual([{ recordId: 'r-mara', asOf: firstScene }])
    const fixed = await within(section).findByRole('group', { name: 'Fixed' })
    const [eyes, also] = within(fixed).getAllByTestId('claim-line')
    expect(eyes).toHaveTextContent('Eyes: grey-blue')
    expect(also).toHaveTextContent('also “grey”')
    expect(also).toHaveTextContent('2.1')
    expect(within(section).getByRole('group', { name: 'Lasting' })).toHaveTextContent(
      'Hair: redsince 1.1'
    )
    const where = within(section).getByRole('group', { name: 'Last seen' })
    expect(where).toHaveTextContent('Last seen at the quay')
    expect(where).toHaveTextContent('last stated in 1.1')
    expect(where).toHaveTextContent('re-checking after you pause')
    expect(within(section).getByRole('group', { name: 'In other voices' })).toHaveTextContent(
      'Tomas Harrow says: Alive: no'
    )
    expect(screen.getByTestId('later-lines')).toHaveTextContent('3 more lines later in the book')
  })

  it('reads again as of the scene picked, or the end of the book', async () => {
    render(<FromTheBook recordId="r-mara" />)
    await screen.findByRole('group', { name: 'Fixed' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('as of'), { target: { value: secondScene } })
    })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('as of'), { target: { value: '' } })
    })
    expect(main.sent('memory:sheet')).toEqual([
      { recordId: 'r-mara', asOf: firstScene },
      ...(secondScene === firstScene ? [] : [{ recordId: 'r-mara', asOf: secondScene }]),
      { recordId: 'r-mara', asOf: null }
    ])
    expect(screen.queryByTestId('later-lines')).toBeNull()
  })
})
