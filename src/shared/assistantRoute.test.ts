import { describe, expect, it } from 'vitest'
import { localRoute, ROUTE_ACTIONS, settleRoute } from './assistantRoute'

const open = { hasNode: true, hasSelection: true }
const closed = { hasNode: false, hasSelection: false }

describe('settleRoute (F-5.19)', () => {
  it('keeps a decision the situation allows', () => {
    expect(settleRoute({ action: 'rewrite', instruction: 'colder' }, open)).toEqual({
      action: 'rewrite',
      instruction: 'colder'
    })
    expect(settleRoute({ action: 'query', instruction: null }, closed)).toEqual({
      action: 'query',
      instruction: null
    })
  })

  it('sends a rewrite without a selection, and every scene action without a document, to chat', () => {
    expect(
      settleRoute({ action: 'rewrite', instruction: 'x' }, { hasNode: true, hasSelection: false })
    ).toEqual({ action: 'chat', instruction: null })
    for (const action of ROUTE_ACTIONS) {
      const settled = settleRoute({ action, instruction: null }, closed)
      expect(settled.action).toBe(action === 'query' ? 'query' : 'chat')
    }
  })
})

describe('localRoute (F-5.19)', () => {
  it('routes a message with no letters or digits to chat without a request', () => {
    expect(localRoute('  ?!  ', open)).toEqual({ action: 'chat', instruction: null })
    expect(localRoute('…', open)).toEqual({ action: 'chat', instruction: null })
  })

  it('routes an exact action or quick-action id, any case, trailing punctuation ignored', () => {
    expect(localRoute('Proofread', open)).toEqual({ action: 'proofread', instruction: null })
    expect(localRoute('whatnext?', open)).toEqual({ action: 'whatNext', instruction: null })
    expect(localRoute('Beta Reader.', open)).toEqual({ action: 'betaReader', instruction: null })
    expect(localRoute('recap', open)).toEqual({ action: 'query', instruction: null })
    expect(localRoute('synopsis', open)).toEqual({ action: 'synopsis', instruction: null })
  })

  it('still applies the fallbacks to a local decision', () => {
    expect(localRoute('rewrite', { hasNode: true, hasSelection: false })).toEqual({
      action: 'chat',
      instruction: null
    })
    expect(localRoute('notes', closed)).toEqual({ action: 'chat', instruction: null })
  })

  it('leaves anything else to the model', () => {
    expect(localRoute('Proofread this please', open)).toBeNull()
    expect(localRoute('Who is Tomas?', open)).toBeNull()
  })
})
