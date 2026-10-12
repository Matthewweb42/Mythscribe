import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { changeRunId } from '@shared/changes'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import { relationAttribute } from '@shared/relations'
import { TAG_RANGE_MARK } from '@shared/tagRanges'
import { threadAttribute } from '@shared/threads'
import type { TiptapNodeT } from '@shared/tiptap'
import { fact, observedFact } from '../../db/schema'
import { saveDocument } from '../../document/documentStore'
import { saveNotes } from '../../document/notesStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { duplicateDraft, ensureDrafts } from '../../draft/draftStore'
import { addAuthorStatement, writeAuthorFact } from '../../entity/factStore'
import { createEntity, updateEntity, writeSheetSync } from '../../entity/entityStore'
import { paragraphHash } from '../../entity/sheetSyncState'
import { logChanges } from '../../knowledge/changeLog'
import { textPdf } from '../../library/pdfFixture'
import { addContextFiles } from '../../library/libraryStore'
import type { ProjectSession } from '../../project/projectStore'
import {
  setDismissedNames,
  setKeptSpellings,
  setObservedDismissed,
  setPlanLinkState
} from '../../project/settingsStore'
import { createSeededProject } from '../../project/testProject'
import { setProjectTimeline } from '../../project/timelineStore'
import { takeSnapshot } from '../../snapshot/snapshotStore'
import { addDocumentTag, replaceAutoTags } from '../../tag/documentTagStore'
import { createTag, updateTag } from '../../tag/tagStore'
import { listNodes } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'

/**
 * A rich story-memory v1 project for the switch-over's tests (F-16.15, plan P1 §6.4), built
 * through the real v1 stores (the AI's frozen tables, `fact` and `observed_fact`, take their rows
 * as the background reading wrote them): every tag category, nesting and aliases; inline tags in
 * a scene, its notes, an inactive draft and a snapshot; a tag range; structured, blank, Plan and
 * Idea sheets; an AI-made sheet, AI-written fields and a page paragraph from library and Organise
 * runs, and a sheet a library run made; a write-up paragraph (`sync.aiParagraphs`); the Project
 * notes; Word, PDF and image uploads; a timeline with years and linked runs; plot threads (a tag
 * and a sheet); dismissed names, kept spellings and a plan-link dismissal. Test support only.
 */

const SAMPLE_DOCX = path.join(import.meta.dirname, '../../import/fixtures/sample.docx')

const text = (value: string, marks?: TiptapNodeT['marks']): TiptapNodeT =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks }
const token = (id: string, name: string): TiptapNodeT => ({
  type: INLINE_TAG_NODE_TYPE,
  attrs: { id, name }
})
const paragraph = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'paragraph', content })
const doc = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content })

export interface FixtureV1 {
  session: ProjectSession
  folder: string
  /** The six manuscript scenes in reading order. */
  scenes: string[]
  entities: Record<
    | 'mara'
    | 'oren'
    | 'coin'
    | 'mill'
    | 'bell'
    | 'whisper'
    | 'notes'
    | 'ring'
    | 'harrowA'
    | 'harrowB',
    string
  >
  tags: Record<
    | 'mara'
    | 'tomas'
    | 'tomaz'
    | 'vell'
    | 'harbour'
    | 'guild'
    | 'mill'
    | 'melancholy'
    | 'violence'
    | 'grief'
    | 'reeds'
    | 'oren'
    | 'harrow',
    string
  >
  /** Scene 1's stored text, for the snapshot check. */
  sceneOneText: TiptapNodeT
  /** The id of the inactive draft. */
  draftId: string
  /** The project snapshot's id. */
  snapshotId: string
}

function requireTag(tagId: string | null): string {
  if (tagId === null) throw new Error('the fixture sheet has no tag')
  return tagId
}

/** Builds the fixture in `folder` (a path that does not exist yet). The session stays open. */
export async function buildFixtureV1(folder: string): Promise<FixtureV1> {
  const session = createSeededProject(folder, 'Harbour Book', 'novel')
  const db = session.connection.orm
  const now = new Date('2026-10-01T10:00:00.000Z').toISOString()
  const scenes = manuscriptDocuments(db).map((row) => row.id)
  const [s1, s2, s3, s4, s5] = scenes
  if (
    s1 === undefined ||
    s2 === undefined ||
    s3 === undefined ||
    s4 === undefined ||
    s5 === undefined
  ) {
    throw new Error('the seeded project has too few scenes')
  }

  // ---- Sheets (each makes or links its tag, F-9.4).
  const mara = createEntity(db, {
    kind: 'character',
    name: 'Mara Vell',
    template: 'structured',
    fields: { age: '35', appearance: 'Grey eyes.\n\nA scar over one brow.' }
  }).entity
  updateEntity(db, mara.id, { aliases: ['Mara'] })
  const oren = createEntity(db, {
    kind: 'character',
    name: 'Oren Hale',
    template: 'structured',
    fields: { personality: 'Quiet' }
  }).entity
  updateEntity(db, oren.id, { status: 'plan' })
  const coin = createEntity(db, {
    kind: 'item',
    name: 'Silver Coin',
    template: 'structured',
    fields: { origin: 'Minted in the old city' }
  }).entity
  updateEntity(db, coin.id, { status: 'idea' })
  const writeUp = 'Old Mill is a ruin by the river.'
  const mill = createEntity(db, {
    kind: 'setting',
    name: 'Old Mill',
    template: 'blank',
    body: `The mill burned in the flood year.\n\n${writeUp}`
  }).entity
  const whisper = createEntity(
    db,
    { kind: 'character', name: 'Whisper', template: 'structured', fields: { gender: 'unknown' } },
    'ai'
  ).entity
  const notes = createEntity(
    db,
    {
      kind: 'world',
      name: 'Project notes',
      template: 'blank',
      body: 'The book ends at the harbour.\n\nMaybe a sequel.'
    },
    'author',
    { tag: false }
  ).entity
  updateEntity(db, notes.id, { status: 'plan' })
  const ring = createEntity(db, {
    kind: 'thread',
    name: 'Missing ring',
    template: 'structured',
    fields: { description: 'Who took the ring?' }
  }).entity
  // Two sheets of one name in two categories share its tag (F-9.4).
  const harrowA = createEntity(db, {
    kind: 'character',
    name: 'Harrow',
    template: 'structured'
  }).entity
  const harrowB = createEntity(db, {
    kind: 'setting',
    name: 'Harrow',
    template: 'structured'
  }).entity

  // A library run made the Bell Tower sheet; it is unedited since.
  const bell = createEntity(db, {
    kind: 'setting',
    name: 'Bell Tower',
    template: 'structured',
    fields: { atmosphere: 'Cold and loud' }
  }).entity
  logChanges(
    db,
    changeRunId('library', 'upload-1'),
    [
      {
        kind: 'record',
        nodeId: null,
        quote: null,
        entityId: bell.id,
        targetId: bell.id,
        label: 'Made Bell Tower',
        undo: { type: 'deleteSheet', entityId: bell.id, tagId: bell.tagId, modified: bell.modified }
      }
    ],
    now
  )

  // Organise wrote Mara's personality (still as it left it); a library run wrote her background,
  // which the author has rewritten since; a library run added a paragraph to the Old Mill page.
  updateEntity(db, mara.id, {
    fields: { personality: 'Stubborn', background: 'Born at sea, raised inland' }
  })
  logChanges(
    db,
    changeRunId('organise', 'plan-1'),
    [
      {
        kind: 'sheetEdit',
        nodeId: null,
        quote: null,
        entityId: mara.id,
        targetId: mara.id,
        label: 'Mara Vell: personality',
        undo: {
          type: 'restoreSheet',
          entityId: mara.id,
          before: { fields: { personality: '' } },
          after: { fields: { personality: 'Stubborn' } }
        }
      }
    ],
    now
  )
  logChanges(
    db,
    changeRunId('library', 'upload-2'),
    [
      {
        kind: 'sheetEdit',
        nodeId: null,
        quote: null,
        entityId: mara.id,
        targetId: mara.id,
        label: 'Mara Vell: background',
        undo: {
          type: 'restoreSheet',
          entityId: mara.id,
          before: { fields: { background: '' } },
          after: { fields: { background: 'Born at sea' } }
        }
      },
      {
        kind: 'sheetEdit',
        nodeId: null,
        quote: null,
        entityId: mill.id,
        targetId: mill.id,
        label: 'Old Mill: page',
        undo: {
          type: 'restoreSheet',
          entityId: mill.id,
          before: { body: 'The mill burned in the flood year.' },
          after: { body: 'The mill burned in the flood year.\n\nThe wheel turns at night.' }
        }
      }
    ],
    now
  )
  updateEntity(db, mill.id, {
    body: `The mill burned in the flood year.\n\nThe wheel turns at night.\n\n${writeUp}`
  })
  writeSheetSync(db, mill.id, {
    fieldsHash: '',
    page: '',
    aiParagraphs: [paragraphHash(writeUp)],
    writtenUpAt: now,
    pageBefore: null,
    at: now
  })

  // ---- Tags without sheets, nesting, aliases, an AI tag.
  const tomas = createTag(db, { name: 'tomas', category: 'character' })
  updateTag(db, tomas.id, { aliases: ['Tom'] })
  const tomaz = createTag(db, { name: 'tomaz', category: 'character' })
  const vell = createTag(db, { name: 'vell', category: 'character' })
  const harbour = createTag(db, { name: 'harbour', category: 'setting' })
  const guild = createTag(db, { name: 'tide-guild', category: 'worldBuilding' })
  const burned = createTag(db, { name: 'the-burned-mill', category: 'plotThread' })
  const melancholy = createTag(db, { name: 'melancholy', category: 'tone', color: '#123456' })
  const violence = createTag(db, { name: 'violence', category: 'content' })
  const grief = createTag(db, { name: 'grief', category: 'custom', parentId: melancholy.id })
  const reeds = createTag(db, { name: 'whispering-reeds', category: 'worldBuilding' }, 'ai')

  // ---- Scenes: inline tags, a tag range, meta, links.
  const maraTag = requireTag(mara.tagId)
  const sceneOneText = doc(
    paragraph(
      text('Mara walked to the '),
      text('harbour', [{ type: TAG_RANGE_MARK, attrs: { tagId: harbour.id } }]),
      text(' with '),
      token(tomas.id, 'tomas'),
      text(' at dusk.')
    ),
    paragraph(text('The '), token(burned.id, 'the-burned-mill'), text(' smoked.'))
  )
  saveDocument(db, s1, sceneOneText)
  saveNotes(db, s1, doc(paragraph(text('Ask '), token(maraTag, 'mara-vell'), text(' later.'))))
  saveDocument(db, s2, doc(paragraph(text('Ilse counted the bells of the Bell Tower.'))))
  saveDocument(db, s3, doc(paragraph(text('Oren Hale waited for Mara.'))))
  saveDocument(db, s4, doc(paragraph(text('Rain.'))))
  addDocumentTag(db, s1, melancholy.id)
  addDocumentTag(db, s2, violence.id)
  addDocumentTag(db, s2, grief.id)
  // Oren is linked to scene 1 but never named there: "+ also here". Tomas is named (by the token).
  const orenTag = requireTag(oren.tagId)
  addDocumentTag(db, s1, orenTag)
  addDocumentTag(db, s1, tomas.id)
  replaceAutoTags(db, s2, [reeds.id, melancholy.id])

  // ---- Timeline: e1 (1820) on scenes 1–2, e2 (1821) on 3, e1 again on 4.
  const e1 = randomUUID()
  const e2 = randomUUID()
  setProjectTimeline(db, {
    events: [
      { id: e1, label: 'The flood', when: 'Spring', year: 1820, note: '' },
      { id: e2, label: 'The trial', when: '', year: 1821, note: '' }
    ]
  })
  setSceneMeta(db, s1, {
    location: 'harbour',
    pov: 'Mara Vell',
    timeline: 'Spring: The flood',
    eventId: e1
  })
  setSceneMeta(db, s2, {
    location: 'Bell Tower',
    pov: 'Ilse',
    timeline: 'Spring: The flood',
    eventId: e1
  })
  setSceneMeta(db, s3, { location: '', pov: 'oren-hale', timeline: 'The trial', eventId: e2 })
  setSceneMeta(db, s4, {
    location: '',
    pov: '',
    timeline: 'Spring: The flood',
    eventId: e1,
    status: 'idea'
  })

  // ---- Dated author lines, a relationship, a thread event; the AI's facts.
  writeAuthorFact(db, mara.id, 'age', '36', s3)
  addAuthorStatement(db, {
    entityId: mara.id,
    attribute: relationAttribute('mentor'),
    value: 'sworn teacher',
    objectEntityId: oren.id,
    nodeId: null
  })
  addAuthorStatement(db, {
    entityId: ring.id,
    attribute: threadAttribute('opened'),
    value: 'The ring is gone',
    objectEntityId: null,
    nodeId: s2
  })
  db.insert(fact)
    .values({
      id: randomUUID(),
      entityId: mara.id,
      attribute: 'appearance',
      value: 'tall',
      nodeId: s1,
      quote: 'Mara walked',
      origin: 'ai',
      status: 'canon',
      factKey: `ai\u0000${s1}\u0000appearance:tall`,
      createdAt: now,
      updatedAt: now
    })
    .run()
  db.insert(observedFact)
    .values({
      id: randomUUID(),
      entityId: mara.id,
      nodeId: s1,
      attribute: 'appearance',
      value: 'tall',
      quote: 'Mara walked',
      createdAt: now
    })
    .run()

  // ---- An inactive draft and a snapshot, both holding the inline tags.
  const state = ensureDrafts(db)
  const drafts = duplicateDraft(db, state.activeId, 'Second draft')
  const draftId = drafts.drafts.find((each) => each.name === 'Second draft')?.id ?? ''
  const snapshots = takeSnapshot(db, {
    scope: 'project',
    name: 'Before the switch',
    note: '',
    milestone: false
  })
  const snapshotId = snapshots[0]?.id ?? ''

  // ---- Uploads.
  await addContextFiles(db, folder, [
    { name: 'Harbour notes.docx', read: () => fs.readFileSync(SAMPLE_DOCX) },
    { name: 'Tide tables.pdf', read: () => textPdf(['Tide tables for 1820.']) },
    { name: 'Portrait.png', read: () => Buffer.from([137, 80, 78, 71, 1, 2]) }
  ])

  // ---- Dismissals: names, kept spellings, a plan link.
  setDismissedNames(db, { names: ['hesk', 'tomas'] })
  setObservedDismissed(db, { names: [{ kind: 'character', nameKey: 'brannoc' }] })
  setKeptSpellings(db, ['tomaz', 'falseer'])
  setPlanLinkState(db, { suggestions: [], dismissed: [`scene:${s5}>${s1}`], aiApplied: [] })

  // Sanity: the fixture's own folder holds no Research root (a v1 project never has one).
  const roots = listNodes(db).filter((row) => row.parentId === null)
  if (roots.some((row) => row.sectionType === 'research')) throw new Error('v1 has no Research')

  return {
    session,
    folder,
    scenes,
    entities: {
      mara: mara.id,
      oren: oren.id,
      coin: coin.id,
      mill: mill.id,
      bell: bell.id,
      whisper: whisper.id,
      notes: notes.id,
      ring: ring.id,
      harrowA: harrowA.id,
      harrowB: harrowB.id
    },
    tags: {
      mara: maraTag,
      tomas: tomas.id,
      tomaz: tomaz.id,
      vell: vell.id,
      harbour: harbour.id,
      guild: guild.id,
      mill: burned.id,
      melancholy: melancholy.id,
      violence: violence.id,
      grief: grief.id,
      reeds: reeds.id,
      oren: orenTag,
      harrow: requireTag(harrowA.tagId)
    },
    sceneOneText,
    draftId,
    snapshotId
  }
}
