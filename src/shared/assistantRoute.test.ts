import { describe, expect, it } from 'vitest'
import { localRoute, ROUTE_ACTIONS, settleRoute, type RouteDecision } from './assistantRoute'

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
