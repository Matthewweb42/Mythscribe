import { describe, expect, it } from 'vitest'
import {
  citedSceneNumbers,
  QueryCitation,
  QueryTurn,
  QUERY_QUOTE_MAX,
  stripDanglingMarkers
} from './query'

describe('query model (F-5.7)', () => {
  it('lists the scene numbers an answer cites, first appearance first, deduplicated', () => {
    expect(citedSceneNumbers('She waited [2]. He never came [1] [2]. [0] [x]')).toEqual([2, 1])
    expect(citedSceneNumbers('No markers here.')).toEqual([])
  })

  it('strips the markers whose scene has no surviving citation and keeps the rest', () => {
    expect(stripDanglingMarkers('She waited [2]. He never came [1] [3].', [1])).toBe(
      'She waited. He never came [1].'
    )
    expect(stripDanglingMarkers('[3]', [])).toBe('')
  })

  it('caps a citation quote and refuses an empty one', () => {
    const base = { nodeId: 'n1', title: 'Chapter 1 › Scene 1', scene: 1 }
    expect(QueryCitation.safeParse({ ...base, quote: 'a'.repeat(QUERY_QUOTE_MAX) }).success).toBe(
      true
    )
    expect(
      QueryCitation.safeParse({ ...base, quote: 'a'.repeat(QUERY_QUOTE_MAX + 1) }).success
    ).toBe(false)
    expect(QueryCitation.safeParse({ ...base, quote: '' }).success).toBe(false)
  })

  it('parses a query turn', () => {
    const turn = {
      found: true,
      uncited: false,
      citations: [{ nodeId: 'n1', title: 'Scene 1', scene: 1, quote: 'The rope hung slack.' }],
      also: [{ nodeId: 'n2', title: 'Scene 2' }]
    }
    // A turn saved before query.v3 has no `sheets`; it reads as none.
    expect(QueryTurn.parse(turn)).toEqual({ ...turn, sheets: [] })
    const withSheet = {
      ...turn,
      sheets: [{ entityId: 'e1', name: 'Mara', kind: 'character' }]
    }
    expect(QueryTurn.parse(withSheet)).toEqual(withSheet)
  })
})
