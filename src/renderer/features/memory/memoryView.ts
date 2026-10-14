import { CLOUD_CAP_MAX_USD, CLOUD_CAP_STEP_USD } from '@shared/memory/cloudCap'
import type { RebuildEstimate } from '@shared/memory/switchover'
import type { TypedField } from '@shared/memory/typedVsText'
import type {
  ClaimInfo,
  MemoryHealthReport,
  OtherLineView,
  MemoryNotice,
  MemoryNoticeAction,
  MemoryPause,
  ReadNowResult,
  TrueNowView
} from '@shared/memory/views'
import { formatCents } from '@renderer/features/ai/usageFormat'

/**
 * The pure words of story memory v2's reading in the renderer (F-16.16, F-16.18, F-16.19): how a
 * line, a True now note, a notice and its buttons, ⓘ and the footer read. No state.
 */

/** A line's words: "Eyes: grey", "Last seen at the quay" (a label ending in "at" reads on). */
export function lineText(label: string, value: string): string {
  return label.endsWith(' at') ? `${label} ${value}` : `${label}: ${value}`
}

/** A True now line's note: "since 12.1" (lasting) or "last stated in 13.4" (transient). */
export function trueNowNote(line: Pick<TrueNowView, 'kind' | 'ref'>): string {
  return line.kind === 'since' ? `since ${line.ref}` : `last stated in ${line.ref}`
}

/**
 * Why a stale line is dimmed (design §2.10): read again after the author pauses, or, while
 * reading is paused (AI off, no provider, a hold), kept as it was.
 */
export function staleNote(paused: MemoryPause | null): string {
  return paused === null ? 're-checking after you pause' : 'reading paused'
}

/** "Read just now", "Read 3 min ago", "Read 2 h ago", "Read on 12 Oct"; "Not read yet". */
export function readAgo(at: string | null, now: Date): string {
  if (at === null) return 'Not read yet'
  const then = new Date(at)
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000)
  if (minutes < 1) return 'Read just now'
  if (minutes < 60) return `Read ${minutes} min ago`
  if (minutes < 24 * 60) return `Read ${Math.floor(minutes / 60)} h ago`
  return `Read on ${shortDate(then)}`
}

/** "12 Oct". */
export function shortDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** The footer's Cloud part: "Cloud 12¢ of $1". */
export function cloudLine(cloud: { spentUsd: number; capUsd: number }): string {
  return `Cloud ${formatCents(cloud.spentUsd)} of ${formatCents(cloud.capUsd)}`
}

/** What *Read now* says when nothing was read, or null when it read (or failed: toasted). */
export function readNowMessage(result: ReadNowResult): string | null {
  if (!result.ok || result.read) return null
  switch (result.reason) {
    case 'paused':
      return 'Reading is paused; see Needs a look.'
    case 'notReadable':
      return 'This scene is not read: it is an Idea or left out of compile.'
    default:
      return 'Nothing new to read in this scene.'
  }
}

const FIELD_NOUN: Record<TypedField, string> = {
  pov: 'POV',
  place: 'place',
  time: 'time',
  year: 'story year'
}

/** The month a `YYYY-MM` names, in words ("October"). */
function monthName(month: string): string {
  const [year, number] = month.split('-').map(Number)
  if (year === undefined || number === undefined || Number.isNaN(year) || Number.isNaN(number)) {
    return month
  }
  return new Date(year, number - 1, 1).toLocaleDateString('en-GB', { month: 'long' })
}

/** A share as a whole percent ("97 %"). */
export const percentOf = (share: number): string => `${Math.round(share * 100)} %`

/** A reading notice's line (Needs a look). */
export function noticeLine(notice: MemoryNotice): string {
  switch (notice.kind) {
    case 'backlog':
      return `Read ${notice.scenes} changed scene${notice.scenes === 1 ? '' : 's'}: about ${formatCents(notice.priceUsd)}`
    case 'draftUnread':
      return `This draft has not been read yet: ${notice.scenes} scene${notice.scenes === 1 ? '' : 's'}, about ${formatCents(notice.priceUsd)}`
    case 'backfill':
      return `Read ${notice.pages} scene${notice.pages === 1 ? '' : 's'} for ${notice.name}: about ${formatCents(notice.priceUsd)}`
    case 'health':
      return `Story memory paused: this model’s readings aren’t reliable enough (${notice.model}: ${percentOf(notice.quotes)} of quotes found, ${percentOf(notice.verified)} of checks passed).`
    case 'cloudCap':
      return `Background reading reached your ${formatCents(notice.capUsd)} Cloud cap for ${monthName(notice.month)}.`
    case 'localCutoff':
      return `Story memory paused: the local model ${notice.model} stopped answering at its limit.`
    case 'detailConflict':
      return `${notice.ref}: the text says ${notice.text}; you typed ${notice.typed}`
    case 'rebuildDone':
      return `Rebuild finished: ${notice.lines} new line${notice.lines === 1 ? '' : 's'} on ${notice.sheets} sheet${notice.sheets === 1 ? '' : 's'}, ${notice.names} name${notice.names === 1 ? '' : 's'}, ${notice.findings} possible contradiction${notice.findings === 1 ? '' : 's'}`
    case 'findingsWaiting':
      return `${notice.pairs} possible contradiction${notice.pairs === 1 ? ' waits' : 's wait'} for Check the book: about ${formatCents(notice.priceUsd)}`
  }
}

/** A notice's buttons: an action main takes, or one the renderer does itself. */
export type NoticeButton =
  | { kind: 'answer'; action: MemoryNoticeAction; label: string }
  | { kind: 'settings'; label: string }
  | { kind: 'updateDetail'; label: string }

/** A notice's buttons, in order. */
export function noticeButtons(notice: MemoryNotice): NoticeButton[] {
  const answer = (action: MemoryNoticeAction, label: string): NoticeButton => ({
    kind: 'answer',
    action,
    label
  })
  switch (notice.kind) {
    case 'backlog':
      return [answer('read', 'Read them'), answer('later', 'Later')]
    case 'draftUnread':
      return [answer('read', 'Read'), answer('later', 'Later')]
    case 'backfill':
      return [answer('read', 'Read'), answer('later', 'Not now')]
    case 'health':
      return [
        ...(notice.switchable ? [answer('switchModel', 'Switch to DeepSeek V4 Flash')] : []),
        answer('keepReading', 'Keep reading anyway'),
        { kind: 'settings', label: 'Details' }
      ]
    case 'cloudCap':
      return [
        answer('allowMore', 'Allow another $1 this month'),
        { kind: 'settings', label: 'Change the cap' }
      ]
    case 'localCutoff':
      return [answer('keepReading', 'Keep reading anyway')]
    case 'detailConflict':
      return [{ kind: 'updateDetail', label: 'Update my detail' }, answer('keepMine', 'Keep mine')]
    case 'rebuildDone':
      return [answer('dismiss', 'Done')]
    case 'findingsWaiting':
      return [answer('dismiss', 'Not now')]
  }
}

/** Decision 4's dimmed note beside the text's value: "you typed: the harbour". */
export const typedNote = (typed: string): string => `you typed: ${typed}`

/**
 * How a card value was checked (F-16.18): by a second AI read (`verified`), in code (a place or
 * time whose words are words of its own quote), or not at all (an AI paraphrase or a refused POV
 * or year, which never stands for the scene's value).
 */
export type CardChecked = 'verified' | 'code' | 'none'

export function cardCheckedNote(checked: CardChecked): string {
  switch (checked) {
    case 'verified':
      return 'checked by a second AI read'
    case 'code':
      return 'quote checked in code'
    case 'none':
      return 'read by AI, not checked'
  }
}

/**
 * A card value that does not stand for the scene's value, dimmed (decision 4, design §2.10):
 * "AI read: Tomas, not checked", or, its sentence edited since, "AI read: the quay · re-checking
 * after you pause".
 */
export function aiReadNote(value: string, stale: boolean, paused: MemoryPause | null): string {
  return stale ? `AI read: ${value} · ${staleNote(paused)}` : `AI read: ${value}, not checked`
}

/** The field's name in a conflict ("place"). */
export const fieldNoun = (field: TypedField): string => FIELD_NOUN[field]

/** ⓘ's lines (F-16.18): where it was read, how it was proved, the spot check, the reading's cost. */
export function claimInfoLines(info: ClaimInfo): string[] {
  const { claim, reading, spot } = info
  const where = `${claim.ref || info.sceneTitle} ¶${claim.para + 1}`
  const lines = [
    reading === null
      ? `Read by AI from ${where}`
      : `Read by AI from ${where} on ${shortDate(new Date(reading.created))}`,
    claim.proof === 'literal' ? 'quote checked in code' : 'checked by a second AI read'
  ]
  if (spot !== null) {
    const tier = spot.tier === 'strong' ? 'the strong model' : 'the fast model'
    lines.push(
      `spot check by ${tier}: ${spot.verdict === 'agree' ? 'agreed' : 'disagreed'} on ${shortDate(new Date(spot.at))}`
    )
  }
  if (reading !== null) {
    lines.push(`that reading cost ${formatCents(reading.costUsd)} (${reading.model})`)
  }
  if (claim.voice !== 'narration' || claim.mode !== 'now') {
    lines.push(`said as ${claim.voice}${claim.mode === 'now' ? '' : `, ${claim.mode}`}`)
  }
  return lines
}

/**
 * A sheet's line in another voice (F-16.18; never state): "Mara says: Eyes: grey", "Rumour:
 * Alive: no", "In a dream: …", "Remembered: …", "If: …".
 */
export function otherLineText(
  line: Pick<OtherLineView, 'label' | 'value' | 'voice' | 'mode'>,
  speaker: string | null
): string {
  const words = lineText(line.label, line.value)
  const who = speaker ?? 'Someone'
  switch (line.voice) {
    case 'dialogue':
      return `${who} says: ${words}`
    case 'thought':
      return `${who} thinks: ${words}`
    case 'rumour':
      return `Rumour: ${words}`
    case 'narration':
      break
  }
  switch (line.mode) {
    case 'memory':
      return `Remembered: ${words}`
    case 'hypothetical':
      return `If: ${words}`
    case 'dream':
      return `In a dream: ${words}`
    case 'now':
      return words
  }
}

/** A cap typed in dollars, pulled to a quarter-dollar step within $0–$20; null when it is no number. */
export function capFromText(text: string): number | null {
  const usd = Number(text.trim().replace(/^\$/, ''))
  if (text.trim() === '' || !Number.isFinite(usd)) return null
  const stepped = Math.round(usd / CLOUD_CAP_STEP_USD) * CLOUD_CAP_STEP_USD
  return Math.min(CLOUD_CAP_MAX_USD, Math.max(0, stepped))
}

/** "proof agreement: 48 of 50 checked" (never "accuracy"); null before any check. */
export function agreementLine(report: MemoryHealthReport): string | null {
  const checked = report.spot.fast.checked + report.spot.strong.checked
  if (checked === 0) return null
  const agreed = report.spot.fast.agreed + report.spot.strong.agreed
  return `proof agreement: ${agreed} of ${checked} checked`
}

/** The price line: "About 12¢ for 90 scenes (180 requests, about 4 min) on deepseek-v4-flash". */
export function estimateLine(estimate: RebuildEstimate): string {
  const scenes = `${estimate.scenes} scene${estimate.scenes === 1 ? '' : 's'}`
  const minutes = estimate.minutes <= 1 ? 'about a minute' : `about ${estimate.minutes} min`
  const price = `About ${formatCents(estimate.costUsd)}`
  const unpriced = estimate.priced ? '' : ' (at least: a model’s price is unknown)'
  return `${price}${unpriced} for ${scenes} (${estimate.requests} requests, ${minutes}) on ${estimate.fastModel}`
}
