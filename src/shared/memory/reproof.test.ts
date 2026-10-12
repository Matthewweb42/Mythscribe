import { describe, expect, it } from 'vitest'
import { anchorFor, sceneSentences } from './anchor'
import type { LiteralName } from './literal'
import { locateQuote } from './quote'
import { cardStale, checkAnchors, type ReproofClaim, type ReproofScene } from './reproof'
import { splitSentences } from './sentences'

const PEOPLE = ['Mara', 'Tomas']

function sceneOf(paragraphs: readonly string[]): ReproofScene {
  return {
    paragraphs,
    sentences: sceneSentences(paragraphs),
    names: (p, index) => {
      const text = splitSentences(paragraphs[p] ?? '')[index]?.text ?? ''
      return PEOPLE.flatMap((name): LiteralName[] => {
        const at = text.indexOf(name)
        return at === -1
          ? []
          : [
              {
                recordId: name.toLowerCase(),
                kind: 'character',
                start: at,
                end: at + name.length,
                ambiguous: false
              }
            ]
      })
    }
  }
}

const BEFORE = ['The ridge was cold.', "Mara's eyes were grey. She waited.", 'Tomas came at dusk.']

function claimFrom(
  paragraphs: readonly string[],
  over: Partial<ReproofClaim> & { quote: string; para: number }
): ReproofClaim {
  const location = locateQuote(paragraphs, over.para, over.quote)
  if (!location.ok) throw new Error('quote not found')
  return {
    id: 'c1',
    proof: 'literal',
    state: 'live',
    anchor: [...anchorFor(sceneSentences(paragraphs), location)],
    recordId: 'mara',
    slot: 'eyes',
    value: 'grey',
    voice: 'narration',
    mode: 'now',
    ...over
  }
}

const EYES = claimFrom(BEFORE, { quote: "Mara's eyes were grey", para: 1 })

describe('checkAnchors (F-16.17, design §2.3 Invalidation)', () => {
  it('keeps a claim whose anchor holds', () => {
    expect(checkAnchors([EYES], sceneOf([...BEFORE, 'A new paragraph.']))).toEqual([
      { id: 'c1', verdict: 'holds' }
    ])
  })

  it('re-proves a literal claim for free after an edit beside it: new paragraph, new anchor', () => {
    const after = [
      'A new opening.',
      'The ridge was very cold.',
      "Mara's eyes were grey. She waited.",
      'Tomas came at dusk.'
    ]
    const [verdict] = checkAnchors([EYES], sceneOf(after))
    expect(verdict).toMatchObject({ id: 'c1', verdict: 'reproved', para: 2 })
    if (verdict?.verdict !== 'reproved') return
    expect(verdict.anchor).toEqual([...anchorFor(sceneSentences(after), { p: 2, sentences: [0] })])
  })

  it('stales a literal claim when a changed sentence beside it brings a marker word', () => {
    const after = [
      'The ridge was cold, she dreamt.',
      "Mara's eyes were grey. She waited.",
      'Tomas came at dusk.'
    ]
    expect(checkAnchors([EYES], sceneOf(after))).toEqual([{ id: 'c1', verdict: 'stale' }])
    const negated = [
      'The ridge was cold.',
      "Mara's eyes were grey. She did not wait.",
      'Tomas came at dusk.'
    ]
    expect(checkAnchors([EYES], sceneOf(negated))).toEqual([{ id: 'c1', verdict: 'stale' }])
  })

  it('stales a literal claim whose own sentence no longer proves it', () => {
    const after = [
      'The ridge was cold.',
      "Mara's eyes were grey, Tomas said. She waited.",
      'Tomas came at dusk.'
    ]
    expect(checkAnchors([EYES], sceneOf(after))).toEqual([{ id: 'c1', verdict: 'stale' }])
    const gone = ['The ridge was cold.', 'Her eyes were brown. She waited.', 'Tomas came at dusk.']
    expect(checkAnchors([EYES], sceneOf(gone))).toEqual([{ id: 'c1', verdict: 'stale' }])
  })

  it('never re-proves a verified claim, and leaves stale and waiting claims alone', () => {
    const after = [
      'The ridge was very cold.',
      "Mara's eyes were grey. She waited.",
      'Tomas came at dusk.'
    ]
    const verified = { ...EYES, id: 'c2', proof: 'verified' as const }
    const stale = { ...EYES, id: 'c3', state: 'stale' as const }
    const waiting = { ...EYES, id: 'c4', state: 'waiting' as const }
    expect(checkAnchors([verified, stale, waiting], sceneOf(after))).toEqual([
      { id: 'c2', verdict: 'stale' }
    ])
  })

  it('stales a claim with no anchor at all rather than keeping it for ever', () => {
    expect(checkAnchors([{ ...EYES, proof: 'verified', anchor: [] }], sceneOf(BEFORE))).toEqual([
      { id: 'c1', verdict: 'stale' }
    ])
  })
})

describe('cardStale', () => {
  it('is stale once a card quote’s sentence changed', () => {
    const present = new Set(sceneSentences(BEFORE).map((sentence) => sentence.hash))
    expect(cardStale(EYES.anchor, present)).toBe(false)
    expect(cardStale([...EYES.anchor, 'gone'], present)).toBe(true)
  })
})
