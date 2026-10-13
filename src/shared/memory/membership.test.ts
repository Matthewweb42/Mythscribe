import { describe, expect, it } from 'vitest'
import { groupsOf, type MembershipClaim, type MembershipInput } from './membership'

const names = (text: string) => [{ text, caseRule: 'auto' as const, shared: false }]

const records: MembershipInput['records'] = new Map([
  ['bel', { kind: 'character', names: names('Bel') }],
  ['guild', { kind: 'group', names: names('the Guild') }],
  ['watch', { kind: 'group', names: names('the Watch') }],
  ['tomas', { kind: 'character', names: names('Tomas') }]
])

const claim = (over: Partial<MembershipClaim>): MembershipClaim => ({
  recordId: 'bel',
  slot: 'relation',
  value: 'member',
  objectId: null,
  voice: 'narration',
  mode: 'now',
  state: 'live',
  ...over
})

const input = (over: Partial<MembershipInput>): MembershipInput => ({
  claims: [],
  records,
  pinned: [],
  ...over
})

describe('groupsOf (P4-D5)', () => {
  it('reads a narration claim relating the character to the group', () => {
    expect([...groupsOf('bel', input({ claims: [claim({ objectId: 'guild' })] }))]).toEqual([
      'guild'
    ])
    // Another person is no group; speech and a line whose sentence changed say nothing.
    expect([...groupsOf('bel', input({ claims: [claim({ objectId: 'tomas' })] }))]).toEqual([])
    expect([
      ...groupsOf('bel', input({ claims: [claim({ objectId: 'guild', voice: 'dialogue' })] }))
    ]).toEqual([])
    expect([
      ...groupsOf('bel', input({ claims: [claim({ objectId: 'guild', state: 'stale' })] }))
    ]).toEqual([])
  })

  it('reads a lasting role, rank, allegiance, occupation or home naming the group', () => {
    const role = claim({ slot: 'role', value: 'a clerk of the Guild' })
    expect([...groupsOf('bel', input({ claims: [role] }))]).toEqual(['guild'])
    const traits = claim({ slot: 'traits', value: 'loyal to the Guild' })
    expect([...groupsOf('bel', input({ claims: [traits] }))]).toEqual([])
  })

  it('reads a canon Pinned line on either sheet naming the other', () => {
    const own = {
      ownerKind: 'record' as const,
      ownerId: 'bel',
      page: 'pinned' as const,
      para: 0,
      text: 'Sworn to the Watch.'
    }
    const theirs = {
      ownerKind: 'record' as const,
      ownerId: 'guild',
      page: 'pinned' as const,
      para: 0,
      text: 'Members: Bel, Orrin.'
    }
    expect([...groupsOf('bel', input({ pinned: [own] }))]).toEqual(['watch'])
    expect([...groupsOf('bel', input({ pinned: [theirs] }))]).toEqual(['guild'])
  })
})
