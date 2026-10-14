import { z } from 'zod'
import { FindingView, RULE_ORDER, type FindingRule } from './findings'

/**
 * Contradiction underlines in the editor (F-16.28; design §2.4 "Underlines", plan P4 §5, P4-D15,
 * P4-D16): which quotes of a scene are underlined, and the precision log behind the one question
 * "show contradictions in the panel only?". Pure; main picks the marks (`findings/underlines.ts`),
 * the editor draws them as decorations only (`contradictionMarks.ts`), never in the document.
 */

/** At most this many marks in one scene (design §2.4; a same-scene pair is two). */
export const UNDERLINES_MAX = 3

/** At most this many findings reported drawn in one `memory:underlinesShown` call. */
export const UNDERLINES_SHOWN_MAX = 50

/**
 * At most this many scenes in one `memory:underlines` call (a stacked chapter or the whole
 * manuscript asks for its regions in chunks of this size).
 */
export const UNDERLINE_SCENES_MAX = 500

/** Precision is counted over the last this many shown findings that closed (design §2.4). */
export const PRECISION_WINDOW = 20

/** Below this share of right underlines over the window, Needs a look asks once (design §2.4). */
export const PRECISION_BAR = 0.7

/** The log keeps the newest this many outcomes. */
export const UNDERLINE_LOG_MAX = 50

/** The log keeps the scenes' texts of at most this many drawn findings not closed yet. */
export const UNDERLINE_SHOWN_MAX = 200

/**
 * How a shown (underlined) finding closed, for the precision log (P4-D16): `right` when the author
 * said a side is right (*This one's right*), updated her note, or changed the text so a reading
 * closed it; `notProblem` when she dismissed it. Nothing else counts.
 */
export const UNDERLINE_OUTCOMES = ['right', 'notProblem'] as const
export const UnderlineOutcome = z.enum(UNDERLINE_OUTCOMES)
export type UnderlineOutcome = z.infer<typeof UnderlineOutcome>

/**
 * One outcome logged (P4 slice 5 review): the finding's *Not a problem* key (`npKey`, one per pair
 * of values and places, so the same pair answered again after an *Undo* replaces its first
 * outcome), the outcome, and the Dismissed row the answer wrote (*Not a problem*'s row, or the
 * *Not right* row *This one's right* wrote), whose *Undo* takes the outcome back; null for *Update
 * my note* and a fix in the text.
 */
export const LoggedOutcome = z.object({
  key: z.string(),
  outcome: UnderlineOutcome,
  dismissedId: z.string().nullable()
})
export type LoggedOutcome = z.infer<typeof LoggedOutcome>

/** An outcome as the first log kept it (a bare word): counted, never replaced or taken back. */
const BareOutcome = UnderlineOutcome.transform((outcome): LoggedOutcome => ({
  key: '',
  outcome,
  dismissedId: null
}))

/**
 * A finding drawn and not closed yet (P4 slice 5 review): a hash of each of its book sides' scene
 * texts as they were when it was first drawn, so a reading that later changed or removed a side
 * counts as a fix in the text only when the author's words there changed since (a *Not a secret*,
 * a spot check, a deleted record or a rebuild never does).
 */
export const ShownTexts = z.object({
  findingId: z.string(),
  texts: z.record(z.string(), z.string())
})
export type ShownTexts = z.infer<typeof ShownTexts>

/**
 * The `memoryUnderlines` settings row: the outcomes, oldest first; the drawn findings' scene texts;
 * whether the question was asked.
 */
export const UnderlineLog = z.object({
  outcomes: z.array(z.union([LoggedOutcome, BareOutcome])).catch([]),
  shown: z.array(ShownTexts).catch([]),
  asked: z.boolean().catch(false)
})
export type UnderlineLog = z.infer<typeof UnderlineLog>

export const EMPTY_UNDERLINE_LOG: UnderlineLog = { outcomes: [], shown: [], asked: false }

/**
 * The log with `entries` added (newest last), kept to `UNDERLINE_LOG_MAX`: an entry replaces an
 * earlier one for the same pair (its key), so a pair is counted once, as it was last answered.
 */
export function logOutcomes(log: UnderlineLog, entries: readonly LoggedOutcome[]): UnderlineLog {
  if (entries.length === 0) return log
  const keys = new Set(entries.flatMap((each) => (each.key === '' ? [] : [each.key])))
  return {
    ...log,
    outcomes: [...log.outcomes.filter((each) => !keys.has(each.key)), ...entries].slice(
      -UNDERLINE_LOG_MAX
    )
  }
}

/**
 * The log without the outcomes a Dismissed row stood for, its *Undo* taking the answer back: the
 * outcomes that row wrote, or for a *Not a problem* row its pair's (by key). The same log when
 * there were none.
 */
export function forgetOutcomes(
  log: UnderlineLog,
  undone: { id: string; kind: string; key: string }
): UnderlineLog {
  const gone = (each: LoggedOutcome): boolean =>
    each.dismissedId === undone.id ||
    (undone.kind === 'notProblem' && each.key !== '' && each.key === undone.key)
  return log.outcomes.some(gone)
    ? { ...log, outcomes: log.outcomes.filter((each) => !gone(each)) }
    : log
}

/** The log with these findings' scene texts added (each once, the first kept), the newest kept. */
export function logShownTexts(log: UnderlineLog, shown: readonly ShownTexts[]): UnderlineLog {
  const known = new Set(log.shown.map((each) => each.findingId))
  const fresh = shown.filter((each) => !known.has(each.findingId))
  if (fresh.length === 0) return log
  return { ...log, shown: [...log.shown, ...fresh].slice(-UNDERLINE_SHOWN_MAX) }
}

/** The log without these findings' scene texts (they closed). */
export function dropShownTexts(log: UnderlineLog, findingIds: ReadonlySet<string>): UnderlineLog {
  return log.shown.some((each) => findingIds.has(each.findingId))
    ? { ...log, shown: log.shown.filter((each) => !findingIds.has(each.findingId)) }
    : log
}

/** Underline precision over the last `PRECISION_WINDOW` outcomes: how many counted, how many right. */
export interface UnderlinePrecision {
  counted: number
  right: number
  /** `right / counted`; null before any. */
  share: number | null
}

export function underlinePrecision(outcomes: readonly LoggedOutcome[]): UnderlinePrecision {
  const last = outcomes.slice(-PRECISION_WINDOW)
  const right = last.filter((each) => each.outcome === 'right').length
  return { counted: last.length, right, share: last.length === 0 ? null : right / last.length }
}

/**
 * Whether Needs a look asks, once, to show contradictions in the panel only: a full window of
 * outcomes, under `PRECISION_BAR` right, not asked before.
 */
export function askPanelOnly(log: UnderlineLog): boolean {
  if (log.asked) return false
  const precision = underlinePrecision(log.outcomes)
  return (
    precision.counted >= PRECISION_WINDOW &&
    precision.share !== null &&
    precision.share < PRECISION_BAR
  )
}

/**
 * One underline as the editor draws it (`memory:underlines`): the finding and which of its
 * sides this quote is (`side`; *This one's right* says this side is right), where the quote sits
 * (its paragraph in `passageParagraphs` numbering), and the finding itself, whose other side the
 * hover card shows with the answers it offers (`actions`).
 */
export const UnderlineView = z.object({
  findingId: z.string(),
  side: z.enum(['a', 'b']),
  para: z.number().int().nonnegative(),
  quote: z.string(),
  finding: FindingView
})
export type UnderlineView = z.infer<typeof UnderlineView>

/**
 * `memory:underlines`'s answer (P4 slice 5 review): each asked scene's underlines by node, an
 * empty list for a scene with none (or while the Contradiction check is off or contradictions
 * show in the panel only).
 */
export const UnderlinesByScene = z.record(z.string(), z.array(UnderlineView))
export type UnderlinesByScene = z.infer<typeof UnderlinesByScene>

/** A side as the picker reads it: what it is, its scene and paragraph, its quote. */
interface PickSide {
  kind: 'claim' | 'presence' | 'note'
  nodeId: string | null
  para: number | null
  quote: string
}

/** A finding as the picker reads it: its rule and state, its sides, and when it was found. */
export interface PickFinding {
  id: string
  rule: FindingRule
  state: string
  a: PickSide
  b: PickSide
}

/** One mark picked. */
export interface PickedMark<F> {
  findingId: string
  side: 'a' | 'b'
  para: number
  quote: string
  finding: F
}

/**
 * The marks of scene `nodeId` (P4-D15): open findings only, by `RULE_ORDER`, then newest first
 * (`created`); each finding's sides in the scene that are book quotes (a claim or a presence; a
 * note side is never underlined, notes are pages), leaving out a side whose paragraph has an
 * unread finished sentence (`unreadParas`). A finding is taken whole or not at all (a same-scene
 * pair is two marks), and one quote is marked once; at most `max` marks.
 */
export function pickUnderlines<F extends PickFinding>(
  findings: readonly { finding: F; created: string }[],
  nodeId: string,
  options: { unreadParas: ReadonlySet<number>; max?: number }
): PickedMark<F>[] {
  const max = options.max ?? UNDERLINES_MAX
  const ordered = findings
    .filter((each) => each.finding.state === 'open')
    .sort(
      (x, y) =>
        RULE_ORDER.indexOf(x.finding.rule) - RULE_ORDER.indexOf(y.finding.rule) ||
        y.created.localeCompare(x.created) ||
        x.finding.id.localeCompare(y.finding.id)
    )
  const marks: PickedMark<F>[] = []
  const taken = new Set<string>()
  for (const { finding } of ordered) {
    const mine: PickedMark<F>[] = []
    for (const side of ['a', 'b'] as const) {
      const at = finding[side]
      if (at.kind === 'note' || at.nodeId !== nodeId || at.para === null) continue
      if (options.unreadParas.has(at.para)) continue
      const key = `${at.para}|${at.quote}`
      if (taken.has(key) || mine.some((each) => `${each.para}|${each.quote}` === key)) continue
      mine.push({ findingId: finding.id, side, para: at.para, quote: at.quote, finding })
    }
    if (mine.length === 0 || marks.length + mine.length > max) continue
    for (const each of mine) {
      marks.push(each)
      taken.add(`${each.para}|${each.quote}`)
    }
    if (marks.length >= max) break
  }
  return marks
}
