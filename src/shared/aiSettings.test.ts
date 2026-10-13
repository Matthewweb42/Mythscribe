import { describe, expect, it } from 'vitest'
import { AI_FEATURE_IDS } from './ai'
import {
  AI_DATA_SHARING,
  dataSharingLabel,
  dataSharingSends,
  STORY_NOTES_SENDS,
  AI_SOURCE_LABEL,
  AI_SOURCE_MEANING,
  AiSource,
  AI_DIAL_LABEL,
  DEFAULT_GHOST_IDLE_MS,
  GHOST_IDLE_MS_MAX,
  GHOST_IDLE_MS_MIN,
  AI_FEATURES_BY_LEVEL,
  ASSISTANT_MODES,
  ASSISTANT_MODE_LABEL,
  ASSISTANT_MODE_MEANING,
  AiSettings,
  USE_AI_MEANING,
  aiSwitchPatch,
  defaultAiSettings,
  isFeatureAllowed,
  STORY_BIBLE_SENDS,
  StoredAiSettings,
  unknownFeatureToggles,
  FEATURE_GROUPS,
  MEMORY_ONLY_FEATURES,
  featureToggleItems,
  groupEnabled,
  withGroup
} from './aiSettings'
import { nameAssistant } from './assistantName'
import { DEFAULT_HONESTY } from './critique'
import { contract } from './ipc/contract'

describe('defaultAiSettings (F-14.4)', () => {
  it('installs at Off with every feature toggle on', () => {
    const defaults = defaultAiSettings()
    expect(defaults.dial).toBe(0)
    expect(defaults.chatMode).toBe('ask')
    for (const id of AI_FEATURE_IDS) expect(defaults.features[id]).toBe(true)
    expect(Object.keys(defaults.features).sort()).toEqual([...AI_FEATURE_IDS].sort())
  })

  it('parses its own defaults and refuses a dial outside 0–3, an unknown toggle key, or a non-boolean toggle', () => {
    expect(AiSettings.safeParse(defaultAiSettings()).success).toBe(true)
    expect(AiSettings.safeParse({ ...defaultAiSettings(), dial: 4 }).success).toBe(false)
    expect(AiSettings.safeParse({ ...defaultAiSettings(), dial: -1 }).success).toBe(false)
    expect(AiSettings.safeParse({ ...defaultAiSettings(), dial: 1.5 }).success).toBe(false)
    expect(AiSettings.safeParse({ dial: 0, features: 'all on' }).success).toBe(false)
    const features = defaultAiSettings().features
    expect(AiSettings.safeParse({ dial: 0, features: { ...features, bogus: true } }).success).toBe(
      false
    )
    expect(
      AiSettings.safeParse({ dial: 0, features: { ...features, ghostText: 'yes' } }).success
    ).toBe(false)
  })

  it('refuses a malformed toggle on the aiSettings:set channel instead of turning it on (F-16.2)', () => {
    const input = contract['aiSettings:set'].input
    const features = defaultAiSettings().features
    expect(
      input.safeParse({ dial: 1, features: { ...features, ghostText: 'false' } }).success
    ).toBe(false)
    expect(input.safeParse({ dial: 1, features: { ...features, critque: false } }).success).toBe(
      false
    )
    expect(input.safeParse({ ...defaultAiSettings(), dial: 1 }).success).toBe(true)
  })

  it('reads a stored row with retired ids: an unknown key is dropped and a bad value reads as off (F-16.2)', () => {
    const parsed = StoredAiSettings.safeParse({
      dial: 1,
      features: { tags: false, retiredThing: true, ghostText: false, rewrite: 'yes', chat: 0 }
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // The dial survives: a retired id never turns Use AI off.
      expect(parsed.data.dial).toBe(1)
      expect(parsed.data.features.ghostText).toBe(false)
      expect(parsed.data.features.tags).toBe(false)
      // A broken toggle fails closed: it reads as off, never as the on default.
      expect(parsed.data.features.rewrite).toBe(false)
      expect(parsed.data.features.chat).toBe(false)
      // A missing toggle (a feature added later) still fills from the default, on.
      expect(parsed.data.features.summary).toBe(true)
      expect(Object.keys(parsed.data.features).sort()).toEqual([...AI_FEATURE_IDS].sort())
      expect(parsed.data.features).not.toHaveProperty('retiredThing')
    }
    expect(StoredAiSettings.safeParse({ dial: 9, features: {} }).success).toBe(false)
  })

  it('names the toggles a stored row has for ids this build does not know, booleans only', () => {
    expect(
      unknownFeatureToggles({ features: { oracle: false, chat: false, odd: 'x', vectors: true } })
    ).toEqual({ oracle: false, vectors: true })
    // F-16.25: `cite` is this build's own id now, never an unknown one.
    expect(unknownFeatureToggles({ features: { cite: true } })).toEqual({})
    // F-16.25 (P3 slice 4): so is `navigator`; F-16.27 (P4 slice 2): and `judge`.
    expect(unknownFeatureToggles({ features: { navigator: true } })).toEqual({})
    expect(unknownFeatureToggles({ features: { judge: false } })).toEqual({})
    expect(unknownFeatureToggles(null)).toEqual({})
    expect(unknownFeatureToggles({ features: 'all' })).toEqual({})
  })

  it('fills a toggle missing from a stored row (a feature added later, F-14.10) with on, keeping the rest', () => {
    const { ghostText: _ghostText, rewrite: _rewrite, ...older } = defaultAiSettings().features
    const parsed = AiSettings.safeParse({ dial: 1, features: { ...older, chat: false } })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.dial).toBe(1)
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
    const parsed = AiSettings.safeParse({ ...old, dial: 1 })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.ghostText).toEqual({ enabled: false, idleMs: DEFAULT_GHOST_IDLE_MS })
      expect(parsed.data.dial).toBe(1)
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

describe('dataSharingLabel (F-16.9)', () => {
  it('names filing as a v2 project knows it, and keeps every v1 label', () => {
    for (const id of AI_FEATURE_IDS) {
      expect(dataSharingLabel(id, 'v1')).toBe(AI_DATA_SHARING[id].label)
    }
    expect(dataSharingLabel('contextImport', 'v2')).toBe('Filing uploads into sheets')
    expect(dataSharingLabel('reviewChat', 'v2')).toBe('Filing review chat')
    expect(dataSharingLabel('chat', 'v2')).toBe(AI_DATA_SHARING.chat.label)
  })
})

describe('dataSharingSends (F-16.4)', () => {
  it('gives the v2 text in a v2 project where a row has one, else the v1 text', () => {
    for (const id of AI_FEATURE_IDS) {
      expect(dataSharingSends(id, 'v1')).toBe(AI_DATA_SHARING[id].sends)
      expect(dataSharingSends(id, 'v2')).toBe(
        AI_DATA_SHARING[id].sendsV2 ?? AI_DATA_SHARING[id].sends
      )
    }
    // The agent reads records, Research and the author's to-dos in v2, never tags or sheets.
    expect(AI_DATA_SHARING.agent.sendsV2).toContain('Research')
    expect(AI_DATA_SHARING.agent.sendsV2).toContain('your to-dos')
    expect(AI_DATA_SHARING.agent.sendsV2).not.toMatch(/tag names|story-bible sheets|To do list/)
    // F-16.25 (agent.v9): the whole open scene, labelled evidence, one widened chapter, sheet lines.
    for (const part of [
      'the whole open scene',
      'each labelled with where',
      'Not canon text, your Ideas',
      'who knows what',
      'about 8,000 tokens of one chapter or range of scenes',
      'prose it drafts (when you apply a change) carries the Story notes block',
      'about 1,500 tokens',
      "records' names for sheet lines"
    ]) {
      expect(AI_DATA_SHARING.agent.sendsV2).toContain(part)
    }
    expect(AI_DATA_SHARING.proofread.sendsV2).toContain('names and nicknames of your records')
  })

  it('F-16.14, F-16.9, F-16.15: every v2 prose, filing and import row names what v2 sends, and never the story bible', () => {
    const v2 = [
      'ghostText',
      'rewrite',
      'chat',
      'authorMode',
      'critique',
      'editPass',
      'whatNext',
      'notesSuggest',
      'agent',
      'contextImport',
      'reviewChat',
      'proofread',
      'importStructure'
    ] as const
    for (const id of v2) {
      const text = AI_DATA_SHARING[id].sendsV2
      expect(text, id).toBeDefined()
      expect(text, id).not.toMatch(/story bible|story-bible|tag names/u)
    }
    for (const id of [
      'ghostText',
      'rewrite',
      'chat',
      'critique',
      'editPass',
      'whatNext',
      'notesSuggest'
    ] as const) {
      expect(AI_DATA_SHARING[id].sendsV2, id).toContain(STORY_NOTES_SENDS)
    }
    expect(STORY_NOTES_SENDS).toContain('never a line marked Not canon and never Ideas')
    expect(AI_DATA_SHARING.contextImport.sendsV2).toContain('never a paragraph marked Not canon')
  })
})

describe('AI_DATA_SHARING', () => {
  it('has an entry with a label, what it sends, and a level for every feature id', () => {
    for (const id of AI_FEATURE_IDS) {
      const entry = AI_DATA_SHARING[id]
      expect(entry).toBeDefined()
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.sends.length).toBeGreaterThan(0)
      expect(entry.minDial).toBeGreaterThan(0) // nothing runs at Off
    }
    expect(Object.keys(AI_DATA_SHARING).sort()).toEqual([...AI_FEATURE_IDS].sort())
  })

  it('names everything ghost text sends: the caret window, the notes, the metadata (F-5.3), the brief and the neighbours’ lines (F-14.3), the voice profile (F-14.1), the author rules (F-14.2), the story bible (F-14.9), and the one regenerate (F-14.7)', () => {
    expect(AI_DATA_SHARING.ghostText.sends).toBe(
      'Up to 500 characters of text before the cursor and 100 after it, plus the scene’s notes, ' +
        "its metadata (location, POV, timeline), its brief plus the previous scene's " +
        "reader-knows-after line and the next scene's goal, the voice profile (stylometric rules, " +
        'learned style notes, and up to 3 exemplar passages), your author rules and banned phrases, and the story ' +
        "bible (your tag names by category, the scene's tags, the sheets of the story-bible " +
        'entries linked to those tags with what the manuscript states about them, and the ' +
        'titles, metadata, and summaries of the scenes either side of it). An answer that ' +
        'breaks the voice profile or ' +
        'uses a banned phrase is sent back once, with the same context plus the rule it broke, ' +
        'for a second try.'
    )
  })

  it('discloses the story bible for every feature whose prompt carries it (F-14.9)', () => {
    for (const id of ['ghostText', 'chat', 'critique', 'rewrite'] as const) {
      expect(AI_DATA_SHARING[id].sends).toContain('the story bible')
    }
  })

  it('names what a scene summary sends (F-5.6, F-5.16): the scene, its metadata, and the names', () => {
    expect(AI_DATA_SHARING.summary.label).toBe('Scene summaries, story bible, and tags')
    expect(AI_DATA_SHARING.summary.sends).toBe(
      "A scene's text (the first 20,000 characters), its metadata, the names of the " +
        'story-bible entries and tags that occur in the scene, and the names of your tone, ' +
        'content, plot-thread, and custom tags, to keep ' +
        'its summary, key points, characters present, the facts it states about your ' +
        'characters, places, and world, and its tags up to date after you pause typing.'
    )
  })

  it('does not claim a summary sends the character tag bank: summary.v2 sends only names the scene contains (F-5.16)', () => {
    // summary.v1 listed every character tag; summary.v2 lists the story-bible entries and the
    // story tags that occur in the scene, and nothing else of the bank.
    expect(AI_DATA_SHARING.summary.sends).not.toContain('the names of your character tags')
    expect(AI_DATA_SHARING.summary.sends).toContain(
      'the names of the story-bible entries and tags that occur in the scene'
    )
  })

  it('names the neighbours’ summaries in the story bible line (F-5.6)', () => {
    expect(STORY_BIBLE_SENDS).toContain('summaries of the scenes either side of it')
  })

  it('names the entity sheets and observed facts the story bible and a query carry (F-5.16)', () => {
    expect(STORY_BIBLE_SENDS).toContain(
      'the sheets of the story-bible entries linked to those tags with what the manuscript ' +
        'states about them'
    )
    expect(AI_DATA_SHARING.query.sends).toBe(
      'Your question, scene summaries, the full text of the top matching scenes, the sheets ' +
        'of the story-bible entries your question names with what the manuscript states about ' +
        "them, and the open scene's synopsis and notes (the first 1,500 characters)."
    )
  })

  it('names what the router and the side-panel suggestions send (F-5.19, F-5.20) and gates them at Ask', () => {
    expect(AI_DATA_SHARING.route.minDial).toBe(1)
    expect(AI_DATA_SHARING.route.sends).toContain('the first 200 characters of the passage')
    expect(AI_DATA_SHARING.synopsis.minDial).toBe(1)
    expect(AI_DATA_SHARING.notesSuggest.minDial).toBe(1)
    expect(AI_DATA_SHARING.notesSuggest.sends).toContain(STORY_BIBLE_SENDS)
    expect(AI_DATA_SHARING.chat.sends).toContain('its synopsis and notes (the first 1,500')
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

  it('lets every feature run at Ask and Auto, nothing at Off (F-5.21)', () => {
    for (const id of AI_FEATURE_IDS) expect(AI_DATA_SHARING[id].minDial).toBe(1)
  })

  it('lists the features by level for display, covering every id once', () => {
    expect([...AI_FEATURES_BY_LEVEL].sort()).toEqual([...AI_FEATURE_IDS].sort())
    const levels = AI_FEATURES_BY_LEVEL.map((id) => AI_DATA_SHARING[id].minDial)
    expect(levels).toEqual([...levels].sort((a, b) => a - b))
  })
})

describe('the toggle list per story memory (F-16.17, P2a-D24)', () => {
  const idsOf = (memory: 'v1' | 'v2'): string[] =>
    featureToggleItems(memory).flatMap((item) =>
      item.kind === 'group' ? item.group.features : [item.id]
    )

  it('hides the other memory’s features and shows every other id once', () => {
    const v1 = idsOf('v1')
    const v2 = idsOf('v2')
    expect(v1).not.toContain('reader')
    expect(v1).not.toContain('verify')
    for (const id of MEMORY_ONLY_FEATURES.v1) {
      expect(v1).toContain(id)
      expect(v2).not.toContain(id)
    }
    expect(new Set(v1).size).toBe(v1.length)
    expect(new Set(v2).size).toBe(v2.length)
    const both = AI_FEATURE_IDS.filter(
      (id) => !MEMORY_ONLY_FEATURES.v1.includes(id) && !MEMORY_ONLY_FEATURES.v2.includes(id)
    )
    expect([...v1].sort()).toEqual([...both, ...MEMORY_ONLY_FEATURES.v1].sort())
    expect([...v2].sort()).toEqual([...both, ...MEMORY_ONLY_FEATURES.v2].sort())
  })

  it('shows the reader and its check as one Story memory reading switch in v2', () => {
    const groups = featureToggleItems('v2').filter((item) => item.kind === 'group')
    expect(groups).toContainEqual({ kind: 'group', group: FEATURE_GROUPS[0] })
    expect(FEATURE_GROUPS[0]).toEqual({
      id: 'storyMemoryReading',
      label: 'Story memory reading',
      features: ['reader', 'verify'],
      memory: 'v2'
    })
  })

  it('F-16.25 (P3-D17): shows Ms Scribe as one switch in v2 (the answer, the navigator, the quote check), named as the assistant', () => {
    const scribe = FEATURE_GROUPS.find((group) => group.id === 'msScribe')
    expect(scribe).toEqual({
      id: 'msScribe',
      label: 'Assistant',
      features: ['agent', 'navigator', 'cite'],
      memory: 'v2'
    })
    expect(nameAssistant(scribe?.label ?? '', 'Ms Scribe')).toBe('Ms Scribe')
    const v2 = featureToggleItems('v2')
    expect(v2.filter((item) => item.kind === 'group').map((item) => item.group.id)).toEqual([
      'msScribe',
      'storyMemoryReading',
      // F-16.27 (P4 slice 2): the contradiction check's own switch, last of the v2 groups.
      'contradictionCheck'
    ])
    // In the group's place, never beside it.
    expect(v2.some((item) => item.kind === 'feature' && item.id === 'agent')).toBe(false)
    // v1: the agent keeps its own toggle, and no v2 group shows.
    const v1 = featureToggleItems('v1')
    expect(v1.filter((item) => item.kind === 'group')).toEqual([])
    expect(v1).toContainEqual({ kind: 'feature', id: 'agent' })
    expect(v1.some((item) => item.kind === 'feature' && item.id === 'navigator')).toBe(false)
  })

  it('F-16.25 (P3-D17): hides the router and Story Intelligence in v2, the navigator in v1', () => {
    expect(MEMORY_ONLY_FEATURES.v1).toEqual(expect.arrayContaining(['route', 'query']))
    expect(MEMORY_ONLY_FEATURES.v2).toEqual(expect.arrayContaining(['navigator', 'cite']))
    const ids = (memory: 'v1' | 'v2'): string[] =>
      featureToggleItems(memory).flatMap((item) =>
        item.kind === 'group' ? item.group.features : [item.id]
      )
    expect(ids('v2')).not.toContain('route')
    expect(ids('v2')).not.toContain('query')
    expect(ids('v1')).toEqual(expect.arrayContaining(['route', 'query', 'agent']))
    expect(AI_DATA_SHARING.route.sendsV2).toContain('Nothing in this project')
    expect(AI_DATA_SHARING.query.sendsV2).toContain('Nothing in this project')
  })

  it('F-16.27 (design §2.6, P4-D21): the contradiction check is its own v2 switch, writing judge; v1 hides it', () => {
    const check = FEATURE_GROUPS.find((group) => group.id === 'contradictionCheck')
    expect(check).toEqual({
      id: 'contradictionCheck',
      label: 'Contradiction check',
      features: ['judge'],
      memory: 'v2'
    })
    if (check === undefined) throw new Error('no contradiction check group')
    expect(MEMORY_ONLY_FEATURES.v2).toContain('judge')
    const v2 = featureToggleItems('v2')
    expect(v2).toContainEqual({ kind: 'group', group: check })
    expect(v2.some((item) => item.kind === 'feature' && item.id === 'judge')).toBe(false)
    const v1 = featureToggleItems('v1').flatMap((item) =>
      item.kind === 'group' ? item.group.features : [item.id]
    )
    expect(v1).not.toContain('judge')
    const on = defaultAiSettings().features
    expect(groupEnabled(on, check)).toBe(true)
    const off = withGroup(on, check, false)
    expect(off.judge).toBe(false)
    expect(groupEnabled(off, check)).toBe(false)
    // Only `judge` moved: the reading and Ms Scribe keep theirs.
    expect({ ...off, judge: true }).toEqual(on)
  })

  it('F-16.27: describes what the contradiction check sends: pairs, never a whole scene', () => {
    expect(AI_DATA_SHARING.judge.label).toBe('Contradiction check')
    expect(AI_DATA_SHARING.judge.minDial).toBe(AI_DATA_SHARING.reader.minDial)
    for (const part of [
      'Story memory v2 only',
      'the quoted sentences with one sentence either side',
      'earlier or later in the book',
      'in a flashback or a remembered moment',
      'narration, speech, thought or rumour',
      'the story years you typed or the book states',
      'time-skip sentence',
      'at most 10 pairs',
      'Check the book',
      'up to 20 pairs with three sentences either side to the strong model',
      'your notes or a Research page'
    ]) {
      expect(AI_DATA_SHARING.judge.sends).toContain(part)
    }
    expect(AI_DATA_SHARING.judge.sends).not.toContain('whole scene')
  })

  it('F-16.25: describes what the navigator sends, never the whole scene', () => {
    expect(AI_DATA_SHARING.navigator.label).toBe('Ms Scribe’s search')
    for (const part of [
      'first 1,000 characters',
      'last two turns (300 characters each)',
      'first 200 characters of a selected passage',
      'names and nicknames of your records',
      'first line of each record’s Ideas',
      'a map of the book',
      'short snippets',
      // Design §2.6: labels and Research passages are named in the rows (slice 4 review).
      'Research documents',
      'Not canon text',
      'your Ideas and idea scenes',
      'Pinned lines'
    ]) {
      expect(AI_DATA_SHARING.navigator.sends).toContain(part)
    }
    expect(AI_DATA_SHARING.navigator.sends).not.toContain('whole open scene')
  })

  it('writes both ids and reads on only when both are on', () => {
    const group = FEATURE_GROUPS[0]
    if (group === undefined) throw new Error('no group')
    const features = defaultAiSettings().features
    expect(groupEnabled(features, group)).toBe(true)
    const off = withGroup(features, group, false)
    expect(off.reader).toBe(false)
    expect(off.verify).toBe(false)
    expect(off.ghostText).toBe(true)
    expect(groupEnabled(off, group)).toBe(false)
    expect(groupEnabled({ ...features, verify: false }, group)).toBe(false)
    expect(withGroup(off, group, true)).toEqual(features)
  })

  it('describes what reading and checking send, never notes or Research', () => {
    expect(AI_DATA_SHARING.reader.label).toBe('Story memory reading')
    expect(AI_DATA_SHARING.verify.label).toBe('Story memory check')
    expect(AI_DATA_SHARING.reader.sends).toContain('Never notes, Research, Pinned, Ideas')
    expect(AI_DATA_SHARING.verify.sends).toContain('one either side')
    // F-16.22, F-16.23 (P2b): the secrets and threads, who is known to know them, and reveals.
    expect(AI_DATA_SHARING.reader.sends).toContain(
      'the secrets and plot threads already found (a short label each, never one only an Idea scene'
    )
    expect(AI_DATA_SHARING.reader.sends).toContain('who is known to know them')
    expect(AI_DATA_SHARING.verify.sends).toContain('the people who might have told them')
    expect(AI_DATA_SHARING.verify.sends).toContain("that one's label and revealing sentence")
    // Review of P2b slice 2: knows and step items carry the secret's or thread's sentence, which
    // may stand in another scene; the reader's topic lines say where; never an Idea scene.
    expect(AI_DATA_SHARING.verify.sends).toContain(
      "the secret's short label with the sentence that revealed it (which may stand in another scene)"
    )
    expect(AI_DATA_SHARING.verify.sends).toContain('for a step in a plot thread')
    expect(AI_DATA_SHARING.verify.sends).toContain('Never a sentence from an Idea scene')
    expect(AI_DATA_SHARING.reader.sends).toContain('or someone in the scene holds')
    expect(AI_DATA_SHARING.reader.sends).toContain('the scenes where each opened and last moved')
    // Never who does not know.
    expect(AI_DATA_SHARING.reader.sends).not.toMatch(/does not know|doesn't know/)
  })
})

describe('Use AI and the chat modes (decided by the author 2026-10-07)', () => {
  it('has Use AI on and off and the three chat modes, each with its meaning', () => {
    expect(USE_AI_MEANING.off).toBe('No AI at all. Nothing leaves this machine.')
    expect(USE_AI_MEANING.on.length).toBeGreaterThan(0)
    expect(ASSISTANT_MODES.map((m) => ASSISTANT_MODE_LABEL[m])).toEqual(['Auto', 'Ask', 'Plan'])
    for (const m of ASSISTANT_MODES) expect(ASSISTANT_MODE_MEANING[m].length).toBeGreaterThan(0)
    expect(AI_DIAL_LABEL).toEqual({ 0: 'Off', 1: 'On' })
  })

  it('writes the wizard positions: off is AI off, ask and auto are AI on in that mode', () => {
    expect(aiSwitchPatch('off')).toEqual({ dial: 0, chatMode: 'ask' })
    expect(aiSwitchPatch('ask')).toEqual({ dial: 1, chatMode: 'ask' })
    expect(aiSwitchPatch('auto')).toEqual({ dial: 1, chatMode: 'auto' })
  })

  it('migrates a stored F-5.21 switch without raising autonomy: Off stays off, Auto is Auto, anything else Ask', () => {
    const { chatMode: _drop, ...base } = defaultAiSettings()
    for (const [dial, auto, expectedDial, expected] of [
      [0, undefined, 0, 'ask'],
      [0, false, 0, 'ask'],
      [0, true, 0, 'ask'],
      [1, undefined, 1, 'ask'],
      [1, false, 1, 'ask'],
      [1, true, 1, 'auto'],
      [2, undefined, 1, 'ask'],
      [3, undefined, 1, 'ask']
    ] as const) {
      const parsed = AiSettings.parse({ ...base, dial, auto })
      expect(parsed.dial).toBe(expectedDial)
      expect(parsed.chatMode).toBe(expected)
      expect('auto' in parsed).toBe(false)
    }
  })

  it('keeps a stored chat mode and never writes the old Auto bit', () => {
    for (const chatMode of ASSISTANT_MODES) {
      const parsed = AiSettings.parse({ ...defaultAiSettings(), dial: 1, auto: false, chatMode })
      expect(parsed.chatMode).toBe(chatMode)
    }
    expect(AiSettings.safeParse({ ...defaultAiSettings(), chatMode: 'query' }).success).toBe(false)
  })
})

describe('isFeatureAllowed', () => {
  const cases = AI_FEATURE_IDS.flatMap((feature) =>
    ([0, 1] as const).flatMap((dial) =>
      [true, false].map((on) => ({
        feature,
        dial,
        on,
        expected: on && dial >= AI_DATA_SHARING[feature].minDial
      }))
    )
  )
  it('covers every feature, level, and toggle state', () => {
    expect(cases).toHaveLength(AI_FEATURE_IDS.length * 2 * 2)
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
      for (const dial of [0, 1] as const) {
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

describe('AiSettings.source (F-15.4)', () => {
  it("defaults a row stored before the Cloud source existed to the author's own key", () => {
    const { source: _source, ...stored } = defaultAiSettings()
    const parsed = AiSettings.parse(stored)
    expect(parsed.source).toBe('ownKey')
    expect(parsed.dial).toBe(stored.dial)
  })

  it('keeps a stored source and refuses an unknown one', () => {
    expect(AiSettings.parse({ ...defaultAiSettings(), source: 'cloud' }).source).toBe('cloud')
    expect(AiSettings.safeParse({ ...defaultAiSettings(), source: 'anthropic' }).success).toBe(
      false
    )
  })

  it('labels and explains every source option', () => {
    for (const source of AiSource.options) {
      expect(AI_SOURCE_LABEL[source].length).toBeGreaterThan(0)
      expect(AI_SOURCE_MEANING[source].length).toBeGreaterThan(0)
    }
  })
})
