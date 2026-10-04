import { describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from './aiSettings'
import {
  QUICK_ACTION_IDS,
  QUICK_ACTIONS,
  RECAP_QUOTE_MAX,
  RECAP_SCENE_QUESTION,
  directionMessage,
  quickActionReason,
  recapQuestion,
  type QuickActionState
} from './quickActions'

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 1,
  ...over
})

const state = (over: Partial<QuickActionState> = {}): QuickActionState => ({
  settings: settings(),
  scene: true,
  length: 500,
  minLength: 40,
  busy: null,
  ...over
})

const off = (feature: keyof AiSettings['features']): AiSettings => {
  const on = settings()
  return { ...on, features: { ...on.features, [feature]: false } }
}

describe('QUICK_ACTIONS (F-5.17)', () => {
  it('names the four actions in row order with their tiers', () => {
    expect(QUICK_ACTION_IDS).toEqual(['whatNext', 'proofread', 'continuity', 'recap'])
    expect(QUICK_ACTION_IDS.map((id) => QUICK_ACTIONS[id].tier)).toEqual([
      'fast',
      'fast',
      'strong',
      'strong'
    ])
  })
})

describe('quickActionReason (F-5.17)', () => {
  it.each<[string, QuickActionState, string | null]>([
    ['runs when nothing forbids it', state(), null],
    [
      'settings not loaded read as the dial',
      state({ settings: null, scene: false, busy: 'Busy' }),
      'What comes next needs the AI dial at Ask or higher (Settings, AI tab)'
    ],
    [
      'the dial comes before the toggle, the scene, the length, and busy',
      state({ settings: { ...off('whatNext'), dial: 0 }, scene: false, length: 0, busy: 'Busy' }),
      'What comes next needs the AI dial at Ask or higher (Settings, AI tab)'
    ],
    [
      'the toggle comes before the scene',
      state({ settings: off('whatNext'), scene: false, busy: 'Busy' }),
      'What comes next is turned off for this project (Settings, AI tab)'
    ],
    [
      'the scene comes before the length',
      state({ scene: false, length: 0, busy: 'Busy' }),
      'Open a manuscript scene first'
    ],
    [
      'the length comes before busy',
      state({ length: 39, busy: 'Busy' }),
      'Write 40 characters first'
    ],
    [
      'busy last',
      state({ busy: 'Waiting for the current answer' }),
      'Waiting for the current answer'
    ]
  ])('%s', (_, input, expected) => {
    expect(quickActionReason('whatNext', input)).toBe(expected)
  })

  it('gates each action by its own feature and formats the length', () => {
    expect(quickActionReason('recap', state({ settings: off('query') }))).toBe(
      'Story Intelligence is turned off for this project (Settings, AI tab)'
    )
    expect(quickActionReason('recap', state({ settings: off('whatNext') }))).toBeNull()
    expect(quickActionReason('continuity', state({ settings: off('continuity') }))).toBe(
      'Consistency check is turned off for this project (Settings, AI tab)'
    )
    expect(quickActionReason('proofread', state({ settings: settings({ dial: 0 }) }))).toBe(
      'Proofread needs the AI dial at Ask or higher (Settings, AI tab)'
    )
    expect(quickActionReason('continuity', state({ length: 10, minLength: 1_200 }))).toBe(
      'Write 1,200 characters first'
    )
  })
})

describe('recapQuestion (F-5.17)', () => {
  it('asks about the scene without a selection worth quoting', () => {
    expect(recapQuestion(null)).toBe(RECAP_SCENE_QUESTION)
    expect(recapQuestion('   ')).toBe(RECAP_SCENE_QUESTION)
    expect(recapQuestion('Too short here.')).toBe(RECAP_SCENE_QUESTION)
  })

  it('quotes the selection with its whitespace collapsed', () => {
    expect(recapQuestion('  Mara climbed\n\nthe ridge at dusk.  ')).toBe(
      'What happens in this passage? Give a short recap, citing it: "Mara climbed the ridge at dusk."'
    )
  })

  it('cuts a long selection with an ellipsis at the quote cap', () => {
    const question = recapQuestion('word '.repeat(400))
    const quote = /"(.*)"$/.exec(question)?.[1] ?? ''
    expect(quote.length).toBeLessThanOrEqual(RECAP_QUOTE_MAX)
    expect(quote.endsWith('…')).toBe(true)
    expect(quote.startsWith('word word')).toBe(true)
  })
})

describe('directionMessage (F-5.17)', () => {
  it('turns a direction into the Author-mode instruction', () => {
    expect(directionMessage({ title: 'The storm breaks', text: 'Rain drives them inside.' })).toBe(
      'Continue the scene in this direction: The storm breaks. Rain drives them inside.'
    )
  })
})
