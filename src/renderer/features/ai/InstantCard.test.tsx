import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaimInfo } from '@shared/memory/views'
import type { InstantCard as InstantCardData } from '@shared/scribe'
import {
  claimViewFixture,
  installFakeMain,
  knowsCellFixture,
  type FakeMain
} from '@renderer/features/memory/memoryFixture'
import { resetMemoryStore } from '@renderer/features/memory/memoryStore'
import { recordFixture } from '@renderer/features/records/recordFixture'
import { resetRecordStore, useRecordStore } from '@renderer/features/records/recordStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { InstantCard } from './InstantCard'
import { AGE_READ_CARD_LABEL, AUTHOR_CARD_LABEL, INSTANT_CARD_LABEL } from './instantCardText'

/**
 * F-16.24 (plan P3 §5): an instant card in the chat, drawn from the turn's `card` with no AI call:
 * the value or the yes as an AI line with ⓘ and *Not right*, who knows a secret with its holders,
 * readers-since and the one scoped muted line (from `checkedUpTo` only), the mark, and the
 * read-first line when a changed window was read first.
 */

const INFO: ClaimInfo = {
  claim: claimViewFixture('c-eyes', { ref: '1.1', para: 1 }),
  sceneTitle: 'The Quay',
  spot: null,
  reading: {
    id: 'rd-1',
    purpose: 'first',
    model: 'deepseek-v4-flash',
    promptVersion: 'reader.v2',
    created: '2026-10-13T09:00:00.000Z',
    costUsd: 0.0009
  }
}

const SLOT: InstantCardData = {
  kind: 'slot',
  recordId: 'r-mara',
  name: 'Mara',
  slot: 'eyes',
  label: 'Eyes',
  value: 'grey',
  claimId: 'c-eyes',
  quote: "Mara's eyes were grey",
  ref: '1.1',
  nodeId: 'sc-1',
  para: 1,
  since: null,
  lastStated: false,
  asOfRef: '1.1',
  readFirst: null
}

const KNOWS: InstantCardData = {
  kind: 'knows',
  secretId: 's-map',
  secretLabel: 'the sold map',
  knowerId: 'r-orrin',
  knowerName: 'Orrin',
  how: 'overheard',
  source: 'claim',
  fromName: 'Tomas',
  claimId: 'k-orrin',
  quote: 'Orrin overheard Tomas',
  ref: '1.1',
  nodeId: 'sc-1',
  para: 0,
  asOfRef: '1.1',
  readFirst: null
}

const WHO: InstantCardData = {
  kind: 'whoKnows',
  secretId: 's-map',
  label: 'the sold map',
  readersSince: { nodeId: 'sc-1', ref: '1.1' },
  holders: [
    knowsCellFixture('r-orrin', { fromId: 'r-tomas', claimId: 'k-orrin', para: 0 }),
    knowsCellFixture('r-tomas', { how: 'knewBefore', claimId: 'k-tomas', para: 0 })
  ],
  checkedUpTo: { nodeId: 'sc-4', ref: '14.2' },
  asOfRef: '14.2',
  readFirst: null
}

let main: FakeMain

beforeEach(async () => {
  resetMemoryStore()
  resetRecordStore()
  main = installFakeMain({
    'record:list': () => [
      recordFixture('r-mara', 'character', ['Mara']),
      recordFixture('r-orrin', 'character', ['Orrin']),
      recordFixture('r-tomas', 'character', ['Tomas'])
    ],
    'memory:claim': () => INFO
  })
  await act(async () => await useRecordStore.getState().load())
})
afterEach(() => {
  resetMemoryStore()
  resetRecordStore()
  setIpcClient(null)
})

describe('InstantCard (F-16.24)', () => {
  it('draws a value as an AI line with ⓘ and Not right, under the mark, with no request', async () => {
    render(<InstantCard card={SLOT} />)
    const card = screen.getByTestId('instant-card')
    expect(card).toHaveTextContent('Mara')
    expect(card).toHaveTextContent('Eyes: grey (1.1)')
    expect(screen.getByTestId('instant-card-label')).toHaveTextContent(INSTANT_CARD_LABEL)
    expect(within(card).getByRole('button', { name: 'Not right' })).toBeInTheDocument()
    expect(screen.queryByTestId('instant-card-read-first')).toBeNull()
    expect(screen.queryByTestId('instant-card-absence')).toBeNull()
    expect(main.sent('memory:claim')).toEqual([])
    // ⓘ reads where it came from: the quote with Go there and the reading's cost.
    await act(async () => {
      fireEvent.click(
        within(card).getByRole('button', { name: 'Where this comes from: Eyes: grey (1.1)' })
      )
    })
    const info = await screen.findByTestId('claim-info')
    expect(within(info).getByRole('button', { name: 'Go there' })).toBeInTheDocument()
    expect(main.sent('memory:claim')).toEqual([{ claimId: 'c-eyes' }])
  })

  it('words a lasting and a transient value, and says when the latest change was read first', () => {
    const { rerender } = render(
      <InstantCard card={{ ...SLOT, slot: 'role', label: 'Role', value: 'captain', since: '12.1' }} />
    )
    expect(screen.getByTestId('instant-card')).toHaveTextContent('Role: captain (since 12.1)')
    rerender(
      <InstantCard
        card={{
          ...SLOT,
          slot: 'location',
          label: 'Location',
          value: 'the quay',
          since: '13.4',
          lastStated: true,
          readFirst: { costUsd: 0.001 }
        }}
      />
    )
    expect(screen.getByTestId('instant-card')).toHaveTextContent(
      'Location: the quay (last stated in 13.4)'
    )
    expect(screen.getByTestId('instant-card-read-first')).toHaveTextContent(
      'read your latest change first · 0.1¢'
    )
  })

  it('answers does A know X with the yes and its quote, and the author’s own mark as hers', () => {
    const { rerender } = render(<InstantCard card={KNOWS} />)
    const card = screen.getByTestId('instant-card')
    expect(card).toHaveTextContent('Yes: Orrin overheard it from Tomas (1.1)')
    expect(screen.getByTestId('instant-card-quote')).toHaveTextContent('Orrin overheard Tomas')
    expect(within(card).getByRole('button', { name: 'Not right' })).toBeInTheDocument()
    expect(screen.queryByTestId('instant-card-absence')).toBeNull()
    rerender(
      <InstantCard
        card={{
          ...KNOWS,
          knowerName: 'Tomas',
          how: 'knewBefore',
          source: 'author',
          fromName: null,
          claimId: null,
          quote: null,
          ref: null,
          nodeId: null,
          para: null
        }}
      />
    )
    expect(screen.getByTestId('instant-card')).toHaveTextContent(
      'Yes: Tomas knew it before the book'
    )
    expect(screen.queryByRole('button', { name: 'Not right' })).toBeNull()
    expect(screen.getByTestId('instant-card-label')).toHaveTextContent(AUTHOR_CARD_LABEL)
  })

  it('lists who knows a secret, readers since, then the one muted line scoped by checkedUpTo', () => {
    const { rerender } = render(<InstantCard card={WHO} />)
    const card = screen.getByTestId('instant-card')
    expect(card).toHaveTextContent('Who knows the sold map')
    expect(within(card).getByTestId('readers-since')).toHaveTextContent('readers since 1.1')
    const lines = within(card).getAllByTestId('claim-line')
    expect(lines.map((line) => line.textContent)).toEqual([
      expect.stringContaining('Orrin: overheard from Tomas (1.1)'),
      expect.stringContaining('Tomas: knew before (1.1)')
    ])
    for (const line of lines) {
      expect(within(line).getByRole('button', { name: 'Not right' })).toBeInTheDocument()
    }
    const absence = screen.getByTestId('instant-card-absence')
    expect(absence).toHaveTextContent(
      'No other scene shows anyone learning it (checked up to 14.2)'
    )
    expect(absence).toHaveClass('text-fg-muted')
    // A partial line (suspects) is listed, muted, as the secret's sheet lists it: the scoped line
    // covers only the scenes the card leaves out.
    rerender(
      <InstantCard
        card={{
          ...WHO,
          holders: [
            knowsCellFixture('r-orrin', { fromId: 'r-tomas', claimId: 'k-orrin', para: 0 }),
            knowsCellFixture('r-mara', {
              how: 'suspects',
              line: 'partial',
              claimId: 'k-mara',
              ref: '1.2'
            })
          ]
        }}
      />
    )
    const partial = within(screen.getByTestId('instant-card')).getAllByTestId('claim-line')
    expect(within(partial[1]!).getByText('Mara: suspects (1.2)')).toHaveClass('text-fg-muted')
    expect(within(partial[0]!).getByText('Orrin: overheard from Tomas (1.1)')).not.toHaveClass(
      'text-fg-muted'
    )
    // No holder: the sheets' own scoped words; nothing read yet: "not checked yet".
    rerender(<InstantCard card={{ ...WHO, holders: [], checkedUpTo: null }} />)
    expect(screen.getByTestId('instant-card-absence')).toHaveTextContent(
      'No scene shows anyone learning this (not checked yet)'
    )
  })

  it('marks a computed age as computed from the book, its AI-read birth year with ⓘ and Not right', () => {
    render(
      <InstantCard
        card={{
          kind: 'age',
          recordId: 'r-mara',
          name: 'Mara',
          age: 19,
          born: { year: 1795, source: 'text', claimId: 'b', nodeId: 'sc-1', ref: '1.1' },
          year: { kind: 'typed', value: 1814, from: { nodeId: 'sc-2', ref: '1.2' } },
          asOfRef: '1.2',
          readFirst: null
        }}
      />
    )
    const card = screen.getByTestId('instant-card')
    expect(card).toHaveTextContent('Age: about 19 (born 1795; year 1814 from 1.2)')
    // The birth year was read by AI: its line, as the sheet's Age shows it, can be disputed here.
    expect(within(card).getByTestId('claim-line')).toHaveTextContent('Born: 1795')
    expect(within(card).getByRole('button', { name: 'Not right' })).toBeInTheDocument()
    expect(
      within(card).getByRole('button', { name: /^Where this comes from: Born: 1795/ })
    ).toBeInTheDocument()
    expect(screen.getByTestId('instant-card-label')).toHaveTextContent(AGE_READ_CARD_LABEL)
  })
})
