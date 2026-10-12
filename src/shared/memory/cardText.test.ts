import { describe, expect, it } from 'vitest'
import {
  CARD_MAP_NOTE,
  CARD_PROMPT_HEADING,
  cardFacts,
  cardMapText,
  cardMood,
  renderPromptCard,
  renderToolCard,
  type PromptCard
} from './cardText'

const CARD: PromptCard = {
  line: 'Mara walks to the quay.',
  gist: 'Mara leaves the mill at dusk and walks to the quay, where the ferry is late.',
  where: 'the quay',
  when: 'dusk',
  pov: 'Mara Vell',
  mood: 'quiet',
  theme: 'waiting'
}

describe('the v2 card as its readers take it (F-16.20)', () => {
  it('renders the prompt card with its heading, line, gist and the facts that stand', () => {
    expect(renderPromptCard(CARD)).toBe(
      `${CARD_PROMPT_HEADING}\nLine: Mara walks to the quay.\n` +
        'Gist: Mara leaves the mill at dusk and walks to the quay, where the ferry is late.\n' +
        'Where: the quay; When: dusk; POV: Mara Vell'
    )
  })

  it('leaves out what does not stand, and never says an absence', () => {
    const bare = { ...CARD, gist: '', where: null, when: null, pov: null }
    expect(renderPromptCard(bare)).toBe(`${CARD_PROMPT_HEADING}\nLine: Mara walks to the quay.`)
    expect(cardFacts(bare)).toBe('')
    expect(cardMood({ mood: '', theme: '' })).toBe('')
    expect(cardMood({ mood: 'tense', theme: '' })).toBe('Mood: tense')
  })

  it('gives the agent a map that says it is not quotable', () => {
    expect(renderToolCard('n2 The Quay (before now: has happened)', CARD)).toBe(
      'n2 The Quay (before now: has happened)\n' +
        `Map (${CARD_MAP_NOTE}): Mara walks to the quay.\n` +
        'Where: the quay; When: dusk; POV: Mara Vell\nMood: quiet; Theme: waiting'
    )
    expect(cardMapText(CARD)).toBe(
      'Mara walks to the quay. Mara leaves the mill at dusk and walks to the quay, where the ' +
        `ferry is late. (${CARD_MAP_NOTE})`
    )
  })
})
