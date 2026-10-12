import { describe, expect, it } from 'vitest'
import { emptyCardFields, type CardFields } from './claims'
import { emptySceneDetails, type SceneDetails } from './sceneDetails'
import { compareTyped, effectiveSceneLine, foldDetail, type TypedNames } from './typedVsText'

const NAMES: TypedNames = {
  nameOf: (id) => ({ mara: 'Mara Vell', tomas: 'Tomas', quay: 'Gull Quay' })[id] ?? null,
  aliasesOf: (id) => ({ mara: ['Mara'], quay: ['the quay', 'Gull Quay'] })[id] ?? []
}

const field = (value: string, verified = true): CardFields['where'] => ({
  value,
  quote: `quote of ${value}`,
  p: 0,
  verified
})

const details = (over: Partial<SceneDetails>): SceneDetails => ({ ...emptySceneDetails(), ...over })
const card = (over: Partial<CardFields>): CardFields => ({ ...emptyCardFields(), ...over })

describe('compareTyped (decision 4, F-16.18)', () => {
  it('compares the POV: same, text only, typed only, differs; an unverified POV never counts', () => {
    expect(
      compareTyped(details({ povRecordId: 'mara' }), card({ pov: field('mara') }), NAMES).pov
        .outcome
    ).toBe('same')
    expect(compareTyped(details({}), card({ pov: field('mara') }), NAMES).pov).toMatchObject({
      outcome: 'textOnly',
      text: 'Mara Vell'
    })
    expect(compareTyped(details({ povRecordId: 'mara' }), null, NAMES).pov).toMatchObject({
      outcome: 'typedOnly',
      typed: 'Mara Vell'
    })
    expect(
      compareTyped(details({ povRecordId: 'tomas' }), card({ pov: field('mara') }), NAMES).pov
    ).toMatchObject({
      outcome: 'differs',
      typed: 'Tomas',
      text: 'Mara Vell',
      quote: 'quote of mara'
    })
    expect(compareTyped(details({}), card({ pov: field('mara', false) }), NAMES).pov.outcome).toBe(
      'none'
    )
  })

  it('counts a place or time from the text only when its value is words of its quote (or verified)', () => {
    const typed = details({
      place: { recordId: null, text: 'the harbour' },
      time: { text: 'dawn' }
    })
    // The reader paraphrased: the quote says "down by the boats", the value says "the quay".
    const paraphrase = card({
      where: { value: 'the quay', quote: 'She went down by the boats', p: 0, verified: false },
      when: { value: 'evening', quote: 'as the light went', p: 0, verified: false }
    })
    const compared = compareTyped(typed, paraphrase, NAMES)
    expect(compared.place).toMatchObject({ outcome: 'typedOnly', text: null })
    expect(compared.time).toMatchObject({ outcome: 'typedOnly', text: null })
    expect(effectiveSceneLine(compared)).toMatchObject({
      place: 'the harbour',
      time: 'dawn',
      fromText: []
    })
    // Verified by the second read, it counts even in other words.
    const verified = card({
      where: { value: 'the quay', quote: 'She went down by the boats', p: 0, verified: true }
    })
    expect(compareTyped(typed, verified, NAMES).place.outcome).toBe('differs')
  })

  it('reads a POV whose record is gone as no POV, so the typed one stands', () => {
    const compared = compareTyped(
      details({ povRecordId: 'tomas' }),
      card({ pov: field('gone') }),
      NAMES
    )
    expect(compared.pov).toMatchObject({ outcome: 'typedOnly', typed: 'Tomas', text: null })
    expect(effectiveSceneLine(compared).pov).toBe('Tomas')
  })

  it('compares the place by the record’s names or the typed text, articles and case folded', () => {
    const typedQuay = details({ place: { recordId: 'quay', text: '' } })
    expect(
      compareTyped(typedQuay, card({ where: field('on the Quay', false) }), NAMES).place.outcome
    ).toBe('same')
    expect(
      compareTyped(
        details({ place: { recordId: null, text: 'the harbour' } }),
        card({ where: field('the Harbour') }),
        NAMES
      ).place.outcome
    ).toBe('same')
    expect(
      compareTyped(
        details({ place: { recordId: null, text: 'the harbour' } }),
        card({ where: field('the quay') }),
        NAMES
      ).place
    ).toMatchObject({
      outcome: 'differs',
      typed: 'the harbour',
      text: 'the quay'
    })
    expect(compareTyped(details({}), card({ where: field('the quay') }), NAMES).place.outcome).toBe(
      'textOnly'
    )
    expect(compareTyped(typedQuay, null, NAMES).place).toMatchObject({
      outcome: 'typedOnly',
      typed: 'Gull Quay'
    })
    expect(compareTyped(details({}), null, NAMES).place.outcome).toBe('none')
  })

  it('compares the time by words and the year by number', () => {
    expect(
      compareTyped(
        details({ time: { text: 'December' } }),
        card({ when: field('a cold December evening') }),
        NAMES
      ).time.outcome
    ).toBe('same')
    expect(
      compareTyped(details({ time: { text: 'June' } }), card({ when: field('December') }), NAMES)
        .time.outcome
    ).toBe('differs')
    expect(compareTyped(details({ time: { text: 'June' } }), null, NAMES).time.outcome).toBe(
      'typedOnly'
    )
    expect(compareTyped(details({}), card({ when: field('dawn') }), NAMES).time.outcome).toBe(
      'textOnly'
    )
    expect(
      compareTyped(details({ storyYear: 1812 }), card({ year: field('1812') }), NAMES).year.outcome
    ).toBe('same')
    expect(
      compareTyped(details({ storyYear: 1812 }), card({ year: field('1814') }), NAMES).year.outcome
    ).toBe('differs')
    expect(
      compareTyped(details({}), card({ year: field('1814', false) }), NAMES).year.outcome
    ).toBe('none')
    expect(compareTyped(details({ storyYear: 1812 }), null, NAMES).year.outcome).toBe('typedOnly')
  })

  it('gives the effective scene line: the text where it says something else, the typed words otherwise', () => {
    const comparison = compareTyped(
      details({
        povRecordId: 'tomas',
        place: { recordId: null, text: 'the harbour' },
        time: { text: 'December' },
        storyYear: 1812
      }),
      card({ pov: field('mara'), where: field('the quay'), when: field('December') }),
      NAMES
    )
    expect(effectiveSceneLine(comparison)).toEqual({
      pov: 'Mara Vell',
      place: 'the quay',
      time: 'December',
      year: '1812',
      fromText: ['pov', 'place']
    })
    expect(foldDetail('  The   Old-Quay! ')).toBe('old quay')
  })
})
