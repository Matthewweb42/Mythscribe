import { describe, expect, it } from 'vitest'
import {
  PROPOSAL_STATUSES,
  ProposalStatus,
  SETTLED_STATUSES,
  SettledStatus,
  normalizeProposalNote
} from './proposal'

describe('proposal (F-14.5)', () => {
  it('settled statuses are every status but pending', () => {
    expect(SETTLED_STATUSES).toEqual(PROPOSAL_STATUSES.filter((s) => s !== 'pending'))
    expect(ProposalStatus.safeParse('pending').success).toBe(true)
    expect(SettledStatus.safeParse('pending').success).toBe(false)
    expect(SettledStatus.safeParse('acceptedPart').success).toBe(true)
  })

  it('normalizes a note: trimmed, and null when blank or missing', () => {
    expect(normalizeProposalNote('  Too purple. ')).toBe('Too purple.')
    expect(normalizeProposalNote('   ')).toBeNull()
    expect(normalizeProposalNote('')).toBeNull()
    expect(normalizeProposalNote(null)).toBeNull()
    expect(normalizeProposalNote(undefined)).toBeNull()
  })
})
