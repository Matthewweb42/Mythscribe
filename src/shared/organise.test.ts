import { describe, expect, it } from 'vitest'
import {
  candidatesKey,
  describeCandidates,
  describeOrganiseAction,
  findOrganiseCandidates,
  groupOf,
  namesLookAlike,
  needsAsk,
  OrganiseOp,
  scopesOf,
  worthOffering,
  type CandidateSheet,
  type CandidateTag,
  type OrganiseAction
} from './organise'

const tag = (id: string, name: string, over: Partial<CandidateTag> = {}): CandidateTag => ({
  id,
  name,
  aliases: [],
  usageCount: 1,
  mentions: 1,
  children: 0,
  sheets: 0,
  ...over
})
const sheet = (id: string, name: string, over: Partial<CandidateSheet> = {}): CandidateSheet => ({
  id,
  kind: 'character',
  name,
  aliases: [],
  empty: false,
  ...over
})

describe('namesLookAlike (F-9.10)', () => {
  it('matches the same key, a short name inside a longer one, and close spellings', () => {
    expect(namesLookAlike('Rynna Falsire', 'rynna-falsire')).toBe(true)
    expect(namesLookAlike('Rynna', 'Rynna Falsire')).toBe(true)
    expect(namesLookAlike('Rynna Falseer', 'Rynna Falsire')).toBe(true)
  })

  it('leaves short words, different first letters, and different people alone', () => {
    expect(namesLookAlike('War', 'Ashfall War')).toBe(false)
    expect(namesLookAlike('Kael', 'Rael')).toBe(false)
    expect(namesLookAlike('Mara Vell', 'Tomas Reed')).toBe(false)
    expect(namesLookAlike('???', 'Mara')).toBe(false)
  })
})

describe('findOrganiseCandidates (F-9.10)', () => {
  it('groups tags and sheets that look alike, through their aliases too', () => {
    const found = findOrganiseCandidates(
      [
        tag('t1', 'rynna-falsire'),
        tag('t2', 'rynna'),
        tag('t3', 'high-crown', { aliases: ['Rynna Falseer'] }),
        tag('t4', 'mill')
      ],
      [sheet('s1', 'Rynna Falsire'), sheet('s2', 'High Crown Falsire', { aliases: ['Rynna'] })]
    )
    expect(found.duplicates).toEqual([
      { of: 'tag', ids: ['t1', 't2', 't3'], names: ['rynna-falsire', 'rynna', 'high-crown'] },
      { of: 'sheet', ids: ['s1', 's2'], names: ['Rynna Falsire', 'High Crown Falsire'] }
    ])
  })

  it('names unused tags and empty sheets', () => {
    const found = findOrganiseCandidates(
      [
        tag('t1', 'old-draft', { usageCount: 0, mentions: 0 }),
        tag('t2', 'parent-only', { usageCount: 0, mentions: 0, children: 1 }),
        tag('t3', 'mentioned', { usageCount: 0, mentions: 2 })
      ],
      [sheet('s1', 'Blank', { empty: true })]
    )
    expect(found.unusedTags).toEqual([{ id: 't1', name: 'old-draft' }])
    expect(found.emptySheets).toEqual([{ id: 's1', name: 'Blank' }])
    expect(worthOffering(found)).toBe(false)
    expect(describeCandidates(found)).toBe('1 unused tag, 1 empty sheet')
  })

  it('keeps ordinary words out of the duplicates and offers AI-made ones for removal (2026-10-08)', () => {
    const found = findOrganiseCandidates(
      [
        tag('t1', 'custom', { ordinary: true, aiMade: true }),
        tag('t2', 'customs', { ordinary: true, aiMade: true, usageCount: 0, mentions: 0 }),
        tag('t3', 'trial', { aiMade: true }),
        tag('t4', 'trials', { ordinary: true }),
        tag('t5', 'marta', { aiMade: true }),
        tag('t6', 'martha')
      ],
      []
    )
    // custom/customs are close spellings and trial/trials one word apart: not duplicates now.
    expect(found.duplicates).toEqual([{ of: 'tag', ids: ['t5', 't6'], names: ['marta', 'martha'] }])
    // Only the AI's ordinary words are offered for removal; the author's own (t4) are left alone.
    expect(found.notNames).toEqual([
      { id: 't1', name: 'custom' },
      { id: 't2', name: 'customs' }
    ])
    expect(found.unusedTags).toEqual([])
    expect(describeCandidates(found)).toBe('1 possible duplicate, 2 tags that are not a name')
    expect(candidatesKey(found)).toContain('x:t1')
  })

  it('offers on any duplicate or three loose ends, keyed by what it found', () => {
    const none = { duplicates: [], unusedTags: [], emptySheets: [], notNames: [] }
    expect(worthOffering(none)).toBe(false)
    const loose = {
      ...none,
      unusedTags: [
        { id: 'a', name: 'a' },
        { id: 'b', name: 'b' }
      ],
      emptySheets: [{ id: 'c', name: 'c' }]
    }
    expect(worthOffering(loose)).toBe(true)
    expect(candidatesKey(loose)).toBe('e:c|u:a|u:b')
    const dup = {
      ...none,
      duplicates: [{ of: 'tag' as const, ids: ['y', 'x'], names: ['y', 'x'] }]
    }
    expect(worthOffering(dup)).toBe(true)
    expect(candidatesKey(dup)).toBe('tag:x+y')
  })
})

describe('the plan model (F-9.10)', () => {
  const merge: OrganiseAction = {
    kind: 'mergeTags',
    target: { id: 'a', name: 'rynna-falsire' },
    sources: [{ id: 'b', name: 'rynna' }]
  }
  const rename: OrganiseAction = {
    kind: 'binder',
    edit: { kind: 'rename', nodeId: 'n', title: 'Untitled', after: 'The mill' }
  }

  it('asks first for merges, deletions, and new categories; not for an edit with an undo', () => {
    expect(needsAsk(merge)).toBe(true)
    expect(needsAsk({ kind: 'deleteTag', tagId: 'a', name: 'x', notName: false })).toBe(true)
    expect(
      needsAsk({ kind: 'category', id: 'c-ships', name: 'Ships', noun: 'ship', fields: [] })
    ).toBe(true)
    expect(needsAsk(rename)).toBe(false)
    expect(
      needsAsk({ kind: 'binder', edit: { kind: 'delete', target: 'node', id: 'f', name: 'Old' } })
    ).toBe(true)
  })

  it('groups and describes each change', () => {
    expect(groupOf(merge)).toBe('merges')
    expect(groupOf({ kind: 'deleteTag', tagId: 'a', name: 'custom', notName: true })).toBe(
      'notNames'
    )
    expect(groupOf(rename)).toBe('binder')
    expect(describeOrganiseAction(merge)).toBe('Merge tags “#rynna” into #rynna-falsire')
    expect(describeOrganiseAction(rename)).toBe('Rename Untitled to “The mill”')
    expect(
      describeOrganiseAction(
        {
          kind: 'sheet',
          entityId: 's',
          name: 'The Weave',
          patch: { kind: 'magic', fields: { notes: 'x' } },
          before: { kind: 'world' }
        },
        (id) => (id === 'magic' ? 'Magic Systems' : id)
      )
    ).toBe('Sheet “The Weave”: move to Magic Systems; 1 field')
  })

  it('reads the model’s operations leniently and defaults the scopes to all', () => {
    expect(OrganiseOp.safeParse({ op: 'move', id: 'n3', in: 'n2' }).data).toEqual({
      op: 'move',
      id: 'n3',
      in: 'n2',
      after: ''
    })
    expect(OrganiseOp.safeParse({ op: 'explode' }).success).toBe(false)
    expect(scopesOf({ scope: [] })).toEqual(['tags', 'sheets', 'notes', 'binder'])
    expect(scopesOf({ scope: ['tags', 'tags'] })).toEqual(['tags'])
  })
})
