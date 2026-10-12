import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Dismissed } from '@shared/memory/dismissed'
import type { SceneMemory } from '@shared/memory/views'
import {
  installFakeMain,
  memoryStatusFixture,
  sceneMemoryFixture,
  type FakeMain
} from '@renderer/features/memory/memoryFixture'
import { resetMemoryStore, useMemoryStore } from '@renderer/features/memory/memoryStore'
import { resetDismissedStore, useDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { recordFixture } from '@renderer/features/records/recordFixture'
import { resetRecordStore, useRecordStore } from '@renderer/features/records/recordStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { CardBlock } from './CardBlock'

/**
 * F-16.18 (plan P2a §4): in story memory v2 the reading's card takes the summary block's place:
 * the line and gist as a map, where, when, POV and year with ⓘ, and decision 4's typed value
 * dimmed where the text differs.
 */

const MARA = recordFixture('r-mara', 'character', ['Mara Vell'])
const TOMAS = recordFixture('r-tomas', 'character', ['Tomas Harrow'])

const READ: SceneMemory = sceneMemoryFixture('sc-1', {
  card: {
    line: 'Mara walks to the quay.',
    gist: 'Mara walks to the quay and waits for the boats.',
    fields: {
      where: { value: 'the quay', quote: 'She walked to the quay', p: 1, verified: true },
      when: null,
      pov: { value: 'r-mara', quote: 'Mara looked out', p: 0, verified: true },
      year: null,
      flashback: null,
      elapsed: null
    },
    stale: [],
    mood: 'quiet',
    theme: 'waiting',
    readingId: 'rd',
    created: '2026-10-12T10:00:00.000Z'
  },
  typed: {
    pov: { outcome: 'same', typed: 'Mara Vell', text: 'Mara Vell', quote: 'Mara looked out' },
    place: {
      outcome: 'differs',
      typed: 'the harbour',
      text: 'the quay',
      quote: 'She walked to the quay'
    },
    time: { outcome: 'typedOnly', typed: 'December', text: null, quote: null },
    year: { outcome: 'none', typed: null, text: null, quote: null }
  }
})

/** What the AI read but the text does not stand behind: a paraphrased place, an unchecked POV. */
const UNPROVEN: SceneMemory = sceneMemoryFixture('sc-1', {
  card: {
    line: 'Mara goes down to the water.',
    gist: 'Mara goes down to the water.',
    fields: {
      where: {
        value: 'the docks district',
        quote: 'Mara walked down to the quay.',
        p: 1,
        verified: false
      },
      when: { value: 'at dawn', quote: 'At dawn the boats went out', p: 2, verified: false },
      pov: { value: 'r-tomas', quote: 'Tomas watched her go', p: 0, verified: false },
      year: null,
      flashback: null,
      elapsed: null
    },
    stale: [],
    mood: null,
    theme: null,
    readingId: 'rd',
    created: '2026-10-12T10:00:00.000Z'
  },
  typed: {
    pov: { outcome: 'typedOnly', typed: 'Mara Vell', text: null, quote: null },
    place: { outcome: 'typedOnly', typed: 'the harbour', text: null, quote: null },
    // A time in its quote's own words counts as the text's, checked in code.
    time: {
      outcome: 'textOnly',
      typed: null,
      text: 'at dawn',
      quote: 'At dawn the boats went out'
    },
    year: { outcome: 'none', typed: null, text: null, quote: null }
  }
})

let memory: SceneMemory
let main: FakeMain

beforeEach(async () => {
  resetMemoryStore()
  resetRecordStore()
  resetDismissedStore()
  memory = READ
  main = installFakeMain({
    'record:list': () => [MARA, TOMAS],
    'memory:scene': () => memory,
    'memory:cardNotRight': (): Dismissed => ({
      id: 'd-1',
      kind: 'notRight',
      key: 'card|sc-1|where|the quay',
      recordId: null,
      nodeId: 'sc-1',
      label: '1.1: place “the quay”, from the card',
      quote: 'She walked to the quay',
      created: '2026-10-12T10:00:00.000Z'
    })
  })
  await act(async () => await useRecordStore.getState().load())
})
afterEach(() => {
  resetMemoryStore()
  resetRecordStore()
  resetDismissedStore()
  setIpcClient(null)
})

describe('CardBlock (F-16.18)', () => {
  it('shows the card as a map with the text’s values and the typed one dimmed where it differs', async () => {
    render(<CardBlock id="sc-1" />)
    expect(await screen.findByText('Mara walks to the quay.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Card' }))
    const card = screen.getByTestId('card-block')
    expect(card).toHaveTextContent('The AI’s map of this scene, never quoted.')
    expect(card).toHaveTextContent('Mara walks to the quay and waits for the boats.')
    const where = within(card).getByTestId('card-Where')
    expect(where).toHaveTextContent('the quay')
    expect(within(where).getByTestId('typed-dimmed')).toHaveTextContent('you typed: the harbour')
    expect(within(card).getByTestId('card-POV')).toHaveTextContent('Mara Vell')
    expect(within(card).queryByTestId('card-Year')).toBeNull()
    // Only the author typed a time: it shows as typed.
    expect(within(card).getByTestId('card-When')).toHaveTextContent('December (typed)')
    fireEvent.click(
      within(where).getByRole('button', { name: 'Where this comes from: Where the quay' })
    )
    expect(where).toHaveTextContent('She walked to the quay')
    expect(where).toHaveTextContent('¶2 · checked by a second AI read')
    expect(card).toHaveTextContent('Mood: quiet · Theme: waiting')
  })

  it('lets the typed value stand where the card’s value is unproven, with what the AI read dimmed', async () => {
    memory = UNPROVEN
    render(<CardBlock id="sc-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Card' }))
    const card = screen.getByTestId('card-block')
    const where = within(card).getByTestId('card-Where')
    expect(where).toHaveTextContent('the harbour (typed)')
    expect(within(where).getByTestId('ai-read')).toHaveTextContent(
      'AI read: the docks district, not checked'
    )
    expect(within(where).queryByTestId('typed-dimmed')).toBeNull()
    const pov = within(card).getByTestId('card-POV')
    expect(pov).toHaveTextContent('Mara Vell (typed)')
    expect(within(pov).getByTestId('ai-read')).toHaveTextContent(
      'AI read: Tomas Harrow, not checked'
    )
    fireEvent.click(
      within(pov).getByRole('button', { name: 'Where this comes from: POV Tomas Harrow' })
    )
    expect(pov).toHaveTextContent('¶1 · read by AI, not checked')
    // A time in its quote's own words stands as the text's: checked in code.
    const when = within(card).getByTestId('card-When')
    expect(when).toHaveTextContent('at dawn')
    expect(within(when).queryByTestId('ai-read')).toBeNull()
    fireEvent.click(
      within(when).getByRole('button', { name: 'Where this comes from: When at dawn' })
    )
    expect(when).toHaveTextContent('¶3 · quote checked in code')
  })

  it('dims a value whose sentence was edited since, re-checking or paused', async () => {
    memory = {
      ...READ,
      card: READ.card === null ? null : { ...READ.card, stale: ['where'] },
      typed: {
        ...READ.typed,
        place: { outcome: 'typedOnly', typed: 'the harbour', text: null, quote: null }
      }
    }
    render(<CardBlock id="sc-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Card' }))
    const where = within(screen.getByTestId('card-block')).getByTestId('card-Where')
    expect(where).toHaveTextContent('the harbour (typed)')
    expect(within(where).getByTestId('ai-read')).toHaveTextContent(
      'AI read: the quay · re-checking after you pause'
    )
    act(() => useMemoryStore.setState({ status: memoryStatusFixture({ paused: 'off' }) }))
    expect(within(where).getByTestId('ai-read')).toHaveTextContent(
      'AI read: the quay · reading paused'
    )
  })

  it('sends a card value to Dismissed with Not right in its ⓘ', async () => {
    render(<CardBlock id="sc-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Card' }))
    const where = within(screen.getByTestId('card-block')).getByTestId('card-Where')
    fireEvent.click(
      within(where).getByRole('button', { name: 'Where this comes from: Where the quay' })
    )
    await act(async () => {
      fireEvent.click(within(where).getByRole('button', { name: 'Not right' }))
    })
    expect(main.sent('memory:cardNotRight')).toEqual([
      { nodeId: 'sc-1', field: 'where', value: 'the quay' }
    ])
    expect(useDismissedStore.getState().items.map((row) => row.id)).toEqual(['d-1'])
  })

  it('says a scene not read yet has no card', async () => {
    memory = sceneMemoryFixture('sc-1')
    render(<CardBlock id="sc-1" />)
    expect(await screen.findByText('Not read yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Card' }))
    expect(screen.getByTestId('card-block')).toHaveTextContent('No card yet.')
  })
})
