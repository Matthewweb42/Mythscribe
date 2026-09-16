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
  isFeatureAllowed,
  STORY_BIBLE_SENDS
} from './aiSettings'
import { DEFAULT_HONESTY } from './critique'

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

  it('starts the honesty setting at "specific and direct" (F-14.8)', () => {
    expect(defaultAiSettings().critique).toEqual({ honesty: DEFAULT_HONESTY })
  })

  it('fills the critique defaults into a row stored before F-14.8', () => {
    const { critique: _critique, ...old } = defaultAiSettings()
    const parsed = AiSettings.safeParse({ ...old, dial: 1 })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.critique).toEqual({ honesty: DEFAULT_HONESTY })
      expect(parsed.data.dial).toBe(1)
    }
    expect(
      AiSettings.safeParse({ ...defaultAiSettings(), critique: { honesty: 'brutal' } }).success
    ).toBe(true)
    expect(
      AiSettings.safeParse({ ...defaultAiSettings(), critique: { honesty: 'harsh' } }).success
    ).toBe(false)
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

  it('names everything ghost text sends: the caret window, the notes, the metadata (F-5.3), the brief and the neighbours’ lines (F-14.3), the voice profile (F-14.1), the author rules (F-14.2), the story bible (F-14.9), and the one regenerate (F-14.7)', () => {
    expect(AI_DATA_SHARING.ghostText.sends).toBe(
      'Up to 500 characters of text before the cursor and 100 after it, plus the scene’s notes, ' +
        "its metadata (location, POV, timeline), its brief plus the previous scene's " +
        "reader-knows-after line and the next scene's goal, the voice profile (stylometric rules " +
        'and up to 3 exemplar passages), your author rules and banned phrases, and the story ' +
        "bible (your tag names by category, the scene's tags, and the titles, metadata, and " +
        'summaries of the scenes either side of it). An answer that breaks the voice profile or ' +
        'uses a banned phrase is sent back once, with the same context plus the rule it broke, ' +
        'for a second try.'
    )
  })

  it('discloses the story bible for every feature whose prompt carries it (F-14.9)', () => {
    for (const id of ['ghostText', 'chat', 'critique', 'rewrite'] as const) {
      expect(AI_DATA_SHARING[id].sends).toContain('the story bible')
    }
  })

  it('names what a scene summary sends (F-5.6): the scene, its metadata, and the character names', () => {
    expect(AI_DATA_SHARING.summary.sends).toBe(
      "A scene's text (the first 20,000 characters), its metadata, and the names of your " +
        'character tags, to keep its summary, key points, and characters present up to date ' +
        'after you pause typing.'
    )
  })

  it('names the neighbours’ summaries in the story bible line (F-5.6)', () => {
    expect(STORY_BIBLE_SENDS).toContain('summaries of the scenes either side of it')
  })

  it('names what a brief draft sends (F-14.3) and gates it at Ask', () => {
    expect(AI_DATA_SHARING.brief.minDial).toBe(1)
    expect(AI_DATA_SHARING.brief.sends).toMatch(/20,000 characters/)
    expect(AI_DATA_SHARING.brief.sends).toMatch(/metadata/)
    for (const feature of ['ghostText', 'chat', 'critique'] as const) {
      expect(AI_DATA_SHARING[feature].sends).toMatch(/brief/)
    }
  })

  it('discloses author rules and banned phrases for every feature that carries the voice block (F-14.2)', () => {
    // Agent-mode chat (src/main/ai/chat.ts) and rewrite (src/main/ai/rewrite.ts) both call
    // voiceBlock(profile, ...), which now embeds renderAuthorRulesBlock(profile.authorRules)
    // (src/main/voice/voiceBlock.ts). The data-sharing panel must name everything a feature
    // sends (CLAUDE.md, AI feature rules #3), so their `sends` copy should mention the author's
    // rules and banned phrases the way ghostText's already does.
    expect(AI_DATA_SHARING.chat.sends).toMatch(/author rules|banned phrase/)
    expect(AI_DATA_SHARING.rewrite.sends).toMatch(/author rules|banned phrase/)
  })

  it("places ghost text at Suggest and Author mode at Draft, per PLAN.md §2.3's table", () => {
    expect(AI_DATA_SHARING.ghostText.minDial).toBe(2)
    expect(AI_DATA_SHARING.authorMode.minDial).toBe(3)
    for (const id of [
      'query',
      'summary',
      'tags',
      'critique',
      'betaReader',
      'chat',
      'embeddings'
    ] as const) {
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
