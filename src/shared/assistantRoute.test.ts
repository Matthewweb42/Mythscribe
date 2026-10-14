import { describe, expect, it } from 'vitest'
import {
  localRoute,
  memoryLocalRoute,
  ROUTE_ACTIONS,
  routeActionFeature,
  settleRoute,
  type RouteDecision
} from './assistantRoute'

const open = { hasNode: true, hasSelection: true }
const scene = { hasNode: true, hasSelection: false }
const closed = { hasNode: false, hasSelection: false }
const plain = (
  action: RouteDecision['action'],
  instruction: string | null = null
): RouteDecision => ({
  action,
  instruction,
  edit: null
})

describe('settleRoute (F-5.19)', () => {
  it('keeps a decision the situation allows', () => {
    expect(settleRoute(plain('rewrite', 'colder'), open)).toEqual(plain('rewrite', 'colder'))
    expect(settleRoute(plain('query'), closed)).toEqual(plain('query'))
  })

  it('sends every scene action without a document to chat', () => {
    for (const action of ROUTE_ACTIONS) {
      const settled = settleRoute(plain(action), closed)
      expect(settled.action).toBe(action === 'query' ? 'query' : 'chat')
    }
  })

  it('drops an edit a non-edit decision carries', () => {
    expect(
      settleRoute(
        {
          action: 'critique',
          instruction: null,
          edit: { pass: 'line', target: 'scene', chapter: null }
        },
        open
      )
    ).toEqual(plain('critique'))
  })
})

describe('settleRoute for edit passes (F-5.26)', () => {
  it('turns a rewrite without a selection into an edit pass on the open scene', () => {
    expect(settleRoute(plain('rewrite', 'Make it darker.'), scene)).toEqual({
      action: 'editPass',
      instruction: 'Make it darker.',
      edit: { pass: 'custom', target: 'scene', chapter: null }
    })
    expect(settleRoute(plain('rewrite'), scene)).toEqual({
      action: 'editPass',
      instruction: null,
      edit: { pass: 'ask', target: 'scene', chapter: null }
    })
    expect(settleRoute(plain('rewrite', 'x'), closed)).toEqual(plain('chat'))
  })

  it('asks on the selection, or the scene, when the decision names no pass', () => {
    expect(settleRoute(plain('editPass'), open).edit).toEqual({
      pass: 'ask',
      target: 'selection',
      chapter: null
    })
    expect(settleRoute(plain('editPass'), scene).edit).toEqual({
      pass: 'ask',
      target: 'scene',
      chapter: null
    })
  })

  it('reads a selection target without a selection as the scene, and keeps a chapter only for a chapter', () => {
    expect(
      settleRoute(
        {
          action: 'editPass',
          instruction: null,
          edit: { pass: 'line', target: 'selection', chapter: 'x' }
        },
        scene
      ).edit
    ).toEqual({ pass: 'line', target: 'scene', chapter: null })
  })

  it('asks instead of running a custom pass with no instruction', () => {
    expect(
      settleRoute(
        {
          action: 'editPass',
          instruction: null,
          edit: { pass: 'custom', target: 'scene', chapter: null }
        },
        scene
      ).edit?.pass
    ).toBe('ask')
  })

  it('needs an open document unless it names a chapter', () => {
    expect(
      settleRoute(
        {
          action: 'editPass',
          instruction: null,
          edit: { pass: 'proofread', target: 'chapter', chapter: null }
        },
        closed
      )
    ).toEqual(plain('chat'))
    expect(
      settleRoute(
        {
          action: 'editPass',
          instruction: null,
          edit: { pass: 'proofread', target: 'chapter', chapter: 'Chapter 3' }
        },
        closed
      )
    ).toEqual({
      action: 'editPass',
      instruction: null,
      edit: { pass: 'proofread', target: 'chapter', chapter: 'Chapter 3' }
    })
  })
})

describe('localRoute (F-5.19)', () => {
  it('routes a message with no letters or digits to chat without a request', () => {
    expect(localRoute('  ?!  ', open)).toEqual(plain('chat'))
    expect(localRoute('…', open)).toEqual(plain('chat'))
  })

  it('routes an exact action or quick-action id, any case, trailing punctuation ignored', () => {
    expect(localRoute('Proofread', open)).toEqual(plain('proofread'))
    expect(localRoute('whatnext?', open)).toEqual(plain('whatNext'))
    expect(localRoute('Beta Reader.', open)).toEqual(plain('betaReader'))
    expect(localRoute('recap', open)).toEqual(plain('query'))
    expect(localRoute('synopsis', open)).toEqual(plain('synopsis'))
  })

  it('still applies the fallbacks to a local decision', () => {
    expect(localRoute('rewrite', scene)).toEqual({
      action: 'editPass',
      instruction: null,
      edit: { pass: 'ask', target: 'scene', chapter: null }
    })
    expect(localRoute('notes', closed)).toEqual(plain('chat'))
  })

  it('leaves anything else to the model', () => {
    expect(localRoute('Proofread this please', open)).toBeNull()
    expect(localRoute('Who is Tomas?', open)).toBeNull()
  })
})

describe('the consistency check in each story memory (F-16.4, P4-D23)', () => {
  it('stays continuity in both: v2 answers it from the findings, v1 runs continuity.v2', () => {
    expect(localRoute('continuity', open)).toEqual(plain('continuity'))
    expect(settleRoute(plain('continuity', 'the boat'), open)).toEqual(
      plain('continuity', 'the boat')
    )
    expect(routeActionFeature('continuity', 'v2')).toBe('judge')
    expect(routeActionFeature('continuity', 'v1')).toBe('continuity')
  })
})

describe('memoryLocalRoute (story memory v2, P4-D23)', () => {
  it('takes the consistency check’s own words, any case and end, and leaves v1’s router alone', () => {
    expect(memoryLocalRoute('Check this scene for consistency', open)).toEqual(plain('continuity'))
    expect(memoryLocalRoute('  check THIS scene for continuity slips! ', open)).toEqual(
      plain('continuity')
    )
    expect(memoryLocalRoute('Check consistency', open)).toEqual(plain('continuity'))
    // Without an open scene it falls back as any scene action does.
    expect(memoryLocalRoute('Check this scene for consistency', closed)).toEqual(plain('chat'))
    // localRoute's own decisions stand; anything else is the navigator's.
    expect(memoryLocalRoute('Proofread', open)).toEqual(plain('proofread'))
    expect(memoryLocalRoute('Check this scene for consistency with the map', open)).toBeNull()
    expect(localRoute('Check this scene for consistency', open)).toBeNull()
  })
})

describe('routeActionFeature (F-16.25, P3-D17)', () => {
  it('gates chat and questions by Ms Scribe (agent) in v2, and keeps every feature in v1', () => {
    expect(routeActionFeature('chat', 'v2')).toBe('agent')
    expect(routeActionFeature('query', 'v2')).toBe('agent')
    expect(routeActionFeature('chat', 'v1')).toBe('chat')
    expect(routeActionFeature('query', 'v1')).toBe('query')
    for (const action of ROUTE_ACTIONS.filter(
      (each) => each !== 'chat' && each !== 'query' && each !== 'continuity'
    )) {
      expect(routeActionFeature(action, 'v2')).toBe(routeActionFeature(action, 'v1'))
    }
    expect(routeActionFeature('notes', 'v2')).toBe('notesSuggest')
    expect(routeActionFeature('editPass', 'v2')).toBe('editPass')
  })
})
