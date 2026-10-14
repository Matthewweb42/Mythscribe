import { describe, expect, it } from 'vitest'
import {
  findingSideFixture,
  findingsViewFixture,
  findingViewFixture,
  looseEndFixture,
  noteFindingFixture
} from '../memoryFixture'
import {
  CHECK_OFF_LINE,
  CHECK_THE_BOOK_HINT,
  contradictionsScoped,
  contradictionsText,
  contradictionsTurnOf,
  findingInfoLines,
  findingRuleLine,
  noteConflictLine
} from './findingView'
import { looseEndLine, looseEndsMore } from './looseEndView'

/**
 * F-16.27, F-16.29 (plan P4 §4): the words of Needs a look's contradictions and loose ends, and
 * the chat's consistency turn: each rule worded as it finds, a note conflict in the author's terms,
 * ⓘ's lines, and absence only ever in the scoped lines drawn from the turn (rule 5).
 */

const WORDS = /\b(no scene|nothing since|not read|not judged|never|nobody|does not know)\b/iu

describe('a finding in its rule’s words', () => {
  it('words each rule', () => {
    expect(findingRuleLine(findingViewFixture('c1'))).toBe(
      'Mara Vell’s eyes: grey (1.1) · brown (1.2)'
    )
    expect(
      findingRuleLine(
        findingViewFixture('c2', {
          rule: 'C2',
          variant: 'dead',
          name: 'Hobb',
          slot: 'alive',
          slotLabel: 'Alive',
          a: findingSideFixture('dead', '4.3', 'sc-4'),
          b: findingSideFixture('here', '9.1', 'sc-9', { kind: 'presence' })
        })
      )
    ).toBe('Hobb dies in 4.3 and is here in 9.1')
    expect(
      findingRuleLine(
        findingViewFixture('c2b', {
          rule: 'C2',
          variant: 'body',
          slot: 'hair',
          slotLabel: 'Hair',
          a: findingSideFixture('dark', '2.1', 'sc-2'),
          b: findingSideFixture('fair', '5.3', 'sc-5')
        })
      )
    ).toBe('Mara Vell’s hair: dark (2.1) · fair (5.3)')
    expect(
      findingRuleLine(
        findingViewFixture('c3', {
          rule: 'C3',
          name: 'Bel',
          slot: 'knows:s-eng',
          slotLabel: 'Knows: the secret engagement',
          a: findingSideFixture('tells', '5.2', 'sc-5'),
          b: findingSideFixture('overheard', '5.3', 'sc-6')
        })
      )
    ).toBe('Bel passes on the secret engagement in 5.2 before learning it in 5.3')
    expect(
      findingRuleLine(
        findingViewFixture('c4', {
          rule: 'C4',
          variant: 'birth',
          name: 'Lottie',
          slot: 'age',
          slotLabel: 'Age',
          a: findingSideFixture('17', '19.1', 'sc-19'),
          b: findingSideFixture('1795', 'Lottie’s Pinned page', 'sc-0', { kind: 'note' })
        })
      )
    ).toBe('Lottie is 17 in 19.1; born 1795 (Lottie’s Pinned page)')
    // The scene's year the rule rests on, typed in its details or stated in its text.
    const born = findingViewFixture('c4y', {
      rule: 'C4',
      variant: 'birth',
      name: 'Lottie',
      slot: 'age',
      slotLabel: 'Age',
      year: { value: 1810, source: 'typed' },
      a: findingSideFixture('17', '19.1', 'sc-19'),
      b: findingSideFixture('1795', 'Lottie’s Pinned page', 'sc-0', { kind: 'note' })
    })
    expect(findingRuleLine(born)).toBe(
      'Lottie is 17 in 19.1 (year 1810, typed in its details); born 1795 (Lottie’s Pinned page)'
    )
    expect(findingInfoLines({ ...born, year: { value: 1810, source: 'quoted' } })[0]).toBe(
      'Found in code: a stated age against a birth year and that scene’s year (year 1810, stated in its text)'
    )
    expect(
      findingRuleLine(
        findingViewFixture('c4f', {
          rule: 'C4',
          variant: 'falls',
          name: 'Lottie',
          slot: 'age',
          slotLabel: 'Age',
          a: findingSideFixture('18', '3.1', 'sc-3'),
          b: findingSideFixture('16', '5.2', 'sc-5')
        })
      )
    ).toBe('Lottie’s stated age falls: 18 (3.1) · 16 (5.2)')
    expect(
      findingRuleLine(
        findingViewFixture('c5', {
          rule: 'C5',
          name: 'Lottie’s match',
          slot: 'thread',
          slotLabel: 'Thread',
          a: findingSideFixture('resolves', '9.1', 'sc-9'),
          b: findingSideFixture('advances', '19.1', 'sc-19')
        })
      )
    ).toBe('Lottie’s match: resolved in 9.1, advanced again in 19.1')
    expect(findingRuleLine(noteFindingFixture('c6'))).toBe(
      'Your note on Orrin says born 1790; the book says 1792 (1.1)'
    )
    expect(findingRuleLine(findingViewFixture('c7', { rule: 'C7', slotLabel: 'History' }))).toBe(
      'Mara Vell’s history: grey (1.1) · brown (1.2)'
    )
  })

  it('words a note conflict as the author would: green eyes, a Research page', () => {
    const eyes = noteFindingFixture('n', {
      slot: 'eyes',
      slotLabel: 'Eyes',
      a: findingSideFixture('brown', '11.2', 'sc-11'),
      b: { ...noteFindingFixture('x').b, value: 'green' }
    })
    expect(noteConflictLine(eyes)).toBe(
      'Your note on Orrin says green eyes; the book says brown (11.2)'
    )
    const research = noteFindingFixture('r', {
      b: {
        ...noteFindingFixture('x').b,
        ref: 'Harbour notes',
        label: 'Research: Harbour notes',
        open: { kind: 'research', id: 'doc-1', para: 0 }
      }
    })
    // A Research page is no record's own page: the subject is named.
    expect(noteConflictLine(research)).toBe(
      'Your Research page “Harbour notes” says of Orrin: born 1790; the book says 1792 (1.1)'
    )
    // A sentence on another record's Pinned page that names the subject: whose value it is.
    const crossPage = noteFindingFixture('m', {
      recordId: 'r-mara',
      name: 'Mara Vell',
      slot: 'eyes',
      slotLabel: 'Eyes',
      a: findingSideFixture('brown', '1.2', 'sc-2'),
      b: { ...noteFindingFixture('x').b, value: 'green', quote: 'Mara Vell has green eyes.' }
    })
    expect(noteConflictLine(crossPage)).toBe(
      'Your note on Orrin says of Mara Vell: green eyes; the book says brown (1.2)'
    )
    // The chat's text, which later requests carry as history, names her too.
    expect(
      contradictionsText(contradictionsTurnOf(findingsViewFixture({ open: [crossPage] }), 'sc-2'))
    ).toContain('- Your note on Orrin says of Mara Vell: green eyes; the book says brown (1.2)')
    expect(noteConflictLine(findingViewFixture('c1'))).toBeNull()
  })

  it('keeps the other person in a kinship line, and their name as written', () => {
    const kin = findingViewFixture('k', {
      slot: 'kinship:r-orrin',
      slotLabel: 'Family (Orrin)',
      a: findingSideFixture('sister', '1.1', 'sc-1'),
      b: findingSideFixture('cousin', '2.1', 'sc-2')
    })
    expect(findingRuleLine(kin)).toBe('Mara Vell’s family (to Orrin): sister (1.1) · cousin (2.1)')
    expect(findingInfoLines(kin)[0]).toBe('Found in code: two values for family (to Orrin)')
    const note = noteFindingFixture('kn', {
      recordId: 'r-mara',
      name: 'Mara',
      slot: 'kinship:r-orrin',
      slotLabel: 'Family (Orrin)',
      a: findingSideFixture('cousin', '2.1', 'sc-2'),
      b: {
        ...noteFindingFixture('x').b,
        ref: 'Mara',
        value: 'sister',
        open: { kind: 'record', id: 'r-mara', para: 0 }
      }
    })
    expect(noteConflictLine(note)).toBe(
      'Your note on Mara says sister to Orrin; the book says cousin (2.1)'
    )
  })

  it('says how it was found, judged and confirmed, and what it cost', () => {
    expect(findingInfoLines(findingViewFixture('c1'))).toEqual([
      'Found in code: two values for eyes',
      'judged a contradiction both ways by AI',
      'the AI’s reason: grey eyes against brown',
      'judging it cost 0.02¢'
    ])
    expect(findingInfoLines(findingViewFixture('c1', { confirmed: true, why: null }))).toEqual([
      'Found in code: two values for eyes',
      'judged a contradiction both ways by AI',
      'confirmed by a stronger AI read',
      'judging it cost 0.02¢'
    ])
    expect(
      findingInfoLines(findingViewFixture('u', { state: 'unclear', verdictAb: 'u', why: null }))[1]
    ).toBe('the AI judged it twice and the words did not settle it')
    // Both fast orders said contradiction; the stronger check could not settle it.
    expect(findingInfoLines(findingViewFixture('uc', { state: 'unclear', why: null }))[1]).toBe(
      'judged a contradiction both ways by AI; the stronger check could not settle it'
    )
  })
})

describe('the chat’s consistency turn (P4-D23)', () => {
  const here = findingViewFixture('f-here', { b: findingSideFixture('brown', '1.2', 'sc-2') })
  const elsewhere = findingViewFixture('f-else', {
    a: findingSideFixture('grey', '3.1', 'sc-7'),
    b: findingSideFixture('blue', '3.2', 'sc-8')
  })

  it('keeps the scene’s findings, and its text holds positive lines only', () => {
    const turn = contradictionsTurnOf(findingsViewFixture({ open: [here, elsewhere] }), 'sc-2')
    expect(turn.findings.map((each) => each.id)).toEqual(['f-here'])
    expect(contradictionsText(turn)).toBe(
      [
        'Possible contradictions in this scene:',
        '- Mara Vell’s eyes: grey (1.1) · brown (1.2)',
        CHECK_THE_BOOK_HINT
      ].join('\n')
    )
    expect(contradictionsScoped(turn)).toEqual([])
  })

  it('draws absence only as a scoped line, never in the text', () => {
    const none = contradictionsTurnOf(
      findingsViewFixture({ open: [elsewhere], waiting: 2, scene: { read: true, unread: 3 } }),
      'sc-2'
    )
    expect(contradictionsText(none)).toBe(CHECK_THE_BOOK_HINT)
    expect(contradictionsText(none)).not.toMatch(WORDS)
    expect(contradictionsScoped(none)).toEqual([
      'No possible contradictions found in this scene so far.',
      '3 sentences here are not read yet, so not checked.',
      '2 pairs in the book are not judged yet.'
    ])
    const unread = contradictionsTurnOf(
      findingsViewFixture({ scene: { read: false, unread: 0 } }),
      'sc-2'
    )
    expect(contradictionsScoped(unread)).toEqual([
      'This scene has not been read yet, so it has not been checked for contradictions.'
    ])
    const off = contradictionsTurnOf(findingsViewFixture({ on: false }), 'sc-2')
    expect(contradictionsText(off)).toBe(CHECK_OFF_LINE)
    expect(contradictionsScoped(off)).toEqual([])
  })
})

describe('loose ends’ scoped words (F-16.29)', () => {
  it('words each kind, and the ask stays the loose end’s own positive question', () => {
    expect(looseEndLine(looseEndFixture())).toBe(
      'Planned “The duel at dawn” sits before 1.2 and is not drafted'
    )
    expect(
      looseEndLine(
        looseEndFixture({
          kind: 'thread',
          id: 't-ashby',
          name: 'Ashby’s return',
          lastRef: '7.3',
          lastNodeId: 'sc-7',
          horizonRef: '18.2'
        })
      )
    ).toBe('Ashby’s return: last moved in 7.3, nothing since (checked up to 18.2)')
    expect(
      looseEndLine(
        looseEndFixture({
          kind: 'character',
          id: 'r-orrin',
          name: 'Orrin',
          lastRef: '6.2',
          lastNodeId: 'sc-6'
        })
      )
    ).toBe('Orrin: last named in 6.2')
    expect(looseEndFixture().ask).not.toMatch(WORDS)
    expect(looseEndsMore(0)).toBeNull()
    expect(looseEndsMore(3)).toBe('+ 3 more')
  })
})
