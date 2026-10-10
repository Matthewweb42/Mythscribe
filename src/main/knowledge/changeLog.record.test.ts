import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planContextReview, type ContextReview } from '@shared/contextLibrary'
import { NO_UNDO_REASON } from '@shared/changes'
import { createEntity, getEntity, listEntities, updateEntity } from '../entity/entityStore'
import { listFactsForEntity, setFactStatus, writeAuthorFact } from '../entity/factStore'
import { AppError } from '../ipc/errors'
import { addContextFiles } from '../library/libraryStore'
import { applyContextReview } from '../library/apply'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { addDocumentTag, listDocumentTags } from '../tag/documentTagStore'
import { createTag, getTagWithUsage, listTags, updateTag } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { listChanges, noteCreatedSheet, recordChanges, undoChange, undoRun } from './changeLog'

/**
 * F-9.15: the Changes log as the one Undo of every story-bible change. Organise and the chat log
 * what they applied through `changes:record` (checked in main), the context library's Apply logs
 * its run itself, and an undo puts sheets and tags back only while they read as the change left
 * them. Merges and deletions are listed but never undone. No scene text is touched.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

const NOW = '2026-10-09T10:00:00.000Z'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-record-'))
  session = createProject(projectFolderFor(tmp, 'Record'), 'Record', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((row) => row.kind === 'document' && row.sectionType === null)?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (err) {
    if (err instanceof AppError) return `${err.code}: ${err.message}`
    throw err
  }
  return 'no refusal'
}

describe('changes:record (F-9.15)', () => {
  it('logs an Organise sheet edit under its run, and Undo puts the field back', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '27' } }).entity
    updateEntity(db, mara.id, { fields: { age: '28' } })
    const [entry] = recordChanges(
      db,
      {
        source: 'organise',
        run: 'org-1',
        changes: [
          {
            kind: 'sheetEdit',
            label: 'Sheet “Mara”: 1 field',
            undo: {
              type: 'restoreSheet',
              entityId: mara.id,
              before: { fields: { age: '27' } },
              after: { fields: { age: '28' } }
            }
          }
        ]
      },
      NOW
    )
    expect(entry).toMatchObject({
      runId: 'organise:org-1',
      source: 'organise',
      kind: 'sheetEdit',
      entityId: mara.id,
      undoable: true,
      status: 'applied'
    })
    const undone = undoChange(db, entry!.id)
    expect(getEntity(db, mara.id)?.fields.age).toBe('27')
    expect(undone.restoredEntityIds).toEqual([mara.id])
    expect(undone.entries.map((row) => row.status)).toEqual(['undone'])
  })

  it('refuses an undo once the author has changed the field since', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '28' } }).entity
    const [entry] = recordChanges(
      db,
      {
        source: 'chat',
        run: 'm-1',
        changes: [
          {
            kind: 'sheetEdit',
            label: 'Mara · Age',
            undo: {
              type: 'restoreSheet',
              entityId: mara.id,
              before: { fields: { age: '27' } },
              after: { fields: { age: '28' } }
            }
          }
        ]
      },
      NOW
    )
    updateEntity(db, mara.id, { fields: { age: '30' } })
    expect(refusal(() => undoChange(db, entry!.id))).toMatch(
      /^VALIDATION: "Mara" has changed since/
    )
    expect(getEntity(db, mara.id)?.fields.age).toBe('30')
    expect(listChanges(db, { limit: 10 }).entries[0]?.status).toBe('applied')
  })

  it('refuses to log a change that did not land, or an inverse its kind cannot carry', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '27' } }).entity
    const sheetEdit = (after: string) => ({
      source: 'organise' as const,
      run: 'org-1',
      changes: [
        {
          kind: 'sheetEdit' as const,
          label: 'Mara',
          undo: {
            type: 'restoreSheet' as const,
            entityId: mara.id,
            before: { fields: { age: '1' } },
            after: { fields: { age: after } }
          }
        }
      ]
    })
    expect(refusal(() => recordChanges(db, sheetEdit('99'), NOW))).toBe(
      'VALIDATION: The change is not in the story bible'
    )
    expect(
      refusal(() =>
        recordChanges(
          db,
          {
            source: 'chat',
            run: 'm-1',
            changes: [
              { kind: 'record', label: 'x', undo: { type: 'deleteRecord', entityId: mara.id } }
            ]
          },
          NOW
        )
      )
    ).toMatch(/^VALIDATION: This change cannot be logged/)
    expect(
      refusal(() =>
        recordChanges(
          db,
          {
            source: 'chat',
            run: 'm-1',
            changes: [
              {
                kind: 'sheetEdit',
                label: 'x',
                undo: {
                  type: 'restoreSheet',
                  entityId: 'nobody',
                  before: {},
                  after: {}
                }
              }
            ]
          },
          NOW
        )
      )
    ).toMatch(/^NOT_FOUND/)
    expect(listChanges(db, { limit: 10 }).entries).toEqual([])
  })

  it('lists a merge without an undo, refuses it with the reason, and passes it over in Undo run', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '28' } }).entity
    const entries = recordChanges(
      db,
      {
        source: 'organise',
        run: 'org-2',
        changes: [
          {
            kind: 'merge',
            label: 'Merge tags #mara-v into #mara',
            targetId: mara.tagId ?? 'tag',
            undo: { type: 'none', reason: NO_UNDO_REASON.merge }
          },
          {
            kind: 'sheetEdit',
            label: 'Mara',
            undo: {
              type: 'restoreSheet',
              entityId: mara.id,
              before: { fields: { age: '' } },
              after: { fields: { age: '28' } }
            }
          }
        ]
      },
      NOW
    )
    const merge = entries.find((entry) => entry.kind === 'merge')!
    expect(merge.undoable).toBe(false)
    expect(refusal(() => undoChange(db, merge.id))).toBe(`VALIDATION: ${NO_UNDO_REASON.merge}`)
    const run = undoRun(db, 'organise:org-2')
    expect(run.entries.map((entry) => entry.kind)).toEqual(['sheetEdit'])
    expect(getEntity(db, mara.id)?.fields.age).toBeUndefined()
    const listed = listChanges(db, { limit: 10 }).entries
    expect(listed.find((entry) => entry.id === merge.id)?.status).toBe('applied')
  })

  it('deletes a sheet Organise made with the tag it made, unless the author wrote in it since', () => {
    const made = createEntity(db, { kind: 'setting', name: 'The Ferry' }).entity
    noteCreatedSheet(db, made.id, made.tagId)
    const [entry] = recordChanges(
      db,
      {
        source: 'organise',
        run: 'org-3',
        changes: [
          {
            kind: 'record',
            label: 'New sheet “The Ferry”',
            undo: {
              type: 'deleteSheet',
              entityId: made.id,
              tagId: made.tagId,
              modified: made.modified
            }
          }
        ]
      },
      NOW
    )
    const result = undoChange(db, entry!.id)
    expect(getEntity(db, made.id)).toBeUndefined()
    expect(result.removedEntityIds).toEqual([made.id])
    expect(result.removedTagIds).toEqual([made.tagId])
    expect(listTags(db).map((tag) => tag.name)).not.toContain('the-ferry')

    const other = createEntity(db, { kind: 'setting', name: 'Greywater' }).entity
    noteCreatedSheet(db, other.id, null)
    const [second] = recordChanges(
      db,
      {
        source: 'organise',
        run: 'org-4',
        changes: [
          {
            kind: 'record',
            label: 'New sheet “Greywater”',
            undo: { type: 'deleteSheet', entityId: other.id, tagId: null, modified: other.modified }
          }
        ]
      },
      NOW
    )
    // A later stamp: the author wrote in it.
    updateEntity(db, other.id, { fields: { atmosphere: 'Fog.' } })
    expect(refusal(() => undoChange(db, second!.id))).toMatch(
      /^VALIDATION: You have edited "Greywater"/
    )
    expect(getEntity(db, other.id)).toBeDefined()
  })

  it('refuses a deleteSheet for a sheet this session did not make, or without its stamp', () => {
    const old = createEntity(db, { kind: 'setting', name: 'The Old Mill' }).entity
    const made = createEntity(db, { kind: 'setting', name: 'The Ferry' }).entity
    noteCreatedSheet(db, made.id, null)
    const record = (undo: {
      type: 'deleteSheet'
      entityId: string
      tagId: string | null
      modified?: string
    }) =>
      refusal(() =>
        recordChanges(
          db,
          { source: 'organise', run: 'org-9', changes: [{ kind: 'record', label: 'x', undo }] },
          NOW
        )
      )
    const notLanded = 'VALIDATION: The change is not in the story bible'
    expect(
      record({ type: 'deleteSheet', entityId: old.id, tagId: null, modified: old.modified })
    ).toBe(notLanded)
    expect(record({ type: 'deleteSheet', entityId: made.id, tagId: null })).toBe(notLanded)
    // The sheet's tag was not one this session noted as made with it.
    expect(
      record({ type: 'deleteSheet', entityId: made.id, tagId: made.tagId, modified: made.modified })
    ).toBe(notLanded)
    expect(listChanges(db, { limit: 10 }).entries).toEqual([])
  })

  it('refuses an inverse that reaches past its change: other parts, or a tag never taken off', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '28' } }).entity
    const tag = createTag(db, { name: 'stormbound', category: 'custom' })
    const notLanded = 'VALIDATION: The change is not in the story bible'
    const one = (change: Parameters<typeof recordChanges>[1]['changes'][number]) =>
      refusal(() => recordChanges(db, { source: 'chat', run: 'm-9', changes: [change] }, NOW))
    expect(
      one({
        kind: 'sheetEdit',
        label: 'Mara · Age',
        undo: {
          type: 'restoreSheet',
          entityId: mara.id,
          before: { name: 'Someone Else', fields: { age: '27' } },
          after: { fields: { age: '28' } }
        }
      })
    ).toBe(notLanded)
    expect(
      one({
        kind: 'sheetEdit',
        label: 'Mara · Age',
        undo: {
          type: 'restoreSheet',
          entityId: mara.id,
          before: { fields: { age: '27', goal: 'Revenge' } },
          after: { fields: { age: '28' } }
        }
      })
    ).toBe(notLanded)
    expect(
      one({
        kind: 'tagEdit',
        label: 'Tag',
        undo: {
          type: 'restoreTag',
          tagId: tag.id,
          before: { name: 'other', category: 'tone' },
          after: { name: 'stormbound' }
        }
      })
    ).toBe(notLanded)
    // Never on the scene, so the chat did not take it off: no Undo may put it on.
    expect(
      one({
        kind: 'tagLink',
        label: 'Untag the scene',
        undo: { type: 'linkTag', nodeId: scene, tagId: tag.id }
      })
    ).toBe(notLanded)
    expect(listChanges(db, { limit: 10 }).entries).toEqual([])
  })

  it('puts a tag back as it was, and a scene’s tag on or off as the chat left it', () => {
    const tag = createTag(db, { name: 'stormbound', category: 'custom' })
    updateTag(db, tag.id, { name: 'storm-bound' })
    addDocumentTag(db, scene, tag.id)
    const entries = recordChanges(
      db,
      {
        source: 'chat',
        run: 'm-2',
        changes: [
          {
            kind: 'tagEdit',
            label: 'Tag #stormbound: rename',
            undo: {
              type: 'restoreTag',
              tagId: tag.id,
              before: { name: 'stormbound' },
              after: { name: 'storm-bound' }
            }
          },
          {
            kind: 'tagLink',
            label: 'Tag the scene #storm-bound',
            undo: { type: 'unlinkTag', nodeId: scene, tagId: tag.id }
          }
        ]
      },
      NOW
    )
    expect(entries.find((entry) => entry.kind === 'tagLink')?.nodeId).toBe(scene)
    const result = undoRun(db, 'chat:m-2')
    expect(getTagWithUsage(db, tag.id)?.name).toBe('stormbound')
    expect(listDocumentTags(db, scene)).toEqual([])
    expect(result.restoredTagIds).toEqual([tag.id])
    expect(result.nodeIds).toEqual([scene])
    // A tag the chat took off is put back by its undo.
    const [off] = recordChanges(
      db,
      {
        source: 'chat',
        run: 'm-3',
        changes: [
          {
            kind: 'tagLink',
            label: 'Untag the scene',
            undo: { type: 'linkTag', nodeId: scene, tagId: tag.id }
          }
        ]
      },
      NOW
    )
    undoChange(db, off!.id)
    expect(listDocumentTags(db, scene).map((row) => row.id)).toEqual([tag.id])
  })
})

describe('the context library’s Apply in the Changes log (F-9.15)', () => {
  it('logs the sheets it made and filled as one run, and Undo run takes them back', async () => {
    const added = await addContextFiles(db, session.folder, [
      { name: 'people.md', read: () => Buffer.from('Mara is 35.', 'utf8') }
    ])
    const fileId = added.files[0]!.id
    const mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '34' } }).entity
    const plan = planContextReview({
      records: [
        {
          id: 'r-mara',
          fileId,
          fileName: 'people.md',
          kind: 'character',
          name: 'Mara',
          aliases: [],
          fields: { appearance: 'Grey eyes' },
          details: []
        },
        {
          id: 'r-tomas',
          fileId,
          fileName: 'people.md',
          kind: 'character',
          name: 'Tomas',
          aliases: [],
          fields: { age: '40' },
          details: []
        }
      ],
      existing: listEntities(db),
      categories: [],
      images: [],
      hints: [],
      notes: []
    })
    const review: ContextReview = {
      fileIds: [fileId],
      entities: plan.entities,
      notes: plan.notes,
      categories: [],
      proposalIds: [],
      chunks: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      model: 'gpt-5.4',
      promptVersion: 'contextImport.v1'
    }
    await applyContextReview(db, session.folder, review)
    const entries = listChanges(db, { limit: 10 }).entries
    expect(entries.map((entry) => [entry.source, entry.kind, entry.label]).sort()).toEqual([
      ['library', 'record', 'New sheet: Tomas'],
      ['library', 'sheetEdit', 'Mara: filled from the upload']
    ])
    const runId = entries[0]!.runId
    expect(runId.startsWith('library:')).toBe(true)
    undoRun(db, runId)
    expect(getEntity(db, mara.id)?.fields).toEqual({ age: '34' })
    expect(listEntities(db).map((entity) => entity.name)).not.toContain('Tomas')
    expect(listTags(db).map((tag) => tag.name)).not.toContain('tomas')
  })
})

describe('statuses the chat set (F-5.25, agent.v8)', () => {
  const statusRun = (
    kind: 'record' | 'fact',
    entityId: string,
    facts: { id: string; before: 'canon' | 'plan' | 'idea' }[],
    after: 'canon' | 'plan' | 'idea'
  ): Parameters<typeof recordChanges>[1] => ({
    source: 'chat',
    run: 'm-status',
    changes: [
      {
        kind,
        label: 'Marked',
        undo: { type: 'restoreStatus', entityId, facts, before: 'canon', after }
      }
    ]
  })

  it('logs a sheet’s status and puts it back; refuses once it moved again', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    expect(refusal(() => recordChanges(db, statusRun('record', mara.id, [], 'idea'), NOW))).toBe(
      'VALIDATION: The change is not in the story bible'
    )
    updateEntity(db, mara.id, { status: 'idea' })
    const [entry] = recordChanges(db, statusRun('record', mara.id, [], 'idea'), NOW)
    expect(entry).toMatchObject({ kind: 'record', entityId: mara.id, undoable: true })
    const undone = undoChange(db, entry!.id)
    expect(getEntity(db, mara.id)?.status).toBe('canon')
    expect(undone.restoredEntityIds).toEqual([mara.id])

    updateEntity(db, mara.id, { status: 'idea' })
    const [again] = recordChanges(db, statusRun('record', mara.id, [], 'idea'), NOW)
    updateEntity(db, mara.id, { status: 'plan' })
    expect(refusal(() => undoChange(db, again!.id))).toMatch(/^VALIDATION: The status on "Mara"/)
  })

  it('logs the statements’ status and puts each back; a fact row must name facts of the sheet', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    writeAuthorFact(db, mara.id, 'age', '19', scene)
    const age = listFactsForEntity(db, mara.id).find((f) => f.attribute === 'age')
    if (age === undefined) throw new Error('fact not written')
    expect(refusal(() => recordChanges(db, statusRun('fact', mara.id, [], 'plan'), NOW))).toBe(
      'VALIDATION: The change is not in the story bible'
    )
    setFactStatus(db, age.id, 'plan')
    const [entry] = recordChanges(
      db,
      statusRun('fact', mara.id, [{ id: age.id, before: 'idea' }], 'plan'),
      NOW
    )
    const undone = undoChange(db, entry!.id)
    expect(listFactsForEntity(db, mara.id).find((f) => f.id === age.id)?.status).toBe('idea')
    expect(undone.entityIds).toEqual([mara.id])
  })
})
