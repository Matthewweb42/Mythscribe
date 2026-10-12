import { describe, expect, it } from 'vitest'
import { CLAIM_MODES, CLAIM_VOICES } from './claims'
import {
  FROM_HOWS,
  HOLDS,
  HOW_LABEL,
  KNOWS_HOWS,
  LEARNS,
  PARTIAL,
  keepsFrom,
  knowsCounts,
  knowsLine,
  knowsNotRightSlot,
  learnerHere,
  parseHow,
  type KnowsLineInput
} from './knows'

const line = (over: Partial<KnowsLineInput> = {}): KnowsLineInput => ({
  how: 'overheard',
  voice: 'narration',
  mode: 'now',
  recordId: 'lise',
  speakerId: null,
  fromId: 'lottie',
  ...over
})

describe('the knows vocabulary (F-16.22)', () => {
  it('splits the ten hows into learning, holding and half-knowing, with labels', () => {
    expect([...LEARNS, ...HOLDS, ...PARTIAL].sort()).toEqual([...KNOWS_HOWS].sort())
    expect(new Set([...LEARNS, ...HOLDS, ...PARTIAL]).size).toBe(KNOWS_HOWS.length)
    expect(FROM_HOWS).toEqual(['told', 'overheard', 'read'])
    expect(HOW_LABEL.believesFalse).toBe('believes otherwise')
    expect(HOW_LABEL.knewBefore).toBe('knew before')
    expect(keepsFrom('told')).toBe(true)
    expect(keepsFrom('saw')).toBe(false)
  })

  it('reads a how leniently and refuses an unknown one', () => {
    expect(parseHow('overheard')).toBe('overheard')
    expect(parseHow('believes-false')).toBe('believesFalse')
    expect(parseHow('Knew before')).toBe('knewBefore')
    expect(parseHow('knew_before')).toBe('knewBefore')
    expect(parseHow('guessed')).toBeNull()
    expect(parseHow(null)).toBeNull()
  })

  it('keys a knows line’s Not right by the secret', () => {
    expect(knowsNotRightSlot('s1')).toBe('knows:s1')
  })
})

describe('knowsCounts (P2b-D7)', () => {
  it('counts narration and thought in now or memory, for every learning and holding how', () => {
    for (const how of [...LEARNS, ...HOLDS]) {
      for (const voice of ['narration', 'thought'] as const) {
        for (const mode of ['now', 'memory'] as const) {
          expect(knowsCounts(line({ how, voice, mode })), `${how} ${voice} ${mode}`).toBe(true)
        }
      }
    }
  })

  it('never counts a rumour, a hypothetical or a dream', () => {
    for (const how of KNOWS_HOWS) {
      for (const voice of CLAIM_VOICES) {
        for (const mode of CLAIM_MODES) {
          if (voice !== 'rumour' && (mode === 'now' || mode === 'memory')) continue
          expect(knowsCounts(line({ how, voice, mode, speakerId: 'lise' })), how).toBe(false)
        }
      }
    }
    expect(knowsLine(line({ voice: 'rumour' }))).toBe('other')
    expect(knowsLine(line({ mode: 'dream' }))).toBe('other')
    expect(knowsLine(line({ mode: 'hypothetical' }))).toBe('other')
  })

  it('shows suspects and believes otherwise as partial, never as knowing', () => {
    for (const how of PARTIAL) {
      expect(knowsLine(line({ how }))).toBe('partial')
      expect(knowsCounts(line({ how }))).toBe(false)
    }
    // A partial line in a rumour is no line at all; in the knower's own words it is partial.
    expect(knowsLine(line({ how: 'suspects', voice: 'rumour' }))).toBe('other')
    expect(
      knowsLine(line({ how: 'suspects', voice: 'dialogue', recordId: 'jo', speakerId: 'jo' }))
    ).toBe('partial')
    expect(
      knowsLine(line({ how: 'suspects', voice: 'dialogue', recordId: 'jo', speakerId: 'lise' }))
    ).toBe('other')
  })

  it('counts dialogue spoken by the knower holding it, or by the source the learner heard', () => {
    // Bel tells Clara: Bel speaks, Bel tells.
    expect(
      knowsCounts(line({ how: 'tells', voice: 'dialogue', recordId: 'bel', speakerId: 'bel' }))
    ).toBe(true)
    expect(
      knowsCounts(line({ how: 'refers', voice: 'dialogue', recordId: 'bel', speakerId: 'bel' }))
    ).toBe(true)
    // Clara is told by Bel: Bel (the source) speaks.
    expect(
      knowsCounts(
        line({ how: 'told', voice: 'dialogue', recordId: 'clara', speakerId: 'bel', fromId: 'bel' })
      )
    ).toBe(true)
    // Someone else speaking proves nothing about Clara.
    expect(
      knowsCounts(
        line({
          how: 'told',
          voice: 'dialogue',
          recordId: 'clara',
          speakerId: 'pocock',
          fromId: 'bel'
        })
      )
    ).toBe(false)
    // The knower speaking a learning how is not one of the holding hows.
    expect(
      knowsCounts(line({ how: 'saw', voice: 'dialogue', recordId: 'lise', speakerId: 'lise' }))
    ).toBe(false)
    // Dialogue with no speaker never counts.
    expect(knowsCounts(line({ how: 'tells', voice: 'dialogue', speakerId: null }))).toBe(false)
  })

  it('never counts a line with no knower or an unknown how', () => {
    expect(knowsLine(line({ recordId: null }))).toBe('other')
    expect(knowsLine(line({ how: 'guessed' }))).toBe('other')
  })
})

describe('learnerHere (P2b-D8)', () => {
  const here = new Set(['lise', 'johanna'])

  it('needs a character to be Here and exempts a group', () => {
    expect(learnerHere('lise', here, 'character')).toBe(true)
    expect(learnerHere('mrs-harrow', here, 'character')).toBe(false)
    expect(learnerHere('regiment', here, 'group')).toBe(true)
  })

  it('takes no place, thing, term, secret or thread as a knower', () => {
    for (const kind of ['place', 'thing', 'term', 'secret', 'thread'] as const) {
      expect(learnerHere('lise', here, kind)).toBe(false)
    }
    expect(learnerHere('lise', here, null)).toBe(false)
  })
})
