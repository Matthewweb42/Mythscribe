import type { CheckEstimate, CheckProgress, CheckReport } from '@shared/memory/views'
import { formatCents } from '@renderer/features/ai/usageFormat'
import { shortDate } from '@renderer/features/memory/memoryView'

/**
 * *Check the book*'s words (F-16.30; design §2.7, plan P4 §4): the Book tab's "Last checked 2 days
 * ago · 2 found", the price ("About 3¢, at most 5¢", "free" when nothing changed, "from your
 * Balance" on Cloud), what it checks and what it does not, the progress, and the report's
 * summaries. The scoped "nobody learns" line is composed here only (rule 5). Pure.
 */

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`

/** "just now", "3 min ago", "2 h ago", "yesterday", "2 days ago", "on 12 Oct". */
export function checkedAgo(at: string, now: Date): string {
  const then = new Date(at)
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  const days = Math.floor(minutes / (24 * 60))
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return `on ${shortDate(then)}`
}

/** The Book tab's line: "Last checked 2 days ago · 2 found", or that it was never run. */
export function lastCheckedLine(report: CheckReport | null, now: Date): string {
  if (report === null) return 'Not checked yet'
  return `Last checked ${checkedAgo(report.at, now)} · ${report.found.length} found`
}

/**
 * The price, first: "About 3¢, at most 5¢", on Cloud "from your Balance"; free when nothing is
 * left to judge ("since your last check" only when there was one: background judging may have
 * judged every pair before a first check).
 */
export function checkPriceLine(estimate: CheckEstimate, checkedBefore: boolean): string {
  if (estimate.free) {
    return checkedBefore
      ? 'Nothing changed since your last check: free'
      : 'Nothing new to judge: free'
  }
  const price =
    estimate.mostUsd > estimate.aboutUsd
      ? `About ${formatCents(estimate.aboutUsd)}, at most ${formatCents(estimate.mostUsd)}`
      : `About ${formatCents(estimate.aboutUsd)}`
  const unpriced = estimate.priced ? '' : ' (at least: a model’s price is unknown)'
  return `${price}${unpriced}${estimate.cloud ? ', from your Balance' : ''}`
}

/** What the price is made of: the fast check's requests and the stronger check's confirmations. */
export function checkWorkLine(estimate: CheckEstimate): string {
  if (estimate.free) return 'Every pair is judged already; nothing is sent.'
  const fast =
    estimate.fastCalls === 0
      ? 'no new pairs to judge'
      : `${plural(estimate.uncached, 'pair-order')} judged by ${estimate.fastModel} in ${plural(estimate.fastCalls, 'request')}`
  const confirms =
    estimate.confirms.most === 0
      ? 'nothing to confirm'
      : `up to ${plural(estimate.confirms.most, 'confirmation')} by ${estimate.strongModel}`
  return `${plural(estimate.pairs, 'pair')} to look at: ${fast}; ${confirms}.`
}

/** What *Check the book* looks for (design §2.4's rules, in words). */
export const CHECK_COVERS =
  'It looks for two values for one fixed fact (eyes, birth, family), the book against your notes and canon Research, someone on the page after their death, a lasting change to someone’s body (a scar, a lost hand) with no scene saying it changed, a secret passed on before it is learned, a stated age against a birth year and the year, a stated age lower than an earlier one, a plot thread advanced after it was resolved, and history lines that disagree.'

/** What no rule covers, with the scenes not read yet (they are not checked). */
export function checkSkipsLine(
  fixed: readonly string[],
  unread: readonly { ref: string }[]
): string {
  const scenes =
    unread.length === 0
      ? ''
      : ` Not read yet, so not checked: ${unread.map((scene) => scene.ref).join(', ')}.`
  return `It does not check ${fixed.join(', ')}.${scenes}`
}

/**
 * What the dialog says when a check it waits on ended early with no new report: a hold met as it
 * began, with its cause and next step; or a Stop.
 */
export function checkEndedLine(progress: CheckProgress): string {
  if (progress.reason !== null) return `The check did not run: ${progress.reason}`
  return progress.toJudge === 0
    ? 'The check was stopped.'
    : `The check was stopped after ${progress.judged} of ${plural(progress.toJudge, 'pair')}.`
}

/** The activity bar's and the dialog's progress: "Judging 3 of 10 pairs", then the confirmations. */
export function checkProgressLine(progress: CheckProgress): string {
  if (progress.judged < progress.toJudge) {
    return `Judging ${progress.judged} of ${plural(progress.toJudge, 'pair')}…`
  }
  if (progress.toConfirm > 0) {
    return `Confirming ${progress.confirmed} of ${progress.toConfirm} with the stronger check…`
  }
  return 'Checking…'
}

/** "Checked: 124 pairs over 90 scenes and your notes; 20 confirmed by a stronger AI read". */
export function checkedLine(report: CheckReport): string {
  const notes = report.checked.notes === 0 ? '' : ' and your notes'
  return `Checked: ${plural(report.checked.pairs, 'pair')} over ${plural(report.checked.scenes, 'scene')}${notes}; ${report.confirmed} confirmed by a stronger AI read`
}

/** The report's head: when it ran, what it cost, and whether it was stopped. */
export function reportHead(report: CheckReport): string {
  const stopped = report.stopped ? ' · stopped before the end' : ''
  return `Checked on ${shortDate(new Date(report.at))} · cost ${formatCents(report.costUsd)}${stopped}`
}

/** What the report did not check beyond the fixed list: past the confirmations, left by a Stop. */
export function notCheckedExtras(report: CheckReport): string[] {
  const lines: string[] = []
  if (report.notChecked.pastConfirm > 0) {
    lines.push(
      `${plural(report.notChecked.pastConfirm, 'finding')} past the 20 confirmations ${report.notChecked.pastConfirm === 1 ? 'was' : 'were'} judged twice by the fast check only.`
    )
  }
  if (report.notChecked.unjudged > 0) {
    lines.push(
      `${plural(report.notChecked.unjudged, 'pair')} ${report.notChecked.unjudged === 1 ? 'was' : 'were'} left unjudged when the check ended.`
    )
  }
  return lines
}

/**
 * A secret readers know with no learning scene, scoped (design §2.7, rule 5): "“the sold map”:
 * readers know it from 3.2; no scene shows anyone learning it (checked up to 14.2)". Composed here
 * only, from the refs main returns.
 */
export function nobodyLearnsLine(secret: CheckReport['secretsNobodyLearns'][number]): string {
  const since =
    secret.readersSince === null ? '' : `readers know it from ${secret.readersSince.ref}; `
  const scope =
    secret.checkedUpTo === null
      ? 'as far as the book is read'
      : `checked up to ${secret.checkedUpTo.ref}`
  return `“${secret.label}”: ${since}no scene shows anyone learning it (${scope})`
}
