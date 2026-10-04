import { straightenQuotes } from './critique'
import { findInRun, isWholeWordAt, normalizeReplaceQuery, REPLACE_QUERY_MAX } from './replace'

/**
 * Find and replace in the open document (F-3.10): the options, and the pure matching and
 * replacement-expansion rules the editor's `FindReplace` extension applies to each run of text.
 *
 * Literal mode is exactly project-wide replace (F-10.2): `findInRun` (NFC query, straight and
 * curly quotes alike, case folded unless Match case, the same whole-word boundary). Regex mode is
 * a JavaScript regular expression over the same quote-straightened text (one character for one,
 * so offsets hold); zero-length matches are skipped and Whole word applies the F-10.2 boundary.
 */
export interface FindOptions {
  query: string
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
}

/** What a regex match captured, read from the text as it stands (curly quotes kept). */
export interface FindGroups {
  /** `$&` at index 0, then `$1`, `$2`, …; a group that did not take part is undefined. */
  numbered: readonly (string | undefined)[]
  /** `$<name>`; absent when the pattern names no group. */
  named?: Readonly<Record<string, string | undefined>>
}

/** One occurrence as offsets into the run's text; regex matches carry their captures. */
export interface FindMatch {
  from: number
  to: number
  groups?: FindGroups
}

export type CompiledFind =
  { ok: true; find: (text: string) => FindMatch[] } | { ok: false; error: string }

export const INVALID_PATTERN = 'Invalid pattern'
export const PATTERN_TOO_LONG = 'Too long'

const NOTHING: CompiledFind = { ok: true, find: () => [] }

/** The index after the character at `at`: two code units for a surrogate pair. */
function stepPast(text: string, at: number): number {
  const code = text.codePointAt(at)
  return at + (code !== undefined && code > 0xffff ? 2 : 1)
}

/** The captures of `match`, sliced from `text` by the `d` flag's indices. */
function groupsOf(text: string, match: RegExpExecArray): FindGroups {
  const indices = match.indices
  const slice = (range: [number, number] | undefined): string | undefined =>
    range === undefined ? undefined : text.slice(range[0], range[1])
  const numbered = match.map((_, index) => slice(indices?.[index]))
  const namedIndices = indices?.groups
  if (namedIndices === undefined) return { numbered }
  const named: Record<string, string | undefined> = {}
  for (const [name, range] of Object.entries(namedIndices)) named[name] = slice(range)
  return { numbered, named }
}

/**
 * The options as a matcher, or why they cannot be one. An empty query finds nothing; a pattern
 * the regex engine rejects is `Invalid pattern` and finds nothing either.
 */
export function compileFind(options: FindOptions): CompiledFind {
  const query = normalizeReplaceQuery(options.query)
  if (query.length === 0) return NOTHING
  if (query.length > REPLACE_QUERY_MAX) return { ok: false, error: PATTERN_TOO_LONG }
  if (!options.regex) {
    return {
      ok: true,
      find: (text) => findInRun(text, options).map(([from, to]) => ({ from, to }))
    }
  }
  let pattern: RegExp
  try {
    pattern = new RegExp(straightenQuotes(query), options.matchCase ? 'dgu' : 'dgiu')
  } catch {
    return { ok: false, error: INVALID_PATTERN }
  }
  return {
    ok: true,
    find: (text) => {
      const haystack = straightenQuotes(text)
      const found: FindMatch[] = []
      pattern.lastIndex = 0
      let match = pattern.exec(haystack)
      while (match !== null) {
        const from = match.index
        const to = from + match[0].length
        if (from === to) {
          pattern.lastIndex = stepPast(haystack, to)
        } else if (options.wholeWord && !isWholeWordAt(text, from, to)) {
          // As in `findInRun`: a later candidate overlapping this one is still found.
          pattern.lastIndex = stepPast(haystack, from)
        } else {
          found.push({ from, to, groups: groupsOf(text, match) })
        }
        if (pattern.lastIndex > haystack.length) break
        match = pattern.exec(haystack)
      }
      return found
    }
  }
}

const DIGIT = /[0-9]/

/**
 * The text a match is replaced with. Literal mode takes `replacement` as typed. Regex mode
 * expands `$&` (the match), `$1`–`$99` (two digits when that group exists, else one), `$<name>`
 * (when the pattern names groups), and `$$` (a dollar), as `String.prototype.replace` does; a
 * group that did not take part is empty and any other `$` stays as typed.
 */
export function expandReplacement(replacement: string, match: FindMatch, regex: boolean): string {
  const groups = match.groups
  if (!regex || groups === undefined || !replacement.includes('$')) return replacement
  const count = groups.numbered.length - 1
  let out = ''
  let at = 0
  while (at < replacement.length) {
    const char = replacement.charAt(at)
    const next = replacement.charAt(at + 1)
    if (char !== '$' || at + 1 >= replacement.length) {
      out += char
      at++
    } else if (next === '$') {
      out += '$'
      at += 2
    } else if (next === '&') {
      out += groups.numbered[0] ?? ''
      at += 2
    } else if (DIGIT.test(next)) {
      const two = replacement.charAt(at + 2)
      const twoDigit = DIGIT.test(two) ? Number(next + two) : 0
      const oneDigit = Number(next)
      if (twoDigit >= 1 && twoDigit <= count) {
        out += groups.numbered[twoDigit] ?? ''
        at += 3
      } else if (oneDigit >= 1 && oneDigit <= count) {
        out += groups.numbered[oneDigit] ?? ''
        at += 2
      } else {
        out += char
        at++
      }
    } else if (next === '<' && groups.named !== undefined) {
      const close = replacement.indexOf('>', at + 2)
      if (close === -1) {
        out += char
        at++
      } else {
        out += groups.named[replacement.slice(at + 2, close)] ?? ''
        at = close + 1
      }
    } else {
      out += char
      at++
    }
  }
  return out
}
