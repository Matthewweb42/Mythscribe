import { describe, expect, it } from 'vitest'
import { estimateTokens } from './ai'
import {
  AUTHOR_RULES_HEADER,
  AUTHOR_RULES_TEXT_MAX,
  AUTHOR_RULES_TOKEN_BUDGET,
  AuthorRules,
  BANNED_PHRASE_MAX,
  BANNED_PHRASES_MAX,
  DEFAULT_BANNED_PHRASES,
  defaultAuthorRules,
  findBannedPhrases,
  hasAuthorRules,
  normalizeBannedPhrases,
  renderAuthorRulesBlock
} from './authorRules'

describe('AuthorRules schema (F-14.2)', () => {
  it('defaults to no rules text and the seeded phrases, and fills a partial row', () => {
    expect(defaultAuthorRules()).toEqual({ rules: '', bannedPhrases: [...DEFAULT_BANNED_PHRASES] })
    expect(AuthorRules.parse({})).toEqual(defaultAuthorRules())
    expect(AuthorRules.parse({ rules: 'British spelling' })).toEqual({
      rules: 'British spelling',
      bannedPhrases: [...DEFAULT_BANNED_PHRASES]
    })
    expect(AuthorRules.parse({ bannedPhrases: [] })).toEqual({ rules: '', bannedPhrases: [] })
  })

  it('keeps the rules text as typed (a trailing space survives a keystroke) but refuses over-length', () => {
    expect(AuthorRules.parse({ rules: 'No swearing ' }).rules).toBe('No swearing ')
    expect(AuthorRules.safeParse({ rules: 'x'.repeat(AUTHOR_RULES_TEXT_MAX + 1) }).success).toBe(
      false
    )
  })

  it('normalises the phrases: trim, collapse, fold quotes, drop empty and over-length, dedupe case-insensitively, cap', () => {
    expect(
      normalizeBannedPhrases([
        '  a testament   to ',
        'A Testament To',
        '',
        '   ',
        'I couldn’t help but',
        "i couldn't help but",
        'x'.repeat(BANNED_PHRASE_MAX + 1)
      ])
    ).toEqual(['a testament to', "I couldn't help but"])
    const many = Array.from({ length: BANNED_PHRASES_MAX + 5 }, (_, i) => `phrase ${i}`)
    expect(normalizeBannedPhrases(many)).toHaveLength(BANNED_PHRASES_MAX)
    expect(AuthorRules.parse({ bannedPhrases: [' Delve ', 'delve'] }).bannedPhrases).toEqual([
      'Delve'
    ])
  })

  it('the seeded list is itself normalised and under the caps', () => {
    expect(normalizeBannedPhrases(DEFAULT_BANNED_PHRASES)).toEqual([...DEFAULT_BANNED_PHRASES])
    expect(DEFAULT_BANNED_PHRASES.length).toBeLessThan(BANNED_PHRASES_MAX)
  })

  it('hasAuthorRules is false only when both are empty', () => {
    expect(hasAuthorRules({ rules: '', bannedPhrases: [] })).toBe(false)
    expect(hasAuthorRules({ rules: '  ', bannedPhrases: [] })).toBe(false)
    expect(hasAuthorRules({ rules: 'x', bannedPhrases: [] })).toBe(true)
    expect(hasAuthorRules({ rules: '', bannedPhrases: ['delve'] })).toBe(true)
  })
})

describe('findBannedPhrases (F-14.2)', () => {
  it('matches case-insensitively at word boundaries, in order of appearance, each once', () => {
    const text =
      'The tapestry of the night was a testament to her will. She would delve into it; ' +
      'a testament to nothing. Delve, delve.'
    expect(findBannedPhrases(['a testament to', 'delve', 'tapestry'], text)).toEqual([
      'tapestry',
      'a testament to',
      'delve'
    ])
  })

  it('does not match inside a longer word', () => {
    expect(findBannedPhrases(['delve'], 'She delved into the box and undelved it.')).toEqual([])
    expect(findBannedPhrases(['a wave of'], 'a waveform')).toEqual([])
  })

  it('folds curly quotes and whitespace runs on both sides', () => {
    expect(findBannedPhrases(["I couldn't help but"], 'And I couldn’t  help but smile.')).toEqual([
      "I couldn't help but"
    ])
    expect(findBannedPhrases(['I couldn’t help but'], "I couldn't\nhelp but")).toEqual([
      "I couldn't help but"
    ])
  })

  it('treats regex characters in a phrase literally and ignores empty entries', () => {
    expect(findBannedPhrases(['(sic)', ''], 'He wrote (sic) there.')).toEqual(['(sic)'])
    expect(findBannedPhrases(['a.b'], 'aXb')).toEqual([])
  })
})

describe('renderAuthorRulesBlock (F-14.2)', () => {
  it('is null with nothing to send', () => {
    expect(renderAuthorRulesBlock({ rules: '', bannedPhrases: [] })).toBeNull()
    expect(renderAuthorRulesBlock({ rules: '  \n', bannedPhrases: [] })).toBeNull()
  })

  it('renders the header, the trimmed rules text, then the phrases on one line', () => {
    expect(
      renderAuthorRulesBlock({
        rules: '  Mira never swears.\nBritish spelling. ',
        bannedPhrases: ['delve', 'a testament to']
      })
    ).toBe(
      `${AUTHOR_RULES_HEADER}\nMira never swears.\nBritish spelling.\n` +
        'Never use these phrases: delve; a testament to.'
    )
    expect(renderAuthorRulesBlock({ rules: 'British spelling', bannedPhrases: [] })).toBe(
      `${AUTHOR_RULES_HEADER}\nBritish spelling`
    )
    expect(renderAuthorRulesBlock({ rules: '', bannedPhrases: ['delve'] })).toBe(
      `${AUTHOR_RULES_HEADER}\nNever use these phrases: delve.`
    )
  })

  it('carries the whole seeded list within the budget when there is no rules text', () => {
    const block = renderAuthorRulesBlock(defaultAuthorRules())
    expect(block).not.toBeNull()
    expect(estimateTokens(block ?? '')).toBeLessThanOrEqual(AUTHOR_RULES_TOKEN_BUDGET)
    // The last seeded phrase is the sign the whole list went out.
    expect(block).toContain(`${DEFAULT_BANNED_PHRASES.at(-1) ?? ''}.`)
  })

  it('leaves out the phrases that do not fit the budget, in order, and keeps the rules text', () => {
    const phrases = Array.from({ length: 80 }, (_, i) => `banned phrase number ${i}`)
    const block = renderAuthorRulesBlock({
      rules: 'x'.repeat(AUTHOR_RULES_TEXT_MAX),
      bannedPhrases: phrases
    })
    expect(block).not.toBeNull()
    expect(estimateTokens(block ?? '')).toBeLessThanOrEqual(AUTHOR_RULES_TOKEN_BUDGET)
    expect(block).toContain('banned phrase number 0;')
    expect(block).not.toContain('banned phrase number 79')
    expect(block).toContain('x'.repeat(AUTHOR_RULES_TEXT_MAX))
  })
})
