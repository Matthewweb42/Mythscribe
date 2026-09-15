import { describe, expect, it } from 'vitest'
import { AI_FEATURE_IDS } from './ai'
import {
  AI_DATA_SHARING,
  AI_DIAL_LABEL,
  DEFAULT_GHOST_IDLE_MS,
  GHOST_IDLE_MS_MAX,
  GHOST_IDLE_MS_MIN,
  AI_DIAL_LEVELS,
  AI_DIAL_MEANING,
  AI_FEATURES_BY_LEVEL,
  AiSettings,
  defaultAiSettings,
  isFeatureAllowed
} from './aiSettings'

describe('defaultAiSettings (F-14.4)', () => {
  it('installs at Off with every feature toggle on', () => {
    const defaults = defaultAiSettings()
    expect(defaults.dial).toBe(0)
    for (const id of AI_FEATURE_IDS) expect(defaults.features[id]).toBe(true)
    expect(Object.keys(defaults.features).sort()).toEqual([...AI_FEATURE_IDS].sort())
  })

  it('parses its own defaults and refuses a dial outside 0–3, an unknown toggle key, or a non-boolean toggle', () => {
    expect(AiSettings.safeParse(defaultAiSettings()).success).toBe(true)
    expect(AiSettings.safeParse({ ...defaultAiSettings(), dial: 4 }).success).toBe(false)
    expect(AiSettings.safeParse({ ...defaultAiSettings(), dial: -1 }).success).toBe(false)
    expect(AiSettings.safeParse({ ...defaultAiSettings(), dial: 1.5 }).success).toBe(false)
    const features = defaultAiSettings().features
    expect(AiSettings.safeParse({ dial: 0, features: { ...features, bogus: true } }).success).toBe(
      false
    )
    expect(
      AiSettings.safeParse({ dial: 0, features: { ...features, ghostText: 'yes' } }).success
    ).toBe(false)
  })

  it('fills a toggle missing from a stored row (a feature added later, F-14.10) with on, keeping the rest', () => {
    const { ghostText: _ghostText, rewrite: _rewrite, ...older } = defaultAiSettings().features
    const parsed = AiSettings.safeParse({ dial: 2, features: { ...older, chat: false } })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.dial).toBe(2)
      expect(parsed.data.features.chat).toBe(false)
      expect(parsed.data.features.ghostText).toBe(true)
      expect(parsed.data.features.rewrite).toBe(true)
      expect(Object.keys(parsed.data.features).sort()).toEqual([...AI_FEATURE_IDS].sort())
    }
  })

  it('starts VibeWrite off with the default idle delay (F-5.3)', () => {
    expect(defaultAiSettings().ghostText).toEqual({ enabled: false, idleMs: DEFAULT_GHOST_IDLE_MS })
  })

  it('fills the ghost-text defaults into a row stored before F-5.3 and bounds the idle delay', () => {
    const { ghostText: _ghostText, ...old } = defaultAiSettings()
    const parsed = AiSettings.safeParse({ ...old, dial: 2 })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.ghostText).toEqual({ enabled: false, idleMs: DEFAULT_GHOST_IDLE_MS })
      expect(parsed.data.dial).toBe(2)
    }
    const withIdle = (idleMs: number): boolean =>
      AiSettings.safeParse({ ...defaultAiSettings(), ghostText: { enabled: true, idleMs } }).success
    expect(withIdle(GHOST_IDLE_MS_MIN)).toBe(true)
    expect(withIdle(GHOST_IDLE_MS_MAX)).toBe(true)
    expect(withIdle(GHOST_IDLE_MS_MIN - 1)).toBe(false)
    expect(withIdle(GHOST_IDLE_MS_MAX + 1)).toBe(false)
    expect(withIdle(750.5)).toBe(false)
  })
})

describe('AI_DATA_SHARING', () => {
  it('has an entry with a label, what it sends, and a level for every feature id', () => {
    for (const id of AI_FEATURE_IDS) {
      const entry = AI_DATA_SHARING[id]
      expect(entry).toBeDefined()
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.sends.length).toBeGreaterThan(0)
      expect(AI_DIAL_LEVELS).toContain(entry.minDial)
      expect(entry.minDial).toBeGreaterThan(0) // nothing runs at Off
    }
    expect(Object.keys(AI_DATA_SHARING).sort()).toEqual([...AI_FEATURE_IDS].sort())
  })

  it('names everything ghost text sends: the caret window, the notes, the metadata (F-5.3), the voice profile (F-14.1), and the one regenerate (F-14.7)', () => {
    expect(AI_DATA_SHARING.ghostText.sends).toBe(
      'Up to 500 characters of text before the cursor and 100 after it, plus the scene’s notes ' +
        'and metadata (location, POV, timeline), and the voice profile (stylometric rules and up ' +
        'to 3 exemplar passages). An answer that breaks the voice profile is sent back once, with ' +
        'the same context plus the rule it broke, for a second try.'
    )
  })

  it("places ghost text at Suggest and Author mode at Draft, per PLAN.md §2.3's table", () => {
    expect(AI_DATA_SHARING.ghostText.minDial).toBe(2)
    expect(AI_DATA_SHARING.authorMode.minDial).toBe(3)
    for (const id of ['query', 'summary', 'tags', 'critique', 'chat', 'embeddings'] as const) {
      expect(AI_DATA_SHARING[id].minDial).toBe(1)
    }
  })

  it('lists the features by level for display, covering every id once', () => {
    expect([...AI_FEATURES_BY_LEVEL].sort()).toEqual([...AI_FEATURE_IDS].sort())
    const levels = AI_FEATURES_BY_LEVEL.map((id) => AI_DATA_SHARING[id].minDial)
    expect(levels).toEqual([...levels].sort((a, b) => a - b))
  })
})

describe('the dial labels and meanings', () => {
  it('cover all four levels', () => {
    expect(AI_DIAL_LEVELS).toEqual([0, 1, 2, 3])
    expect(AI_DIAL_LEVELS.map((level) => AI_DIAL_LABEL[level])).toEqual([
      'Off',
      'Ask',
      'Suggest',
      'Draft'
    ])
    for (const level of AI_DIAL_LEVELS) expect(AI_DIAL_MEANING[level].length).toBeGreaterThan(0)
  })
})

describe('isFeatureAllowed', () => {
  const cases = AI_FEATURE_IDS.flatMap((feature) =>
    AI_DIAL_LEVELS.flatMap((dial) =>
      [true, false].map((on) => ({
        feature,
        dial,
        on,
        expected: on && dial >= AI_DATA_SHARING[feature].minDial
      }))
    )
  )
  it('covers every feature, level, and toggle state', () => {
    expect(cases).toHaveLength(AI_FEATURE_IDS.length * 4 * 2)
  })

  it.each(cases)('$feature at dial $dial with the toggle $on → $expected', (c) => {
    const settings: AiSettings = {
      ...defaultAiSettings(),
      dial: c.dial,
      features: { ...defaultAiSettings().features, [c.feature]: c.on }
    }
    expect(isFeatureAllowed(settings, c.feature)).toBe(c.expected)
  })

  it('is monotone in the dial: raising it never disables a feature', () => {
    for (const feature of AI_FEATURE_IDS) {
      let previous = false
      for (const dial of AI_DIAL_LEVELS) {
        const now = isFeatureAllowed({ ...defaultAiSettings(), dial }, feature)
        if (previous) expect(now).toBe(true)
        previous = now
      }
    }
  })

  it('allows nothing at Off, whatever the toggles say', () => {
    for (const feature of AI_FEATURE_IDS) {
      expect(isFeatureAllowed(defaultAiSettings(), feature)).toBe(false)
    }
  })
})
