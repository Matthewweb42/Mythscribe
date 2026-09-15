import { describe, expect, it } from 'vitest'
import { AI_ORIGIN_MARK, aiOriginAttrsOf, aiOriginPercent, aiOriginStats } from './provenance'
import type { TiptapNodeT } from './tiptap'

const text = (t: string, proposalId?: string, accepted = t.length): TiptapNodeT =>
  proposalId === undefined
    ? { type: 'text', text: t }
    : { type: 'text', text: t, marks: [{ type: AI_ORIGIN_MARK, attrs: { proposalId, accepted } }] }

const doc = (...paragraphs: TiptapNodeT[][]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((content) => ({ type: 'paragraph', content }))
})

describe('aiOriginStats (F-14.6)', () => {
  it('counts nothing for an empty document', () => {
    expect(aiOriginStats({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual({
      aiChars: 0,
      totalChars: 0,
      byProposal: {}
    })
    expect(aiOriginPercent({ aiChars: 0, totalChars: 0 })).toBe(0)
  })

  it('counts marked characters per proposal and the total across paragraphs', () => {
    const stats = aiOriginStats(
      doc(
        [text('The storm '), text('broke at dusk.', 'p1')],
        [text('Rain ', 'p2', 20), text('followed.'), text(' Then hail.', 'p1')]
      )
    )
    expect(stats.aiChars).toBe(14 + 5 + 11)
    expect(stats.totalChars).toBe(10 + 14 + 5 + 9 + 11)
    expect(stats.byProposal).toEqual({ p1: 25, p2: 5 })
    expect(Object.keys(stats.byProposal)).toEqual(['p1', 'p2'])
    expect(aiOriginPercent(stats)).toBe(61)
  })

  it('ignores inline tag tokens, other marks, and malformed aiOrigin attrs', () => {
    const stats = aiOriginStats(
      doc([
        { type: 'inlineTag', attrs: { id: 't', name: 'dark-forest' } },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'bad', marks: [{ type: AI_ORIGIN_MARK, attrs: { proposalId: '' } }] },
        {
          type: 'text',
          text: 'both',
          marks: [
            { type: 'italic' },
            { type: AI_ORIGIN_MARK, attrs: { proposalId: 'p', accepted: 4 } }
          ]
        }
      ])
    )
    expect(stats).toEqual({ aiChars: 4, totalChars: 11, byProposal: { p: 4 } })
  })

  it('reads attrs only from a well-formed mark', () => {
    expect(aiOriginAttrsOf({ type: 'bold' })).toBeNull()
    expect(
      aiOriginAttrsOf({ type: AI_ORIGIN_MARK, attrs: { proposalId: 'p', accepted: -1 } })
    ).toBeNull()
    expect(
      aiOriginAttrsOf({ type: AI_ORIGIN_MARK, attrs: { proposalId: 'p', accepted: 12 } })
    ).toEqual({
      proposalId: 'p',
      accepted: 12
    })
  })
})
