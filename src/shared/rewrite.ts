/**
 * Rewrite in my voice (F-14.10): the limits the IPC contract, the prompt, and the toolbar
 * button share, and the word-level diff the proposal panel renders. One owner, so the
 * data-sharing line ("up to 4,000 characters, 300 of context each side") stays true.
 */

/** Characters of plain text a selection needs before it can be rewritten (a short sentence). */
export const REWRITE_TEXT_MIN = 20
/** Characters of plain text a selection may hold (~1,000 tokens); over it the button says so. */
export const REWRITE_TEXT_MAX = 4_000
/** Manuscript text sent before and after the selection, each, so the rewrite keeps its seams. */
export const REWRITE_CONTEXT_CHARS = 300

export interface DiffSegment {
  kind: 'equal' | 'del' | 'ins'
  text: string
}

/** Words and the whitespace/punctuation runs between them; joining the tokens gives the text back. */
const TOKEN = /[\p{L}\p{N}'’]+|[^\p{L}\p{N}'’]+/gu

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

/**
 * A word-level diff of `before` against `after` (longest common subsequence over words and
 * the runs between them), for the rewrite panel: `equal` text is shown as is, `del` struck
 * through, `ins` highlighted. At a change point deletions come before insertions, and
 * adjacent segments of one kind are merged, so the output is as short as the change. Pure and
 * dependency-free; a 4,000-character passage is under a thousand tokens each side.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before)
  const b = tokenize(after)
  const n = a.length
  const m = b.length
  // lcs[i][j] = length of the LCS of a[i..] and b[j..], as one flat (n+1)×(m+1) table.
  const width = m + 1
  const lcs = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0)
    }
  }
  const segments: DiffSegment[] = []
  const push = (kind: DiffSegment['kind'], text: string): void => {
    const last = segments[segments.length - 1]
    if (last?.kind === kind) last.text += text
    else segments.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      push('equal', a[i] ?? '')
      i++
      j++
    } else if (j >= m || (i < n && (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))) {
      push('del', a[i] ?? '')
      i++
    } else {
      push('ins', b[j] ?? '')
      j++
    }
  }
  return orderChanges(segments)
}

/** Within each run of changes, every `del` precedes every `ins`, so a replaced word reads old-then-new. */
function orderChanges(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = []
  let run: DiffSegment[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const del = run.filter((s) => s.kind === 'del').map((s) => s.text).join('')
    const ins = run.filter((s) => s.kind === 'ins').map((s) => s.text).join('')
    if (del) out.push({ kind: 'del', text: del })
    if (ins) out.push({ kind: 'ins', text: ins })
    run = []
  }
  for (const segment of segments) {
    if (segment.kind === 'equal') {
      flush()
      out.push(segment)
    } else {
      run.push(segment)
    }
  }
  flush()
  return out
}
