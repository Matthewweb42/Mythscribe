import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTIVE_GAP_MS, defaultGoals } from '@shared/goals'
import type { TiptapNodeT } from '@shared/tiptap'
import { writingLog, type NodeRow } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getGoals, setGoals } from '../project/settingsStore'
import { createNode, deleteNode, listNodes, type TreeDb } from '../tree/treeStore'
import {
  goalsStatus,
  manuscriptWordCount,
  readGoals,
  recordWriting,
  resetGoalsSession,
  updateGoals,
  wordsByDay
} from './goalsStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function scene(): NodeRow {
  const row = listNodes(db).find((r) => r.hierarchyLevel === 'scene')
  if (!row) throw new Error('no scene')
  return row
}

function chapter(): NodeRow {
  const row = listNodes(db).find((r) => r.hierarchyLevel === 'chapter')
  if (!row) throw new Error('no chapter')
  return row
}

function matterDocument(): NodeRow {
  return createNode(db, 'novel', {
    parentId: section('front').id,
    kind: 'document',
    hierarchyLevel: null,
    title: 'Dedication'
  })
}

function section(type: NodeRow['sectionType']): NodeRow {
  const row = listNodes(db).find((r) => r.sectionType === type)
  if (!row) throw new Error(`no ${type}`)
  return row
}

const at = (h: number, m = 0, day = 4): Date => new Date(2026, 9, day, h, m)

beforeEach(() => {
  resetGoalsSession()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-goals-'))
  session = createProject(projectFolderFor(tmp, 'Goals'), 'Goals', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  resetGoalsSession()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('manuscriptWordCount (F-10.3)', () => {
  it('answers the stored count of a manuscript document and null for anything else', () => {
    const s = scene()
    saveDocument(db, s.id, para('one two three'))
    expect(manuscriptWordCount(db, s.id)).toBe(3)
    expect(manuscriptWordCount(db, chapter().id)).toBeNull()
    expect(manuscriptWordCount(db, 'nope')).toBeNull()
  })

  it('answers null for a front matter document and a section root', () => {
    expect(manuscriptWordCount(db, matterDocument().id)).toBeNull()
    expect(manuscriptWordCount(db, section('front').id)).toBeNull()
  })
})

describe('recordWriting (F-10.3)', () => {
  it('adds net words and capped active time into the hour bucket and the session', () => {
    recordWriting(db, 100, at(9, 0))
    recordWriting(db, 50, at(9, 2))
    recordWriting(db, -20, at(9, 30))
    recordWriting(db, 10, at(10, 1))
    const rows = db.select().from(writingLog).all()
    expect(rows).toEqual([
      { day: '2026-10-04', hour: 9, words: 130, activeMs: 2 * 60_000 + ACTIVE_GAP_MS },
      { day: '2026-10-04', hour: 10, words: 10, activeMs: ACTIVE_GAP_MS }
    ])
    const status = goalsStatus(db, at(11))
    expect(status.session).toEqual({ words: 140, activeMs: 2 * 60_000 + 2 * ACTIVE_GAP_MS })
    expect(status.today).toEqual({ day: '2026-10-04', words: 140 })
  })

  it('writes no row for a first save that changed nothing', () => {
    recordWriting(db, 0, at(9))
    expect(db.select().from(writingLog).all()).toEqual([])
  })

  it('sums the log by day and shows a day of cutting as 0', () => {
    recordWriting(db, 300, at(9, 0, 3))
    recordWriting(db, -50, at(9, 0, 4))
    expect(wordsByDay(db)).toEqual({ '2026-10-03': 300, '2026-10-04': -50 })
    expect(goalsStatus(db, at(12)).today.words).toBe(0)
  })

  it('starts the session afresh after a reset, keeping the log', () => {
    recordWriting(db, 100, at(9))
    resetGoalsSession()
    const status = goalsStatus(db, at(10))
    expect(status.session).toEqual({ words: 0, activeMs: 0 })
    expect(status.today.words).toBe(100)
  })
})

describe('readGoals / updateGoals (F-10.3)', () => {
  it('starts with no targets and stores a patch', () => {
    expect(readGoals(db)).toEqual(defaultGoals())
    const stored = updateGoals(db, {
      projectTarget: 80_000,
      deadline: '2026-12-31',
      dailyTarget: 500,
      nodeTargets: [{ nodeId: chapter().id, target: 4000 }]
    })
    expect(stored).toEqual({
      projectTarget: 80_000,
      deadline: '2026-12-31',
      dailyTarget: 500,
      nodeTargets: { [chapter().id]: 4000 }
    })
    expect(getGoals(db)).toEqual(stored)
  })

  it('refuses a target on a node outside the manuscript but accepts clearing one', () => {
    try {
      updateGoals(db, { nodeTargets: [{ nodeId: section('manuscript').id, target: 10 }] })
      throw new Error('expected VALIDATION')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('VALIDATION')
    }
    expect(
      updateGoals(db, { nodeTargets: [{ nodeId: 'gone', target: null }] }).nodeTargets
    ).toEqual({})
  })

  it('prunes targets of deleted nodes on read and rewrites the row', () => {
    const s = scene()
    setGoals(db, { ...defaultGoals(), nodeTargets: { [s.id]: 1000, ghost: 5 } })
    expect(readGoals(db).nodeTargets).toEqual({ [s.id]: 1000 })
    expect(getGoals(db).nodeTargets).toEqual({ [s.id]: 1000 })
    deleteNode(db, s.id)
    expect(readGoals(db).nodeTargets).toEqual({})
  })
})

describe('goalsStatus (F-10.3)', () => {
  it('rolls up manuscript words only and computes pace and streak', () => {
    const s = scene()
    saveDocument(db, s.id, para('a b c d e f g h i j'))
    saveDocument(db, matterDocument().id, para('not counted here at all'))
    updateGoals(db, { projectTarget: 110, deadline: '2026-10-13', dailyTarget: 100 })
    recordWriting(db, 100, at(9, 0, 3))
    recordWriting(db, 120, at(9, 0, 4))
    const status = goalsStatus(db, at(12))
    expect(status.manuscriptWords).toBe(10)
    expect(status.daysLeft).toBe(10)
    expect(status.perDayNeeded).toBe(10)
    expect(status.streak).toEqual({ current: 2, best: 2 })
  })

  it('has no pace, streak, or deadline figures without targets', () => {
    const status = goalsStatus(db, at(12))
    expect(status.daysLeft).toBeNull()
    expect(status.perDayNeeded).toBeNull()
    expect(status.streak).toEqual({ current: 0, best: 0 })
  })
})
