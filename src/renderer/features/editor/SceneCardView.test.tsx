import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SceneCard } from '@shared/sceneCard'
import { SceneCardView } from './SceneCardView'

const CARD: SceneCard = {
  where: { value: 'The ferry landing', origin: 'author' },
  when: { value: 'Night', origin: 'ai' },
  pov: null,
  changed: 'Mara decides to wait for dawn.',
  cast: ['Mara', 'Tomas'],
  threads: [{ entityId: 't1', name: 'The Debt', event: 'opened' }],
  mood: '',
  theme: ''
}

describe('SceneCardView (F-9.14)', () => {
  it('shows who, where, when, what changed, and the threads, marking what the AI read', () => {
    render(<SceneCardView card={CARD} />)
    const card = screen.getByRole('region', { name: 'Scene card' })
    expect(within(card).getByRole('list', { name: 'Who' })).toHaveTextContent('MaraTomas')
    expect(card).toHaveTextContent('WhereThe ferry landing')
    expect(card).toHaveTextContent('Changed')
    expect(within(card).getAllByLabelText('AI')).toHaveLength(2)
    expect(within(card).getByRole('list', { name: 'Threads in this scene' })).toHaveTextContent(
      'The Debt · opened'
    )
  })

  it("shows the scene's mood and theme as the AI's reading (F-5.6)", () => {
    render(<SceneCardView card={{ ...CARD, mood: 'quiet dread', theme: 'debts come due' }} />)
    const card = screen.getByRole('region', { name: 'Scene card' })
    expect(card).toHaveTextContent('Moodquiet dread')
    expect(card).toHaveTextContent('Themedebts come due')
    expect(within(card).getAllByLabelText('AI')).toHaveLength(4)
  })

  it('has a one-line compact form for the Outline row', () => {
    render(<SceneCardView card={CARD} compact />)
    expect(screen.getByTestId('outline-card')).toHaveTextContent(
      'Mara, Tomas · The ferry landing · NightMara decides to wait for dawn.The Debt (opened)'
    )
  })
})
