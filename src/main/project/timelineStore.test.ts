import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptySceneMeta } from '@shared/sceneMeta'
import { TIMELINE_KEY, type TimelineEvent } from '@shared/timeline'
import { node, settings } from '../db/schema'
import { AppError } from '../ipc/errors'
import { getSceneMeta, setSceneMeta } from '../document/sceneMetaStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { createProject, projectFolderFor, type ProjectSession } from './projectStore'
import { getProjectTimeline } from './settingsStore'
import { setProjectTimeline } from './timelineStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

const event = (id: string, label: string, when = ''): TimelineEvent => ({
  id,
  label,
  when,
  year: null,
  note: ''
})

/** The first content node of `kind` (outside the section roots). */
function first(kind: 'document' | 'folder'): string {
  const row = listNodes(db).find((r) => r.kind === kind && r.sectionType === null)
  if (!row) throw new Error(`no ${kind}`)
  return row.id
}

function modifiedOf(id: string): string {
  return db.select().from(node).where(eq(node.id, id)).get()?.modified ?? ''
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-timeline-'))
  session = createProject(projectFolderFor(tmp, 'Timeline'), 'Timeline', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('getProjectTimeline', () => {
  it('answers no events for a new project and for an unreadable row', () => {
    expect(getProjectTimeline(db)).toEqual({ events: [] })
    db.insert(settings).values({ key: TIMELINE_KEY, value: '{not json' }).run()
    expect(getProjectTimeline(db)).toEqual({ events: [] })
  })
})

describe('setProjectTimeline', () => {
  it('stores the events in order and reads them back', () => {
    const result = setProjectTimeline(db, {
      events: [event('a', 'The siege begins', 'Spring'), event('b', 'The fall')]
    })
    expect(result.changedNodeIds).toEqual([])
    expect(getProjectTimeline(db).events.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('rewrites a linked scene when its event is renamed, and leaves unlinked nodes alone', () => {
    const scene = first('document')
    const chapter = first('folder')
    setProjectTimeline(db, { events: [event('a', 'The siege begins', 'Spring')] })
    setSceneMeta(db, scene, {
      ...emptySceneMeta(),
      pov: 'mara',
      timeline: 'Spring: The siege begins',
      eventId: 'a'
    })
    setSceneMeta(db, chapter, { ...emptySceneMeta(), timeline: 'Spring: The siege begins' })
    const chapterModified = modifiedOf(chapter)

    const result = setProjectTimeline(db, { events: [event('a', 'The siege', 'Early spring')] })

    expect(result.changedNodeIds).toEqual([scene])
    expect(getSceneMeta(db, scene).meta).toMatchObject({
      pov: 'mara',
      timeline: 'Early spring: The siege',
      eventId: 'a'
    })
    expect(getSceneMeta(db, chapter).meta.timeline).toBe('Spring: The siege begins')
    expect(modifiedOf(chapter)).toBe(chapterModified)
  })

  it('does not rewrite a linked scene whose text already matches', () => {
    const scene = first('document')
    setProjectTimeline(db, { events: [event('a', 'The fall')] })
    setSceneMeta(db, scene, { ...emptySceneMeta(), timeline: 'The fall', eventId: 'a' })
    expect(
      setProjectTimeline(db, { events: [{ ...event('a', 'The fall'), note: 'Rain' }] })
        .changedNodeIds
    ).toEqual([])
  })

  it('unlinks a scene whose event was deleted and keeps its text', () => {
    const scene = first('document')
    setProjectTimeline(db, { events: [event('a', 'The fall')] })
    setSceneMeta(db, scene, { ...emptySceneMeta(), timeline: 'The fall', eventId: 'a' })

    const result = setProjectTimeline(db, { events: [] })

    expect(result.changedNodeIds).toEqual([scene])
    const meta = getSceneMeta(db, scene).meta
    expect(meta.timeline).toBe('The fall')
    expect('eventId' in meta).toBe(false)
  })

  it('refuses duplicate labels and blank labels with VALIDATION and writes nothing', () => {
    setProjectTimeline(db, { events: [event('a', 'The fall')] })
    for (const events of [[event('a', 'The fall'), event('b', 'the FALL')], [event('a', '  ')]]) {
      try {
        setProjectTimeline(db, { events })
        throw new Error('expected VALIDATION')
      } catch (err) {
        expect(err).toBeInstanceOf(AppError)
        if (err instanceof AppError) expect(err.code).toBe('VALIDATION')
      }
    }
    expect(getProjectTimeline(db).events).toEqual([event('a', 'The fall')])
  })
})
