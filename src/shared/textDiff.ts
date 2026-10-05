import type { DiffSegment } from './drafts'

/**
 * Word-level diff of two plain texts (F-8.5 draft compare). Both texts are cut into word and
 * whitespace tokens (`\S+` and `\s+`), the common prefix and suffix are taken off, and the rest
 * goes through Myers' O(ND) shortest edit script. Adjacent tokens with the same op are merged,
 * so the segments are runs and their texts join back verbatim: the `same` and `del` runs give
 * `a`, the `same` and `add` runs give `b`.
 *
 * A middle that needs more than `DIFF_MAX_EDITS` edits (a scene rewritten from scratch) is not
 * searched further: it comes back as one `del` run and one `add` run, which is what such a
 * diff shows anyway, and it bounds the work at about `DIFF_MAX_EDITS²` steps.
 */
export const DIFF_MAX_EDITS = 2000

type Op = DiffSegment['op']

function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? []
}

export function diffWords(a: string, b: string): DiffSegment[] {
  const left = tokenize(a)
  const right = tokenize(b)
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  let endA = left.length
  let endB = right.length
  while (endA > start && endB > start && left[endA - 1] === right[endB - 1]) {
    endA--
    endB--
  }
  const out: DiffSegment[] = []
  const push = (op: Op, text: string): void => {
    if (text.length === 0) return
    const last = out[out.length - 1]
    if (last?.op === op) last.text += text
    else out.push({ op, text })
  }
  push('same', left.slice(0, start).join(''))
  const middleA = left.slice(start, endA)
  const middleB = right.slice(start, endB)
  const script = editScript(middleA, middleB)
  if (script === null) {
    push('del', middleA.join(''))
    push('add', middleB.join(''))
  } else {
    for (const [op, text] of script) push(op, text)
  }
  push('same', left.slice(endA).join(''))
  return out
}

/**
 * Myers' shortest edit script from `a` to `b` as `[op, token]` pairs in order, or null when it
 * needs more than `DIFF_MAX_EDITS` edits. Keeps the furthest-reaching x per diagonal for each
 * edit count d (only diagonals -d..d), then walks back from the end.
 */
function editScript(a: string[], b: string[]): [Op, string][] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, DIFF_MAX_EDITS)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) found = d
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }
  if (found < 0) return null

  const reversed: [Op, string][] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]
    if (prev === undefined) break
    // `prev` holds diagonals -(d-1)..(d-1) at index k + d - 1.
    const at = (k: number): number => prev[k + d - 1] ?? 0
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      reversed.push(['same', a[x - 1] ?? ''])
      x--
      y--
    }
    if (x === prevX) reversed.push(['add', b[y - 1] ?? ''])
    else reversed.push(['del', a[x - 1] ?? ''])
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    reversed.push(['same', a[x - 1] ?? ''])
    x--
    y--
  }
  return reversed.reverse()
}

/**
 * The words in the runs of one op, counted the way `countWords` counts a text leaf (split on
 * whitespace, empty tokens dropped). Runs are whole tokens, so no word is split between two runs.
 */
export function diffWordCount(segments: readonly DiffSegment[], op: Op): number {
  let words = 0
  for (const segment of segments) {
    if (segment.op !== op) continue
    for (const token of segment.text.split(/\s+/)) if (token.length > 0) words += 1
  }
  return words
}
