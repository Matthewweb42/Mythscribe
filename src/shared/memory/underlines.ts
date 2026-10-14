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

/** Precision is counted over the last this many shown findings that closed (design §2.4). */
export const PRECISION_WINDOW = 20

/** Below this share of right underlines over the window, Needs a look asks once (design §2.4). */
export const PRECISION_BAR = 0.7

/** The log keeps the newest this many outcomes. */
export const UNDERLINE_LOG_MAX = 50

/**
 * How a shown (underlined) finding closed, for the precision log (P4-D16): `right` when the author
 * said a side is right (*This one's right*), updated her note, or changed the text so a reading
 * closed it; `notProblem` when she dismissed it. Nothing else counts.
 */
export const UNDERLINE_OUTCOMES = ['right', 'notProblem'] as const
export const UnderlineOutcome = z.enum(UNDERLINE_OUTCOMES)
export type UnderlineOutcome = z.infer<typeof UnderlineOutcome>

/** The `memoryUnderlines` settings row: the outcomes, oldest first, and whether the question was asked. */
export const UnderlineLog = z.object({
  outcomes: z.array(UnderlineOutcome).catch([]),
  asked: z.boolean().catch(false)
})
export type UnderlineLog = z.infer<typeof UnderlineLog>

export const EMPTY_UNDERLINE_LOG: UnderlineLog = { outcomes: [], asked: false }

/** The log with `outcomes` added (newest last), kept to `UNDERLINE_LOG_MAX`. */
export function logOutcomes(log: UnderlineLog, outcomes: readonly UnderlineOutcome[]): UnderlineLog {
  if (outcomes.length === 0) return log
  return { ...log, outcomes: [...log.outcomes, ...outcomes].slice(-UNDERLINE_LOG_MAX) }
}

/** Underline precision over the last `PRECISION_WINDOW` outcomes: how many counted, how many right. */
export interface UnderlinePrecision {
  counted: number
  right: number
  /** `right / counted`; null before any. */
  share: number | null
}

export function underlinePrecision(outcomes: readonly UnderlineOutcome[]): UnderlinePrecision {
  const last = outcomes.slice(-PRECISION_WINDOW)
  const right = last.filter((each) => each === 'right').length
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
 * One underline as the editor draws it (`SceneMemory.underlines`): the finding and which of its
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
