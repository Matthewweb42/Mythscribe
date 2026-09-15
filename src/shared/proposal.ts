import { z } from 'zod'

/**
 * Proposal review (F-14.5). Every AI output the author can act on is a proposal row in the
 * project database: what feature produced it, the prompt version and model, what it cost, the
 * text, and how the author settled it. Rejection and regeneration notes stay with the row as
 * negative examples for later features. A proposal the author never acts on stays `pending`;
 * the retention cap bounds the table.
 */

/**
 * `accepted`: all of it entered the manuscript (or every chip was linked); `acceptedPart`:
 * some of it did; `rejected`: none of it; `regenerated`: the author asked again, optionally
 * with a note saying what was off.
 */
export const PROPOSAL_STATUSES = [
  'pending',
  'accepted',
  'acceptedPart',
  'rejected',
  'regenerated'
] as const
export const ProposalStatus = z.enum(PROPOSAL_STATUSES)
export type ProposalStatus = z.infer<typeof ProposalStatus>

/** The statuses `proposal:settle` accepts: anything but `pending`. */
export const SETTLED_STATUSES = ['accepted', 'acceptedPart', 'rejected', 'regenerated'] as const
export const SettledStatus = z.enum(SETTLED_STATUSES)
export type SettledStatus = z.infer<typeof SettledStatus>

/** The longest note the author may attach when settling a proposal, in characters. */
export const PROPOSAL_NOTE_MAX = 300

/** How many proposal rows a project keeps; the oldest go first, whatever their status. */
export const PROPOSAL_RETENTION_MAX = 500

/** The note as stored: trimmed, and null when the author left it blank. */
export function normalizeProposalNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}
