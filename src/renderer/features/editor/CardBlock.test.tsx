import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SceneMemory } from '@shared/memory/views'
import { installFakeMain, sceneMemoryFixture } from '@renderer/features/memory/memoryFixture'
import { resetMemoryStore } from '@renderer/features/memory/memoryStore'
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

let memory: SceneMemory

beforeEach(async () => {
  resetMemoryStore()
  resetRecordStore()
  memory = READ
  installFakeMain({ 'record:list': () => [MARA], 'memory:scene': () => memory })
  await act(async () => await useRecordStore.getState().load())
})
afterEach(() => {
  resetMemoryStore()
  resetRecordStore()
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

  it('says a scene not read yet has no card', async () => {
    memory = sceneMemoryFixture('sc-1')
    render(<CardBlock id="sc-1" />)
    expect(await screen.findByText('Not read yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Card' }))
    expect(screen.getByTestId('card-block')).toHaveTextContent('No card yet.')
  })
})
