import { describe, expect, it } from 'vitest'
import { isEmptyCard, renderCard, SCENE_CARD_RENDER_MAX, type SceneCard } from './sceneCard'

const CARD: SceneCard = {
  where: { value: 'The ferry landing', origin: 'author' },
  when: { value: 'Night', origin: 'ai' },
  pov: null,
  changed: 'Mara decides to wait for dawn.',
  cast: ['Mara', 'Tomas'],
  threads: [{ entityId: 't1', name: 'The Debt', event: 'opened' }]
}

describe('renderCard (F-9.14)', () => {
  it('renders the filled lines only, compactly', () => {
    expect(renderCard('Scene 1', CARD)).toBe(
      'Scene 1\nWho: Mara, Tomas; Where: The ferry landing; When: Night\n' +
        'Changed: Mara decides to wait for dawn.\nThreads: The Debt (opened)'
    )
  })

  it('stays within the cap, about 100 tokens', () => {
    const long = renderCard('Scene 1', { ...CARD, changed: 'x'.repeat(1_000) })
    expect(long.length).toBe(SCENE_CARD_RENDER_MAX)
    expect(long.endsWith('…')).toBe(true)
  })

  it('knows an empty card', () => {
    expect(isEmptyCard(CARD)).toBe(false)
    expect(
      isEmptyCard({ where: null, when: null, pov: null, changed: '', cast: [], threads: [] })
    ).toBe(true)
  })
})
