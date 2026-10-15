import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dismissedKey } from '@shared/memory/dismissed'
import { gateText } from '@shared/memory/gate'
import { reconcile } from '@shared/memory/reconcile'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { dismissedKeys, listDismissed } from '../dismissedStore'
import { nameScanShared, scanNamesFor } from '../nameIndexer'
import { createRecord } from '../recordStore'
import { runAnchors } from './anchors'
import { seedClaims } from './claimFixture'
import { getClaim, sceneClaims } from './claimStore'
import { restoreNotRight } from './notRight'
import {
  acceptSuggestions,
  dismissSuggestions,
  listSuggestions,
  suggestionCount
} from './suggestions'
import { sceneMemory, sheetMemory } from './views'

/**
 * Story memory as suggestions you approve (F-16.17, plan `Suggestions.md`): what a reading proved
 * is a suggestion until the author accepts it; nothing reads it as memory before then.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let two: string
let mara: string
let tomas: string

const NOW = new Date(Date.UTC(2026, 9, 14, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function record(name: string): string {
  const made = createRecord(db, { name, categoryId: 'character', force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-suggestions-'))
  session = createProject(projectFolderFor(tmp, 'Suggestions'), 'Suggestions', 'novel')
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, one)?.parentId ?? ''
  two = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Scene 2'
  }).id
  mara = record('Mara Vell')
  tomas = record('Tomas')
  saveDocument(db, one, doc("Mara's eyes were grey.", 'Tomas sat by the nets.'))
  saveDocument(db, two, doc("Mara's hair was red.", 'Tomas was forty.'))
  scanNamesFor(db, one, NOW)
  scanNamesFor(db, two, NOW)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The four suggestions: grey eyes (verified) and Tomas by the nets in 1; red hair and 40 in 2. */
function seed(): { eyes: string; nets: string; hair: string; age: string } {
  const [eyes, nets] = seedClaims(
    db,
    one,
    [
      {
        recordId: mara,
        slot: 'eyes',
        value: 'grey',
        quote: "Mara's eyes were grey",
        para: 0,
        proof: 'verified',
        state: 'suggested'
      },
      {
        recordId: tomas,
        slot: 'location',
        value: 'by the nets',
        quote: 'Tomas sat by the nets',
        para: 1,
        state: 'suggested'
      }
    ],
    NOW
  )
  const [hair, age] = seedClaims(
    db,
    two,
    [
      {
        recordId: mara,
        slot: 'hair',
        value: 'red',
        quote: "Mara's hair was red",
        para: 0,
        state: 'suggested'
      },
      {
        recordId: tomas,
        slot: 'age',
        value: 'forty',
        quote: 'Tomas was forty',
        para: 1,
        proof: 'verified',
        state: 'suggested'
      }
    ],
    NOW
  )
  return { eyes: eyes ?? '', nets: nets ?? '', hair: hair ?? '', age: age ?? '' }
}

describe('the suggestions (F-16.17, plan Suggestions.md)', () => {
  it('lists them best first (literal, then verified), then in reading order, with their words', () => {
    const ids = seed()
    expect(listSuggestions(db).map((each) => each.id)).toEqual([
      ids.nets,
      ids.hair,
      ids.eyes,
      ids.age
    ])
    expect(listSuggestions(db, { nodeId: one }).map((each) => each.id)).toEqual([
      ids.nets,
      ids.eyes
    ])
    expect(listSuggestions(db, { recordId: mara }).map((each) => each.id)).toEqual([
      ids.hair,
      ids.eyes
    ])
    expect(listSuggestions(db, { claimIds: [ids.age] }).map((each) => each.id)).toEqual([ids.age])
    expect(listSuggestions(db, { nodeId: one })[1]).toMatchObject({
      name: 'Mara Vell',
      line: 'Eyes: grey',
      note: null,
      state: 'suggested',
      quote: "Mara's eyes were grey"
    })
    expect(suggestionCount(db)).toBe(4)
  })

  it('reads nothing as memory until accepted: True now, the sheet; then Accept and its Undo', () => {
    const ids = seed()
    const before = sceneMemory(db, one)
    expect(before.trueNow).toEqual([])
    expect(before.suggestions.map((each) => each.id)).toEqual([ids.nets, ids.eyes])
    expect(sheetMemory(db, mara, null).fixed).toEqual([])
    const change = acceptSuggestions(db, [ids.eyes, ids.nets, 'gone'])
    expect(change).toMatchObject({ claimIds: [ids.eyes, ids.nets], nodeIds: [one] })
    expect(change.recordIds.sort()).toEqual([mara, tomas].sort())
    expect(getClaim(db, ids.eyes)?.state).toBe('live')
    expect(sheetMemory(db, mara, null).fixed.map((line) => line.value.value)).toEqual(['grey'])
    expect(sceneMemory(db, one).suggestions).toEqual([])
    expect(suggestionCount(db)).toBe(2)
    // Accepting again changes nothing; Undo makes it a suggestion again.
    expect(acceptSuggestions(db, [ids.eyes]).claimIds).toEqual([])
    expect(acceptSuggestions(db, [ids.eyes], true).claimIds).toEqual([ids.eyes])
    expect(getClaim(db, ids.eyes)?.state).toBe('suggested')
    expect(sheetMemory(db, mara, null).fixed).toEqual([])
  })

  it('dismisses to the Dismissed list keyed by the sentence, so it is never suggested again', () => {
    const ids = seed()
    const result = dismissSuggestions(db, [ids.eyes], NOW)
    expect(result.dismissed).toEqual([
      expect.objectContaining({ kind: 'notRight', label: 'Mara Vell: Eyes grey', nodeId: one })
    ])
    expect(getClaim(db, ids.eyes)).toBeNull()
    expect(listDismissed(db).count).toBe(1)
    // A reading that proves it again drops it as dismissed.
    const stating = [gateText("Mara's eyes were grey.", nameScanShared(db).index)]
    const key = dismissedKey({
      kind: 'notRight',
      recordId: mara,
      slot: 'eyes',
      value: 'grey',
      stating
    })
    expect(dismissedKeys(db, 'notRight').has(key)).toBe(true)
    const again = reconcile({
      stored: [],
      window: { paras: new Set([0]), full: false },
      hashes: [],
      same: [],
      drop: [],
      rejected: new Set(),
      fresh: [
        {
          recordId: mara,
          pending: null,
          subjectText: null,
          slot: 'eyes',
          value: 'grey',
          valueKey: 'grey',
          objectId: null,
          how: null,
          fromId: null,
          topicQuoteId: null,
          voice: 'narration',
          speakerId: null,
          mode: 'now',
          quote: "Mara's eyes were grey",
          para: 0,
          anchor: [],
          stating,
          proof: 'literal',
          change: false
        }
      ],
      dismissed: dismissedKeys(db, 'notRight')
    })
    expect(again).toMatchObject({ inserts: [], dismissed: 1 })
    // Undo in Dismissed brings it back as it was: a suggestion.
    restoreNotRight(db, result.dismissed[0]?.id ?? '')
    expect(getClaim(db, ids.eyes)?.state).toBe('suggested')
    // A line already accepted is no suggestion to dismiss.
    acceptSuggestions(db, [ids.hair])
    expect(dismissSuggestions(db, [ids.hair], NOW).dismissed).toEqual([])
    expect(getClaim(db, ids.hair)?.state).toBe('live')
  })

  it('drops a suggestion whose sentence changed, where an accepted line goes stale', () => {
    const ids = seed()
    acceptSuggestions(db, [ids.nets])
    saveDocument(db, one, doc("Mara's eyes were brown.", 'Tomas stood by the nets.'))
    const result = runAnchors(db, one, NOW)
    expect(result.dropped).toEqual([ids.eyes])
    expect(result.staled).toEqual([ids.nets])
    expect(sceneClaims(db, one, activeDraftId(db)).map((each) => [each.id, each.state])).toEqual([
      [ids.nets, 'stale']
    ])
  })

  it('drops the suggestions of a scene no longer read, and lists none from it', () => {
    const ids = seed()
    setSceneMeta(db, two, { ...parseStoredSceneMeta(null), status: 'idea' })
    expect(listSuggestions(db).map((each) => each.id)).toEqual([ids.nets, ids.eyes])
    runAnchors(db, two, NOW)
    expect(getClaim(db, ids.hair)).toBeNull()
    expect(getClaim(db, ids.age)).toBeNull()
  })
})
