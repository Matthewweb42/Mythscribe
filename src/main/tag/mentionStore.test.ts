import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MentionRange } from '@shared/mentions'
import { mentionScan, node, tag, tagMention } from '../db/schema'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createSeededProject } from '../project/testProject'
import { listNodes, type TreeDb } from '../tree/treeStore'
import {
  deleteMentionsForTag,
  deleteScans,
  getScanHash,
  listMentionsForNode,
  listMentionsForTag,
  mentionId,
  replaceNodeMentions,
  scanHashes
} from './mentionStore'
import { createTag } from './tagStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]

const at = (minute: number): Date => new Date(Date.UTC(2026, 8, 22, 10, minute, 0))

const scene = (index = 0): string => {
  const id = scenes[index]
  if (id === undefined) throw new Error(`no document at ${index}`)
  return id
}

const found = (...entries: [string, MentionRange[]][]): Map<string, MentionRange[]> =>
  new Map(entries)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-mentions-'))
  session = createSeededProject(projectFolderFor(tmp, 'Mentions'), 'Mentions', 'novel')
  db = session.connection.orm
  scenes = listNodes(db)
    .filter((row) => row.kind === 'document' && row.sectionType === null)
    .map((row) => row.id)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('replaceNodeMentions (F-4.12)', () => {
  it('writes one row per mentioned tag with its count and ranges, and records the scan', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    replaceNodeMentions(
      db,
      scene(),
      found(
        [
          rose.id,
          [
            [1, 5],
            [31, 35]
          ]
        ],
        [rain.id, [[40, 44]]]
      ),
      'hash-1',
      at(0)
    )
    expect(listMentionsForNode(db, scene())).toEqual([
      {
        tagId: rose.id,
        nodeId: scene(),
        count: 2,
        ranges: [
          [1, 5],
          [31, 35]
        ]
      },
      { tagId: rain.id, nodeId: scene(), count: 1, ranges: [[40, 44]] }
    ])
    expect(listMentionsForTag(db, rose.id)).toEqual([
      {
        tagId: rose.id,
        nodeId: scene(),
        count: 2,
        ranges: [
          [1, 5],
          [31, 35]
        ]
      }
    ])
    expect(getScanHash(db, scene())).toBe('hash-1')
  })

  it('leaves a tag with no occurrence without a row at all', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    replaceNodeMentions(db, scene(), found([rose.id, []]), 'hash-1', at(0))
    expect(listMentionsForNode(db, scene())).toEqual([])
    expect(listMentionsForTag(db, rose.id)).toEqual([])
  })

  it('replaces only this document’s rows and moves its hash on', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    replaceNodeMentions(db, scene(0), found([rose.id, [[1, 5]]]), 'hash-1', at(0))
    replaceNodeMentions(db, scene(1), found([rose.id, [[2, 6]]]), 'hash-2', at(1))
    replaceNodeMentions(db, scene(0), found(), 'hash-3', at(2))

    expect(listMentionsForNode(db, scene(0))).toEqual([])
    expect(listMentionsForTag(db, rose.id)).toEqual([
      { tagId: rose.id, nodeId: scene(1), count: 1, ranges: [[2, 6]] }
    ])
    expect(getScanHash(db, scene(0))).toBe('hash-3')
    expect(getScanHash(db, scene(1))).toBe('hash-2')
    expect(scanHashes(db, [scene(0), scene(1), 'nope'])).toEqual(
      new Map([
        [scene(0), 'hash-3'],
        [scene(1), 'hash-2']
      ])
    )
  })

  it('keys a row by tag and node, so a rescan cannot pile rows up', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    replaceNodeMentions(db, scene(), found([rose.id, [[1, 5]]]), 'hash-1', at(0))
    replaceNodeMentions(
      db,
      scene(),
      found([
        rose.id,
        [
          [1, 5],
          [9, 13]
        ]
      ]),
      'hash-2',
      at(1)
    )
    const rows = db.select().from(tagMention).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(mentionId(rose.id, scene()))
    expect(rows[0]?.updatedAt).toBe(at(1).toISOString())
  })

  it('goes with the tag and with the document', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    replaceNodeMentions(db, scene(0), found([rose.id, [[1, 5]]]), 'hash-1', at(0))
    replaceNodeMentions(db, scene(1), found([rose.id, [[1, 5]]]), 'hash-2', at(0))
    db.delete(node)
      .where(eq(node.id, scene(1)))
      .run()
    expect(listMentionsForTag(db, rose.id).map((m) => m.nodeId)).toEqual([scene(0)])
    expect(getScanHash(db, scene(1))).toBeNull()
    db.delete(tag).where(eq(tag.id, rose.id)).run()
    expect(listMentionsForNode(db, scene(0))).toEqual([])
  })
})

describe('reading rows that no longer make sense', () => {
  it('reads an unparseable positions cell as no ranges instead of throwing', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    replaceNodeMentions(db, scene(), found([rose.id, [[1, 5]]]), 'hash-1', at(0))
    for (const positions of ['{not json', '[[1]]', '"nope"']) {
      db.update(tagMention).set({ positions }).run()
      expect(listMentionsForNode(db, scene())).toEqual([
        { tagId: rose.id, nodeId: scene(), count: 1, ranges: [] }
      ])
    }
  })

  it('skips a row that is not a mention at all', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    replaceNodeMentions(db, scene(), found([rose.id, [[1, 5]]]), 'hash-1', at(0))
    db.update(tagMention).set({ count: 0 }).run()
    expect(listMentionsForNode(db, scene())).toEqual([])
    expect(listMentionsForTag(db, rose.id)).toEqual([])
  })
})

describe('deleteMentionsForTag / deleteScans (F-4.12)', () => {
  it('forgets one tag’s mentions, answers the documents that lost a row, and drops their scans', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    replaceNodeMentions(
      db,
      scene(0),
      found([rose.id, [[1, 5]]], [rain.id, [[9, 13]]]),
      'hash-1',
      at(0)
    )
    replaceNodeMentions(db, scene(1), found([rose.id, [[1, 5]]]), 'hash-2', at(0))
    replaceNodeMentions(db, scene(2), found([rain.id, [[1, 5]]]), 'hash-3', at(0))

    expect(deleteMentionsForTag(db, rose.id).sort()).toEqual([scene(0), scene(1)].sort())
    expect(listMentionsForTag(db, rose.id)).toEqual([])
    expect(listMentionsForNode(db, scene(0))).toEqual([
      { tagId: rain.id, nodeId: scene(0), count: 1, ranges: [[9, 13]] }
    ])
    // The scans of the documents that lost a row go too: the hash would match again the moment
    // tracking came back on and the rows would never be rebuilt.
    expect(getScanHash(db, scene(0))).toBeNull()
    expect(getScanHash(db, scene(1))).toBeNull()
    expect(getScanHash(db, scene(2))).toBe('hash-3')
  })

  it('says nothing about a tag that was never mentioned', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    replaceNodeMentions(db, scene(0), found(), 'hash-1', at(0))
    expect(deleteMentionsForTag(db, rose.id)).toEqual([])
    expect(deleteMentionsForTag(db, 'missing')).toEqual([])
    expect(getScanHash(db, scene(0))).toBe('hash-1')
  })

  it('drops the scans it is given and nothing else', () => {
    replaceNodeMentions(db, scene(0), found(), 'hash-1', at(0))
    replaceNodeMentions(db, scene(1), found(), 'hash-2', at(0))
    deleteScans(db, [])
    deleteScans(db, [scene(0)])
    expect(getScanHash(db, scene(0))).toBeNull()
    expect(getScanHash(db, scene(1))).toBe('hash-2')
    expect(db.select().from(mentionScan).all()).toHaveLength(1)
  })
})
