import { EDIT_PASS_LABEL, type EditPassStatus, type EditPassSummary } from '@shared/editPass'

/** How long a custom instruction runs in a title before it is cut. */
const INSTRUCTION_TITLE_CHARS = 48

/** A pass's title in the list and the report: its type, and a custom pass's instruction. */
export function passTitle(pass: Pick<EditPassSummary, 'type' | 'instruction'>): string {
  const label = EDIT_PASS_LABEL[pass.type]
  if (pass.type !== 'custom' || !pass.instruction) return label
  const text = pass.instruction.replace(/\s+/g, ' ').trim()
  const cut =
    text.length > INSTRUCTION_TITLE_CHARS ? `${text.slice(0, INSTRUCTION_TITLE_CHARS)}…` : text
  return `${label}: ${cut}`
}

export const PASS_STATUS_LABEL: Record<EditPassStatus, string> = {
  running: 'Running',
  done: 'Finished',
  cancelled: 'Stopped',
  failed: 'Failed'
}

/** The date a pass ran, as the list shows it. */
export function passDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "3 to review · 2 accepted" for the list and the report header. */
export function passCounts(pass: Pick<EditPassSummary, 'counts' | 'type'>): string {
  const { pending, accepted, rejected, stale } = pass.counts
  const noun = pass.type === 'developmental' ? 'note' : 'change'
  const total = pending + accepted + rejected + stale
  if (total === 0) return `No ${noun}s`
  const parts = [`${pending} to review`]
  if (accepted > 0) parts.push(`${accepted} ${pass.type === 'developmental' ? 'done' : 'accepted'}`)
  if (rejected > 0)
    parts.push(`${rejected} ${pass.type === 'developmental' ? 'dismissed' : 'rejected'}`)
  if (stale > 0) parts.push(`${stale} out of date`)
  return parts.join(' · ')
}
