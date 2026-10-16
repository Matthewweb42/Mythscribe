import { z } from 'zod'
import { normalizeForMatch } from '@shared/critique'
import {
  EDIT_FLOW_MAX_ISSUES,
  EDIT_FLOW_NOTE_WRITES_MAX,
  EDIT_FLOW_OVERVIEW_MAX,
  EDIT_FLOW_PROBLEM_MAX,
  type EditFlowCategory,
  type EditFlowFamily
} from '@shared/editFlow'
import { changeSpan } from '../ai/editPass'
import { AiFallbackError } from '../ai/providers/types'
import { checkQuote } from '../scribe2/quotes'
import type { FlowSliceItem } from './plan'

/**
 * The edit flow's answers read in main (notes redesign phase 2). Every issue must quote its scene:
 * the quote is checked locally (`scribe2/quotes.ts`, as Ms Scribe's sources are) and kept as the
 * scene has it; a fix must pass the edit passes' own rule for a tracked change (`changeSpan`:
 * found exactly once, inside one paragraph, no overlap with a fix kept before it, a proofread only
 * a correction). An issue whose fix fails keeps its passage without the fix; one whose passage is
 * not in the text, or that overlaps a fix already kept, is dropped and counted.
 */

const BAD_FORMAT = 'The model did not answer in the expected format.'

function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new AiFallbackError(BAD_FORMAT, parsed.error)
  return parsed.data
}

const IssueAnswer = z.object({
  overview: z.string().nullish(),
  issues: z.array(z.unknown())
})
const IssueItem = z.object({
  scene: z.string().nullish(),
  check: z.string().nullish(),
  quote: z.string(),
  problem: z.string().nullish(),
  fix: z.string().nullish()
})

/** One issue as main kept it, before it becomes an `edit_change` row. */
export interface ParsedIssue {
  category: EditFlowCategory
  nodeId: string
  /** The passage as the scene has it (normalized as `locateText` matches). */
  original: string
  /** The fix; null for an issue without one. */
  replacement: string | null
  rationale: string
  /** Where the passage starts in the normalized scene, for book order. */
  at: number
}

/** The category a family's issue is filed under; the checks family names its own. */
function categoryOf(
  family: Exclude<EditFlowFamily, 'notes'>,
  check: string | null | undefined,
  checks: readonly EditFlowCategory[]
): EditFlowCategory | null {
  switch (family) {
    case 'developmental':
      return 'developmental'
    case 'line':
      return 'line'
    case 'copy':
      return 'copy'
    case 'proof':
      return 'proofread'
    case 'checks': {
      const named = checks.find((c) => c.toLowerCase() === (check ?? '').trim().toLowerCase())
      if (named !== undefined) return named
      return checks.length === 1 ? (checks[0] ?? null) : null
    }
  }
}

const ELLIPSIS = /…|\.\.\./

/** The slice item the issue names (by ref) and holds the quote, else the first that holds it. */
function itemFor(
  items: readonly FlowSliceItem[],
  ref: string | null | undefined,
  quote: string
): { item: FlowSliceItem; found: string } | null {
  const key = (ref ?? '').trim().toLowerCase()
  const wanted = /^\d+$/.test(key) ? `n${key}` : key
  const ordered = [
    ...items.filter((item) => item.ref.toLowerCase() === wanted),
    ...items.filter((item) => item.ref.toLowerCase() !== wanted)
  ]
  for (const item of ordered) {
    const found = checkQuote(item.text, quote)
    if (found !== null) return { item, found }
  }
  return null
}

export interface ParseIssuesInput {
  family: Exclude<EditFlowFamily, 'notes'>
  /** The focused checks asked for (the checks family). */
  checks: readonly EditFlowCategory[]
  items: readonly FlowSliceItem[]
  /** Each scene's whole text, normalized (`normalizeForMatch`), by node id. */
  scenes: ReadonlyMap<string, string>
  /** Names and dictionary words a proofread never "corrects". */
  keep: ReadonlySet<string>
  /** The fixes kept so far in each scene (across the run's families and slices). */
  taken: Map<string, { at: number; end: number }[]>
}

/**
 * The model's `{ overview?, issues: [...] }`: PROVIDER (a fallback error) when it is not that
 * shape at all, lenient item by item otherwise.
 */
export function parseFlowIssues(
  answer: string,
  input: ParseIssuesInput
): { overview: string | null; issues: ParsedIssue[]; dropped: number } {
  const data = parseJson(answer, IssueAnswer)
  const overview =
    input.family === 'developmental' && typeof data.overview === 'string'
      ? data.overview.trim().slice(0, EDIT_FLOW_OVERVIEW_MAX) || null
      : null
  const issues: ParsedIssue[] = []
  let dropped = 0
  for (const entry of data.issues.slice(0, EDIT_FLOW_MAX_ISSUES * 2)) {
    const parsed = IssueItem.safeParse(entry)
    if (!parsed.success) {
      dropped += 1
      continue
    }
    const item = parsed.data
    const category = categoryOf(input.family, item.check, input.checks)
    const located = itemFor(input.items, item.scene, item.quote)
    const scene = located === null ? undefined : input.scenes.get(located.item.nodeId)
    const rationale = (item.problem ?? '').trim().slice(0, EDIT_FLOW_PROBLEM_MAX)
    if (
      category === null ||
      located === null ||
      scene === undefined ||
      issues.length >= EDIT_FLOW_MAX_ISSUES
    ) {
      dropped += 1
      continue
    }
    const { found } = located
    const nodeId = located.item.nodeId
    const taken = input.taken.get(nodeId) ?? []
    input.taken.set(nodeId, taken)
    const fix = typeof item.fix === 'string' && category !== 'developmental' ? item.fix.trim() : null
    const span =
      fix === null || ELLIPSIS.test(item.quote)
        ? null
        : changeSpan(found, fix, located.item.text, scene, {
            proofread: category === 'proofread',
            keep: input.keep,
            taken
          })
    if (span !== null) {
      taken.push(span)
      issues.push({ category, nodeId, original: found, replacement: fix, rationale, at: span.at })
      continue
    }
    const at = scene.indexOf(normalizeForMatch(found))
    const end = at + normalizeForMatch(found).length
    // A passage another fix already changes, or an issue that says nothing, is not shown twice.
    if (at < 0 || rationale === '' || taken.some((other) => at < other.end && other.at < end)) {
      dropped += 1
      continue
    }
    issues.push({ category, nodeId, original: found, replacement: null, rationale, at })
  }
  return { overview, issues, dropped }
}

const NoteAnswer = z.object({ notes: z.array(z.unknown()) })
const NoteItem = z.object({
  page: z.string().nullish(),
  add: z.string().nullish(),
  title: z.string().nullish(),
  folder: z.string().nullish(),
  text: z.string().nullish()
})

/** One write Update notes asked for: lines added to a page, or a new page. */
export type ParsedNoteWrite =
  | { kind: 'append'; page: string; text: string }
  | { kind: 'create'; title: string; folder: string; text: string }

/** The model's `{ notes: [...] }`, at most `EDIT_FLOW_NOTE_WRITES_MAX` writes; blanks dropped. */
export function parseFlowNotes(answer: string): { writes: ParsedNoteWrite[]; dropped: number } {
  const data = parseJson(answer, NoteAnswer)
  const writes: ParsedNoteWrite[] = []
  let dropped = 0
  for (const entry of data.notes) {
    const parsed = NoteItem.safeParse(entry)
    const item = parsed.success ? parsed.data : null
    const page = item?.page?.trim() ?? ''
    const add = item?.add?.trim() ?? ''
    const title = item?.title?.trim() ?? ''
    const text = item?.text?.trim() ?? ''
    if (writes.length >= EDIT_FLOW_NOTE_WRITES_MAX || item === null) {
      dropped += 1
    } else if (page !== '' && add !== '') {
      writes.push({ kind: 'append', page, text: add })
    } else if (title !== '' && text !== '') {
      writes.push({ kind: 'create', title, folder: item.folder?.trim() ?? '', text })
    } else {
      dropped += 1
    }
  }
  return { writes, dropped }
}
