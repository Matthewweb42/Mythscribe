import { describe, expect, it } from 'vitest'
import {
  AiSceneCard,
  isEmptyCard,
  renderCard,
  renderSceneMood,
  SCENE_CARD_RENDER_MAX,
  type SceneCard
} from './sceneCard'

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

const EMPTY: SceneCard = {
  where: null,
  when: null,
  pov: null,
  changed: '',
  cast: [],
  threads: [],
  mood: '',
  theme: ''
}

describe('renderCard (F-9.14)', () => {
  it('renders the filled lines only, compactly', () => {
    expect(renderCard('Scene 1', CARD)).toBe(
      'Scene 1\nWho: Mara, Tomas; Where: The ferry landing; When: Night\n' +
        'Changed: Mara decides to wait for dawn.\nThreads: The Debt (opened)'
    )
  })

  it('adds the mood and theme line after what changed (F-5.6)', () => {
    expect(renderCard('Scene 1', { ...CARD, mood: 'quiet dread', theme: 'debts come due' })).toBe(
      'Scene 1\nWho: Mara, Tomas; Where: The ferry landing; When: Night\n' +
        'Changed: Mara decides to wait for dawn.\nMood: quiet dread; Theme: debts come due\n' +
        'Threads: The Debt (opened)'
    )
    expect(renderCard('Scene 1', { ...EMPTY, theme: 'debts come due' })).toBe(
      'Scene 1\nTheme: debts come due'
    )
  })

  it('stays within the cap, about 100 tokens', () => {
    const long = renderCard('Scene 1', { ...CARD, changed: 'x'.repeat(1_000) })
    expect(long.length).toBe(SCENE_CARD_RENDER_MAX)
    expect(long.endsWith('…')).toBe(true)
  })

  it('knows an empty card', () => {
    expect(isEmptyCard(CARD)).toBe(false)
    expect(isEmptyCard(EMPTY)).toBe(true)
    expect(isEmptyCard({ ...EMPTY, mood: 'tense' })).toBe(false)
  })
})

describe('AiSceneCard (F-5.6)', () => {
  it("reads a summary.v4 card, which has no mood or theme, as ''", () => {
    expect(AiSceneCard.parse({ where: 'Dock', when: '', pov: '', changed: '' })).toEqual({
      where: 'Dock',
      when: '',
      pov: '',
      changed: '',
      mood: '',
      theme: ''
    })
  })
})

describe('renderSceneMood (F-5.6)', () => {
  it('is null for a scene with neither', () => {
    expect(renderSceneMood('', '  ')).toBeNull()
  })

  it('renders both, or the one that is set, with the instruction', () => {
    expect(renderSceneMood('quiet dread', 'debts come due')).toBe(
      'Scene mood: quiet dread\nScene theme: debts come due\nKeep the edit in line with them.'
    )
    expect(renderSceneMood(' quiet dread ', '')).toBe(
      'Scene mood: quiet dread\nKeep the edit in line with it.'
    )
  })
})
