import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changeRunId } from '@shared/changes'
import { pageTextBlocks } from '@shared/memory/pageMarks'
import { FILED_BY_AI_HEADING } from '@shared/memory/switchoverMapping'
import { parseStoredSceneMeta, SCENE_META_TIMELINE_MAX } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { entity, node } from '../../db/schema'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { writeAuthorFact } from '../../entity/factStore'
import { createEntity, setEntityImage, updateEntity } from '../../entity/entityStore'
import { logChanges } from '../../knowledge/changeLog'
import type { ProjectSession } from '../../project/projectStore'
import {
  getCompileState,
  getPlanLinkState,
  setCompileState,
  setPlanLinkState
} from '../../project/settingsStore'
import { createSeededProject } from '../../project/testProject'
import { setProjectTimeline } from '../../project/timelineStore'
import { addDocumentTag } from '../../tag/documentTagStore'
import { createTag, updateTag } from '../../tag/tagStore'
import { manuscriptDocuments } from '../../voice/profile'
import { getRecord, listRecords } from '../recordStore'
import { getSceneDetails } from '../sceneDetailStore'
import { convertSwitchover, prepareSwitchover } from './convert'
import { buildSwitchoverModel, TIMELINE_NOTE_TITLE } from './model'
import { inlineTagReplacements, planSwitchover } from './plan'

/**
 * The switch-over's edge cases (F-16.15, P1 slice 6 review), each on a small seeded project
 * rather than the shared fixture: several AI runs on one sheet, a made sheet filled later, an AI
 * append to the author's own field, an AI sheet the author added to, a Plan sheet's AI text, the
 * plan links the AI applied, a long v1 timeline text, the place in "+ also here", nesting under a
 * record tag, compile exclusions in the rebuild price, and the timeline's events.
 */

let tmp: string
let session: ProjectSession
let scenes: string[]

const NOW = new Date('2026-10-12T09:00:00.000Z')
const db = (): ProjectSession['connection']['orm'] => session.connection.orm

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-switchover-cases-'))
  session = createSeededProject(path.join(tmp, 'Cases.mythscribe'), 'Cases', 'novel')
  scenes = manuscriptDocuments(db()).map((row) => row.id)
})

afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const CONTEXT = { source: 'local' as const, fastModel: 'm', strongModel: 'm', pricing: null }

/** A library run's page or field change, logged as `library` writes it (its own run id). */
function libraryEdit(
  entityId: string,
  run: string,
  before: { body?: string; fields?: Record<string, string> },
  after: { body?: string; fields?: Record<string, string> },
  at: string = new Date().toISOString()
): void {
  logChanges(
    db(),
    changeRunId('library', run),
    [
      {
        kind: 'sheetEdit',
        nodeId: null,
        quote: null,
        entityId,
        targetId: entityId,
        label: 'filled from the upload',
        undo: { type: 'restoreSheet', entityId, before, after }
      }
    ],
    at
  )
}

/** A sheet a library run made, logged as Apply logs it. */
function libraryMade(entityId: string, modified: string, at: string): void {
  logChanges(
    db(),
    changeRunId('library', `made-${entityId}`),
    [
      {
        kind: 'record',
        nodeId: null,
        quote: null,
        entityId,
        targetId: entityId,
        label: 'New sheet',
        undo: { type: 'deleteSheet', entityId, tagId: null, modified }
      }
    ],
    at
  )
}

const filedOf = (name: string): string[] =>
  planSwitchover(db(), CONTEXT).filedByAi.find((each) => each.name === name)?.lines ?? []

function lines(page: TiptapNodeT | null): string[] {
  if (page === null) return []
  return pageTextBlocks(page).map((block) => `${block.notCanon ? '✗ ' : ''}${block.text}`)
}

async function convertAll(): Promise<void> {
  const replacements = inlineTagReplacements(db()).map((row) => ({
    key: row.key,
    text: row.replacement
  }))
  const prepared = await prepareSwitchover(db(), session.folder)
  convertSwitchover(db(), 'novel', prepared, { replacements, merges: [] }, NOW)
}

function only(name: string): NonNullable<ReturnType<typeof getRecord>> {
  const found = listRecords(db()).find((each) => each.name === name)
  const full = found === undefined ? null : getRecord(db(), found.id)
  if (full === null) throw new Error(`no record ${name}`)
  return full
}

describe('what the AI wrote (decision 8)', () => {
  it('files every paragraph any AI run added to a page, not only the last run’s', async () => {
    const quay = createEntity(db(), {
      kind: 'setting',
      name: 'Quay',
      template: 'blank',
      body: 'Author line.'
    }).entity
    libraryEdit(quay.id, 'u1', { body: 'Author line.' }, { body: 'Author line.\n\nAI one.' })
    libraryEdit(
      quay.id,
      'u2',
      { body: 'Author line.\n\nAI one.' },
      { body: 'Author line.\n\nAI one.\n\nAI two.' }
    )
    updateEntity(db(), quay.id, { body: 'Author line.\n\nAI one.\n\nAI two.' })
    expect(filedOf('Quay')).toEqual(['AI one.', 'AI two.'])
    await convertAll()
    expect(lines(only('Quay').pinned)).toEqual([
      'Author line.',
      `✗ ${FILED_BY_AI_HEADING}`,
      '✗ AI one.',
      '✗ AI two.'
    ])
  })

  it('keeps the author’s own words in a field an AI run appended to', async () => {
    const ilse = createEntity(db(), {
      kind: 'character',
      name: 'Ilse',
      template: 'structured',
      fields: { notes: 'My own note: she lies about her age.' }
    }).entity
    const appended = 'My own note: she lies about her age.\n\nFrom the upload: a sailor.'
    updateEntity(db(), ilse.id, { fields: { notes: appended } })
    libraryEdit(
      ilse.id,
      'u1',
      { fields: { notes: 'My own note: she lies about her age.' } },
      { fields: { notes: appended } }
    )
    await convertAll()
    expect(lines(only('Ilse').pinned)).toEqual([
      'Notes: My own note: she lies about her age.',
      `✗ ${FILED_BY_AI_HEADING}`,
      '✗ Notes: From the upload: a sailor.'
    ])
  })

  it('keeps a made sheet the AI’s while only AI runs have written in it, and the author’s once she has', () => {
    const pier = createEntity(db(), {
      kind: 'setting',
      name: 'Pier',
      template: 'structured',
      fields: { atmosphere: 'Salt and tar' }
    }).entity
    libraryMade(pier.id, pier.modified, pier.modified)
    // A second run fills a field: `modified` moves, but only with the AI.
    const filled = updateEntity(db(), pier.id, { fields: { description: 'A long pier' } }).entity
    libraryEdit(
      pier.id,
      'u2',
      { fields: { description: '' } },
      { fields: { description: 'A long pier' } },
      filled.modified
    )
    expect([...filedOf('Pier')].sort()).toEqual([
      'Atmosphere: Salt and tar',
      'Description: A long pier'
    ])

    const dock = createEntity(db(), {
      kind: 'setting',
      name: 'Dock',
      template: 'structured',
      fields: { atmosphere: 'Busy' }
    }).entity
    libraryMade(dock.id, dock.modified, '2026-10-01T10:00:00.000Z')
    // The author wrote in it long after the run.
    db()
      .update(entity)
      .set({ modified: '2026-10-05T10:00:00.000Z' })
      .where(eq(entity.id, dock.id))
      .run()
    expect(filedOf('Dock')).toEqual([])
  })

  it('puts a Plan sheet’s AI text in Ideas, under the same heading', async () => {
    const cove = createEntity(db(), {
      kind: 'setting',
      name: 'Cove',
      template: 'blank',
      body: 'Maybe a smugglers’ cove.'
    }).entity
    updateEntity(db(), cove.id, { status: 'plan' })
    libraryEdit(
      cove.id,
      'u1',
      { body: 'Maybe a smugglers’ cove.' },
      { body: 'Maybe a smugglers’ cove.\n\nThe tide hides it.' }
    )
    updateEntity(db(), cove.id, { body: 'Maybe a smugglers’ cove.\n\nThe tide hides it.' })
    await convertAll()
    const cove2 = only('Cove')
    expect(cove2.pinned).toBeNull()
    expect(lines(cove2.ideas)).toEqual([
      'Maybe a smugglers’ cove.',
      `✗ ${FILED_BY_AI_HEADING}`,
      '✗ The tide hides it.'
    ])
  })

  it('keeps an AI sheet the author added a dated line or a picture to, and drops one she did not', async () => {
    const corvin = createEntity(
      db(),
      {
        kind: 'character',
        name: 'Corvin Ash',
        template: 'structured',
        fields: { personality: 'Sly' }
      },
      'ai'
    ).entity
    writeAuthorFact(db(), corvin.id, 'age', '52', scenes[0] ?? null)
    const gull = createEntity(
      db(),
      { kind: 'character', name: 'Gull', template: 'structured' },
      'ai'
    ).entity
    setEntityImage(db(), gull.id, 'gull.png')
    createEntity(db(), { kind: 'character', name: 'Whisper', template: 'structured' }, 'ai')
    const plan = planSwitchover(db(), CONTEXT)
    expect(plan.dropped.find((item) => item.name === 'Sheets the AI made')?.detail).toBe('Whisper')
    expect(plan.converted.find((item) => item.name === 'Corvin Ash')?.detail).toContain(
      'from a sheet the AI made, kept for what you added to it'
    )
    await convertAll()
    const kept = only('Corvin Ash')
    expect(lines(kept.pinned)[0]).toMatch(/^Age \(from 1\.1 '.*'\): 52$/)
    expect(lines(kept.pinned).slice(1)).toEqual([`✗ ${FILED_BY_AI_HEADING}`, '✗ Personality: Sly'])
    expect(only('Gull').image).toBe('gull.png')
    expect(listRecords(db()).some((each) => each.name === 'Whisper')).toBe(false)
  })
})

describe('the rest of the conversion', () => {
  it('takes the AI’s plan links off the outline and keeps the author’s', async () => {
    const [s1, s2, s3, s4] = scenes
    if (s1 === undefined || s2 === undefined || s3 === undefined || s4 === undefined) {
      throw new Error('too few scenes')
    }
    setSceneMeta(db(), s3, { location: '', pov: '', timeline: '', fulfilledBy: s1 })
    setSceneMeta(db(), s4, { location: '', pov: '', timeline: '', fulfilledBy: s2 })
    setPlanLinkState(db(), { suggestions: [], dismissed: [], aiApplied: [`scene:${s3}>${s1}`] })
    const plan = planSwitchover(db(), CONTEXT)
    expect(plan.dropped.find((item) => item.name === 'AI plan links')?.detail).toBe(
      '1 link the AI applied, taken off the outline'
    )
    await convertAll()
    const metaOf = (id: string) =>
      parseStoredSceneMeta(db().select().from(node).where(eq(node.id, id)).get()?.sceneMeta ?? null)
    expect(metaOf(s3).fulfilledBy).toBeUndefined()
    expect(metaOf(s4).fulfilledBy).toBe(s2)
    expect(getPlanLinkState(db()).aiApplied).toEqual([])
  })

  it('keeps every typed detail of a scene whose v1 timeline text is long', async () => {
    const [s1] = scenes
    if (s1 === undefined) throw new Error('no scene')
    createEntity(db(), { kind: 'character', name: 'Mara', template: 'structured' })
    const long = 'Late autumn, '.repeat(40).slice(0, SCENE_META_TIMELINE_MAX).trim()
    expect(long.length).toBeGreaterThan(200)
    setSceneMeta(db(), s1, { location: 'The harbour', pov: 'Mara', timeline: long })
    await convertAll()
    const details = getSceneDetails(db(), s1)
    expect(getRecord(db(), details.povRecordId ?? '')?.name).toBe('Mara')
    expect(details.place.text).toBe('The harbour')
    expect(details.time.text).toBe(long)
  })

  it('never lists the scene’s place under “also here”', () => {
    const [s1] = scenes
    if (s1 === undefined) throw new Error('no scene')
    const harbour = createTag(db(), { name: 'harbour', category: 'setting' })
    const tomas = createTag(db(), { name: 'tomas', category: 'character' })
    addDocumentTag(db(), s1, harbour.id)
    addDocumentTag(db(), s1, tomas.id)
    setSceneMeta(db(), s1, { location: 'harbour', pov: '', timeline: '' })
    const model = buildSwitchoverModel(db())
    const detail = model.details.find((each) => each.nodeId === s1)
    expect(detail?.placeKey).toBe(`tag:${harbour.id}`)
    expect(detail?.alsoHere).toEqual([`tag:${tomas.id}`])
  })

  it('names the nesting of every author tag, a record’s too', () => {
    const family = createTag(db(), { name: 'vell-family', category: 'character' })
    createTag(db(), { name: 'oren', category: 'character', parentId: family.id })
    // A sheet's own tag, nested too: it merges into the sheet's record, and its nesting goes.
    const sheet = createEntity(db(), {
      kind: 'character',
      name: 'Ilse',
      template: 'structured'
    }).entity
    if (sheet.tagId === null) throw new Error('the sheet has no tag')
    updateTag(db(), sheet.tagId, { parentId: family.id })
    expect(planSwitchover(db(), CONTEXT).notes).toContain(
      'Tag nesting is dropped: #oren under #vell-family, #ilse under #vell-family.'
    )
  })

  it('prices the rebuild without the scenes left out of compile', () => {
    const [s1] = scenes
    if (s1 === undefined) throw new Error('no scene')
    const body = (text: string): TiptapNodeT => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
    })
    for (const id of scenes) {
      db()
        .update(node)
        .set({ content: JSON.stringify(body('Words in the scene.')), wordCount: 4 })
        .where(eq(node.id, id))
        .run()
    }
    const all = buildSwitchoverModel(db()).rebuildScenes.length
    setCompileState(db(), { ...getCompileState(db()), excluded: [s1] })
    expect(buildSwitchoverModel(db()).rebuildScenes.length).toBe(all - 1)
  })

  it('keeps the timeline’s events, linked or not, as a written Research note', () => {
    setProjectTimeline(db(), {
      events: [
        { id: 'e1', label: 'The flood', when: 'Spring', year: 1820, note: 'The river rose.' },
        { id: 'e2', label: 'The wedding', when: '', year: null, note: '' }
      ]
    })
    const [s1] = scenes
    if (s1 === undefined) throw new Error('no scene')
    setSceneMeta(db(), s1, { location: '', pov: '', timeline: 'Spring: The flood', eventId: 'e1' })
    const note = buildSwitchoverModel(db()).research.find(
      (item) => item.kind === 'notes' && item.title === TIMELINE_NOTE_TITLE
    )
    expect(note?.kind === 'notes' ? note.lines.map((line) => line.text) : []).toEqual([
      'The flood (Spring, year 1820; scene 1.1): The river rose.',
      'The wedding'
    ])
  })
})
