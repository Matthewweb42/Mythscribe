import { describe, expect, it } from 'vitest'
import { RECENTS_MAX, type ProjectInfo, type RecentProjectEntry } from '@shared/ipc/contract'
import { removeRecent, toRecentEntry, touchRecent, withExists } from './recents'

function entry(n: number, lastOpened = `t${n}`): RecentProjectEntry {
  return { path: `/p/${n}.mythscribe`, name: `P${n}`, format: 'novel', lastOpened }
}

describe('touchRecent', () => {
  it('pushes a new entry to the front', () => {
    const list = touchRecent([entry(1)], entry(2))
    expect(list.map((r) => r.path)).toEqual([entry(2).path, entry(1).path])
  })

  it('dedupes by path, moving the entry to the front with the newest metadata', () => {
    const list = touchRecent([entry(1), entry(2), entry(3)], {
      ...entry(2, 'later'),
      name: 'Renamed'
    })
    expect(list).toHaveLength(3)
    expect(list[0]).toEqual({ ...entry(2, 'later'), name: 'Renamed' })
    expect(list.map((r) => r.path)).toEqual([entry(2).path, entry(1).path, entry(3).path])
  })

  it('caps the list at RECENTS_MAX, dropping the oldest', () => {
    let list: RecentProjectEntry[] = []
    for (let i = 1; i <= RECENTS_MAX + 2; i++) list = touchRecent(list, entry(i))
    expect(list).toHaveLength(RECENTS_MAX)
    expect(list[0]?.path).toBe(entry(RECENTS_MAX + 2).path)
    expect(list.at(-1)?.path).toBe(entry(3).path)
  })

  it('does not mutate the input list', () => {
    const input = [entry(1)]
    touchRecent(input, entry(2))
    expect(input).toEqual([entry(1)])
  })
})

describe('removeRecent', () => {
  it('removes the entry with the given path', () => {
    expect(removeRecent([entry(1), entry(2)], entry(1).path)).toEqual([entry(2)])
  })

  it('is a no-op for unknown paths', () => {
    expect(removeRecent([entry(1), entry(2)], '/nowhere')).toEqual([entry(1), entry(2)])
  })
})

describe('toRecentEntry', () => {
  it('keeps only the fields the welcome screen needs', () => {
    const info: ProjectInfo = {
      id: 'id',
      name: 'A',
      format: 'epic',
      path: '/p/A.mythscribe',
      created: 'c',
      modified: 'm',
      lastOpened: 'o',
      schemaVersion: 1
    }
    expect(toRecentEntry(info)).toEqual({
      path: '/p/A.mythscribe',
      name: 'A',
      format: 'epic',
      lastOpened: 'o'
    })
  })
})

describe('withExists', () => {
  it('flags each entry using the predicate', () => {
    const list = withExists([entry(1), entry(2)], (p) => p === entry(1).path)
    expect(list).toEqual([
      { ...entry(1), exists: true },
      { ...entry(2), exists: false }
    ])
  })
})
