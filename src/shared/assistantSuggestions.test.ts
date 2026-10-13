import { describe, expect, it } from 'vitest'
import type { AiFeatureId } from './ai'
import {
  SUGGESTION_MAX_CHARS,
  assistantSuggestions,
  type SuggestionContext
} from './assistantSuggestions'

const EVERYTHING: ReadonlySet<AiFeatureId> = new Set<AiFeatureId>([
  'chat',
  'route',
  'query',
  'whatNext',
  'proofread',
  'critique',
  'betaReader',
  'continuity',
  'synopsis',
  'notesSuggest',
  'rewrite'
])

function context(patch: Partial<SuggestionContext> = {}): SuggestionContext {
  return {
    mode: 'auto',
    allowed: EVERYTHING,
    sceneLength: 5_000,
    selection: false,
    synopsisEmpty: false,
    notesEmpty: false,
    characters: [],
    memory: 'v1',
    ...patch
  }
}

describe('assistantSuggestions', () => {
  it('offers nothing while the assistant chat is not allowed', () => {
    expect(assistantSuggestions(context({ allowed: new Set<AiFeatureId>(['query']) }), 0)).toEqual(
      []
    )
  })

  it('offers the scene actions in Auto when a long scene is open', () => {
    const list = assistantSuggestions(context(), 0)
    expect(list).toContain('What happens next here?')
    expect(list).toContain('Proofread this scene')
    expect(list).toContain("Give me editor's notes on this scene")
    expect(list).toContain('How would a beta reader react?')
    expect(list).toContain('Check this scene for continuity slips')
    expect(list).not.toContain('Rewrite the selection tighter')
    expect(list).not.toContain('Suggest a synopsis for this scene')
  })

  it('leaves out what needs a scene when none is open, and what a short scene cannot feed', () => {
    const none = assistantSuggestions(context({ sceneLength: null }), 0)
    expect(none).not.toContain('What happens next here?')
    expect(none).not.toContain('What happened in this scene?')
    expect(none).toContain('What is still unresolved in the story?')
    const short = assistantSuggestions(context({ sceneLength: 50 }), 0)
    expect(short).toContain('What happens next here?')
    expect(short).toContain('Proofread this scene')
    expect(short).not.toContain("Give me editor's notes on this scene")
  })

  it('follows the selection, an empty synopsis, and empty notes', () => {
    const list = assistantSuggestions(
      context({ selection: true, synopsisEmpty: true, notesEmpty: true }),
      0
    )
    expect(list).toContain('Rewrite the selection tighter')
    expect(list).toContain('Suggest a synopsis for this scene')
    expect(list).toContain('Suggest notes for this scene')
  })

  it('drops a feature the dial or its toggle forbids, and routed ones without the router', () => {
    const noProofread = new Set(EVERYTHING)
    noProofread.delete('proofread')
    expect(assistantSuggestions(context({ allowed: noProofread }), 0)).not.toContain(
      'Proofread this scene'
    )
    const noRoute = new Set(EVERYTHING)
    noRoute.delete('route')
    const list = assistantSuggestions(context({ allowed: noRoute }), 0)
    expect(list).not.toContain('What happens next here?')
    expect(list).toContain('What happened in this scene?')
  })

  it('fits each mode: Plan offers only what changes nothing; Ask and Auto may write (2026-10-07)', () => {
    const writing = new Set<AiFeatureId>([...EVERYTHING, 'agent'])
    const plan = assistantSuggestions(context({ mode: 'plan', allowed: writing }), 0)
    expect(plan).toEqual([
      'What happens next here?',
      'Who are the main characters so far?',
      'How would a beta reader react?',
      'What happened in this scene?',
      'What could raise the stakes here?',
      'What is still unresolved in the story?',
      'Talk me through where the story goes'
    ])
    for (const mode of ['ask', 'auto'] as const) {
      const list = assistantSuggestions(context({ mode, allowed: writing }), 0)
      expect(list).toContain('Proofread this scene')
      expect(list).toContain('Continue the scene')
      expect(list).toContain('Write the next beat')
    }
  })

  it('names a character picked by the seed, and skips a name too long to fit', () => {
    const characters = ['Mara', 'Wren']
    expect(assistantSuggestions(context({ characters }), 0)).toContain('What does Mara look like?')
    expect(assistantSuggestions(context({ characters }), 1)).toContain(
      'Where did Wren last appear?'
    )
    expect(assistantSuggestions(context({ characters }), 0)).not.toContain(
      'Who are the main characters so far?'
    )
    const long = assistantSuggestions(context({ characters: ['A'.repeat(40)] }), 0)
    expect(long.some((text) => text.includes('AAAA'))).toBe(false)
    expect(long.every((text) => text.length <= SUGGESTION_MAX_CHARS)).toBe(true)
  })

  it('keeps every suggestion within the length cap', () => {
    const list = assistantSuggestions(
      context({ selection: true, synopsisEmpty: true, notesEmpty: true, characters: ['Mara'] }),
      0
    )
    for (const text of list) expect(text.length).toBeLessThanOrEqual(SUGGESTION_MAX_CHARS)
  })

  it('F-16.24, F-16.25: in story memory v2 offers Ms Scribe’s lookups, gated by her switch and navigator', () => {
    const v2: ReadonlySet<AiFeatureId> = new Set<AiFeatureId>([
      'chat',
      'agent',
      'navigator',
      'whatNext',
      'proofread',
      'critique',
      'continuity'
    ])
    const list = (seed: number): string[] =>
      [0, 1, 2, 3].flatMap((step) =>
        assistantSuggestions(
          context({ memory: 'v2', allowed: v2, characters: ['Mara'] }),
          seed + step
        )
      )
    expect(list(0)).toEqual(
      expect.arrayContaining([
        "Mara's eyes?",
        'When does Mara first appear?',
        'What does Mara know so far?',
        'What were my ideas for Mara?',
        // A question about the book is Ms Scribe's in v2, with no `query` toggle.
        'What does Mara look like?',
        // The navigator routes the scene actions.
        'Proofread this scene'
      ])
    )
    // The consistency check waits for P4 in v2; v1 never sees v2's lookups.
    expect(list(0)).not.toContain('Check this scene for continuity slips')
    expect(
      assistantSuggestions(context({ allowed: EVERYTHING, characters: ['Mara'] }), 0)
    ).not.toContain("Mara's eyes?")
    // Without the navigator, nothing it would route; without Ms Scribe, none of her lookups.
    const noNavigator = new Set<AiFeatureId>([...v2].filter((id) => id !== 'navigator'))
    expect(
      assistantSuggestions(context({ memory: 'v2', allowed: noNavigator }), 0)
    ).not.toContain('Proofread this scene')
    const noAgent = new Set<AiFeatureId>([...v2].filter((id) => id !== 'agent'))
    expect(
      assistantSuggestions(context({ memory: 'v2', allowed: noAgent, characters: ['Mara'] }), 0)
    ).not.toContain("Mara's eyes?")
  })
})
