import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KNOWLEDGE_FACTS_VERSION } from '@shared/knowledge'
import type { TiptapNodeT } from '@shared/tiptap'
import { entity, fact, observedFact } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { createEntity } from '../entity/entityStore'
import { listFactsForEntity } from '../entity/factStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getKnowledgeModel } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { applyDerivedKnowledge } from './derive'
import { convertKnowledgeFacts } from './factConversion'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]
let mara: string

const TEXT = 'Mara had grey eyes. She was nineteen. Rosé and the café, in the rain.'
const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** An F-5.16 row as an older build writes it. */
function observed(
  id: string,
  nodeId: string,
  value: string,
  createdAt: string,
  hidden = false
): void {
  db.insert(observedFact)
    .values({
      id,
      entityId: mara,
      nodeId,
      attribute: 'appearance',
      value,
      quote: 'grey eyes',
      hidden,
      createdAt
    })
    .run()
}

/** The stored facts of Mara, baseline included, as origin:attribute=value:hidden. */
const stored = (): string[] =>
  db
    .select()
    .from(fact)
    .where(eq(fact.entityId, mara))
    .all()
    .map((row) => `${row.origin}:${row.attribute}=${row.value}:${row.hidden ? 'hidden' : 'shown'}`)
    .sort()

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-factconv-'))
  session = createProject(projectFolderFor(tmp, 'Convert'), 'Convert', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
  for (const id of scenes) saveDocument(db, id, doc(TEXT))
  mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '31' } }).entity.id
  // A project from before F-9.13: no author facts mirrored yet.
  db.delete(fact).run()
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('convertKnowledgeFacts (F-9.13)', () => {
  it('copies the observed facts (hidden kept) and mirrors the sheets, once', () => {
    observed('o1', scenes[0] ?? '', 'Grey eyes', '2026-10-01T00:00:00.000Z')
    observed('o2', scenes[0] ?? '', 'Tall', '2026-10-02T00:00:00.000Z', true)
    expect(convertKnowledgeFacts(db)).toEqual({ imported: 2, reconciled: 1 })
    expect(stored()).toEqual([
      'ai:appearance=Grey eyes:shown',
      'ai:appearance=Tall:hidden',
      'author:age=31:shown'
    ])
    expect(getKnowledgeModel(db)).toMatchObject({
      facts: KNOWLEDGE_FACTS_VERSION,
      factsImportedAt: '2026-10-02T00:00:00.000Z'
    })
    // Idempotent: nothing new, nothing moves.
    expect(convertKnowledgeFacts(db)).toEqual({ imported: 0, reconciled: 0 })
    expect(stored()).toHaveLength(3)
  })

  it('picks up what an older build wrote since: new observed facts, a hide, and a sheet edit', () => {
    observed('o1', scenes[0] ?? '', 'Grey eyes', '2026-10-01T00:00:00.000Z')
    convertKnowledgeFacts(db)
    // The older build re-read the scene (new rows, the same statement hidden) and edited the sheet.
    db.delete(observedFact).run()
    observed('o3', scenes[0] ?? '', 'Grey eyes', '2026-10-05T00:00:00.000Z', true)
    observed('o4', scenes[0] ?? '', 'A scar', '2026-10-05T00:00:00.000Z')
    db.update(entity).set({ fields: '{"age":"32"}' }).where(eq(entity.id, mara)).run()
    expect(convertKnowledgeFacts(db)).toEqual({ imported: 2, reconciled: 1 })
    expect(stored()).toEqual([
      'ai:appearance=A scar:shown',
      'ai:appearance=Grey eyes:hidden',
      'author:age=32:shown'
    ])
  })

  it('never changes scene text: the conversion and a reading leave every document byte-identical', () => {
    observed('o1', scenes[0] ?? '', 'Grey eyes', '2026-10-01T00:00:00.000Z')
    const read = (): string =>
      JSON.stringify(
        db.all(
          sql`SELECT id, content, notes, word_count, scene_meta, modified FROM node ORDER BY id`
        )
      )
    const drafts = (): string =>
      JSON.stringify(db.all(sql`SELECT * FROM draft_text ORDER BY draft_id, node_id`))
    const before = read()
    const draftsBefore = drafts()
    convertKnowledgeFacts(db)
    // The summary run's write side: facts, a new sheet and its tag, a tag on the scene, the log.
    applyDerivedKnowledge(db, {
      nodeId: scenes[0] ?? '',
      facts: [
        {
          entity: 'Mara',
          kind: 'character',
          attribute: 'age',
          value: 'nineteen',
          quote: 'She was nineteen.'
        },
        {
          entity: 'Brannoc',
          kind: 'character',
          attribute: 'appearance',
          value: 'Wet',
          quote: 'in the rain'
        }
      ],
      tags: [{ name: 'rainy', category: 'tone' }],
      sceneText: TEXT,
      now: new Date().toISOString()
    })
    expect(
      listFactsForEntity(db, mara)
        .map((row) => row.value)
        .sort()
    ).toEqual(['Grey eyes', 'nineteen'])
    expect(read()).toBe(before)
    expect(drafts()).toBe(draftsBefore)
  })
})
