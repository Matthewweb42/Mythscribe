import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sceneSentences } from '@shared/memory/anchor'
import { emptyYields } from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { KnowsGrid, SceneMemory, SheetMemory } from '@shared/memory/views'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { createAuthorTodo, listAuthorTodos } from '../authorTodoStore'
import { getDismissedByKey, listDismissed, undoDismissed } from '../dismissedStore'
import { invariantIndexed, scanNamesFor } from '../nameIndexer'
import { createRecord, getRecord, invariantAliases, listRecords } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { revealIn, sceneTexts, seedClaims } from './claimFixture'
import { getClaim, invariantClaims, invariantKnows } from './claimStore'
import { listKnewBefore, setKnewBefore } from './knewBeforeStore'
import { insertReading } from './readingStore'
import { getTopicSnapshots } from './readerRows'
import { applyRebuildAction, rebuildSummary, startRebuild } from './rebuild'
import { writeSceneRead } from './sceneReadStore'
import { restoreTopicNotRight, splitReveal, topicNotRight } from './topicActions'
import {
  createTopic,
  invariantTopics,
  listTopics,
  mergeInto,
  recordTopicQuotes
} from './topicStore'
import { knowsGridMemory, sceneMemory, sheetMemory } from './views'

/**
 * Who knows what as the panel, the Book grid and the sheets show it (F-16.22; plan P2b §4.1, §4.3):
 * the views over a stored book (scene secrets, tension lines, the grid, a knower's Knows, a
 * secret's own view), the author's *Knew before the book*, *Split* and *Not a secret* with its
 * *Undo*, and the rebuild summary's "New secrets and threads".
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let two: string
let three: string
let mara: string
let orrin: string
let tomas: string
let quay: string

const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))
const LATER = new Date(Date.UTC(2026, 9, 13, 13, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const SCENE_ONE = [
  'Mara watched from the stair.',
  'Tomas sold the map to a stranger.',
  'Orrin overheard Tomas from the yard.'
]
const SCENE_TWO = ['Mara waited at the quay.']
const SCENE_THREE = ['The map had been sold by Tomas.']

function record(name: string, categoryId = 'character'): string {
  const made = createRecord(db, { name, categoryId, force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

function scene(title: string, chapter: string): string {
  return createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title
  }).id
}

function details(nodeId: string, pov: string, alsoHere: string[] = []): void {
  setSceneDetails(
    db,
    nodeId,
    {
      povRecordId: pov,
      place: { recordId: null, text: '' },
      time: { text: '' },
      storyYear: null,
      alsoHere
    },
    NOW
  )
}

/** A full `reader.v2` reading of the scene that left nothing unread (P2b-D9's flags). */
function checked(nodeId: string): void {
  writeSceneRead(
    db,
    {
      nodeId,
      draftId: activeDraftId(db),
      entries: [],
      full: true,
      readingId: null,
      topics: true,
      settled: true
    },
    NOW
  )
}

/** "the sold map", revealed in scene one, with Tomas knowing it before and Orrin overhearing it. */
function soldMap(readingId: string | null = null): string {
  const { recordId } = createTopic(
    db,
    {
      kind: 'secret',
      label: 'the sold map',
      quote: revealIn(db, one, {
        para: 1,
        quote: 'Tomas sold the map',
        label: 'the sold map',
        readingId
      })
    },
    NOW
  )
  seedClaims(
    db,
    one,
    [
      {
        recordId: orrin,
        slot: 'knows',
        value: 'overheard',
        how: 'overheard',
        fromId: tomas,
        objectId: recordId,
        quote: 'Orrin overheard Tomas',
        para: 2,
        proof: 'verified'
      },
      {
        recordId: tomas,
        slot: 'knows',
        value: 'knewBefore',
        how: 'knewBefore',
        objectId: recordId,
        quote: 'Tomas sold the map',
        para: 1,
        proof: 'verified'
      }
    ],
    NOW
  )
  return recordId
}

function invariants(): ReturnType<typeof checkMemoryInvariants> {
  const scenes = new Map(
    manuscriptDocuments(db).map((row) => [
      row.id,
      new Set(sceneSentences(sceneTexts(db, row.id)).map((sentence) => sentence.hash))
    ])
  )
  return checkMemoryInvariants({
    claims: invariantClaims(db),
    sceneHashes: scenes,
    aliases: invariantAliases(db),
    citations: [],
    knows: invariantKnows(db),
    topics: invariantTopics(db),
    indexed: invariantIndexed(db)
  })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-knows-views-'))
  session = createProject(projectFolderFor(tmp, 'Knows'), 'Knows', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, one)?.parentId ?? ''
  two = scene('Two', chapter)
  three = scene('Three', chapter)
  saveDocument(db, one, doc(...SCENE_ONE))
  saveDocument(db, two, doc(...SCENE_TWO))
  saveDocument(db, three, doc(...SCENE_THREE))
  mara = record('Mara')
  orrin = record('Orrin')
  tomas = record('Tomas')
  quay = record('the Quay', 'setting')
  for (const id of [one, two, three]) scanNamesFor(db, id, NOW)
  details(one, mara, [orrin, tomas])
  details(two, mara)
  details(three, mara)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('This scene’s Who knows what (F-16.22, P2b-D21)', () => {
  it('shows the secret the scene touches, its holders, and who Here has no line, scoped', () => {
    const map = soldMap()
    let memory = SceneMemory.parse(sceneMemory(db, one))
    expect(memory.secrets.touched.map((each) => each.secret.label)).toEqual(['the sold map'])
    const [touched] = memory.secrets.touched
    expect(touched?.secret.cells.map((cell) => [cell.knowerId, cell.how, cell.fromId])).toEqual([
      [tomas, 'knewBefore', null],
      [orrin, 'overheard', tomas]
    ])
    expect(touched?.secret.readersSince).toMatchObject({ nodeId: one, ref: '1.1', stale: false })
    // Mara is Here (the POV) with no line: a reference to what was checked, never a sentence.
    expect(touched?.without).toEqual([mara])
    expect(memory.secrets.checkedUpTo).toBeNull()
    checked(one)
    memory = SceneMemory.parse(sceneMemory(db, one))
    expect(memory.secrets.checkedUpTo).toEqual({ nodeId: one, ref: '1.1' })
    expect(map).not.toBe('')
  })

  it('gives a later scene the POV’s tension line and "+ N more", until she knew it before', () => {
    const map = soldMap()
    checked(one)
    checked(two)
    let memory = sceneMemory(db, two)
    expect(memory.secrets.touched).toEqual([])
    expect(memory.secrets.tension).toEqual([
      {
        kind: 'readersKnow',
        secretId: map,
        label: 'the sold map',
        since: { nodeId: one, ref: '1.1', stale: false },
        recordId: mara,
        stale: false
      }
    ])
    expect(memory.secrets.more).toBe(1)
    expect(memory.secrets.checkedUpTo).toEqual({ nodeId: two, ref: '1.2' })
    expect(setKnewBefore(db, map, mara, true, NOW)).toBe(true)
    memory = sceneMemory(db, two)
    expect(memory.secrets.tension).toEqual([])
    expect(memory.secrets.more).toBe(1)
  })

  it('never says anyone does not know, whatever the book holds', () => {
    soldMap()
    checked(one)
    for (const id of [one, two, three]) {
      expect(JSON.stringify(sceneMemory(db, id).secrets)).not.toMatch(
        /No scene shows|doesn.?t know|does not know|checked up to/i
      )
    }
  })
})

describe('the Book’s grid (memory:knows, P2b-D20)', () => {
  it('lists the secrets readers know as of the scene, the knowers and the POV', () => {
    const map = soldMap()
    checked(one)
    checked(two)
    const grid = KnowsGrid.parse(knowsGridMemory(db, two))
    expect(grid.rows.map((row) => row.recordId)).toEqual([map])
    expect(grid.columns).toContain(tomas)
    expect(grid.columns).toContain(orrin)
    expect(grid.columns).toContain(mara)
    expect(grid.asOfRef).toBe('1.2')
    expect(grid.checkedUpTo).toEqual({ nodeId: two, ref: '1.2' })
    expect(grid.later).toBe(0)
  })

  it('reads as of the end of the book, and adds the author’s knew-before cell', () => {
    const map = soldMap()
    setKnewBefore(db, map, mara, true, NOW)
    const grid = knowsGridMemory(db, null)
    expect(grid.asOf).toBeNull()
    const cell = grid.rows[0]?.cells.find((each) => each.knowerId === mara)
    expect(cell).toMatchObject({ source: 'author', how: 'knewBefore', claimId: null })
    expect(listKnewBefore(db)).toEqual([{ secretId: map, recordId: mara }])
    expect(setKnewBefore(db, map, mara, false, NOW)).toBe(true)
    expect(knowsGridMemory(db, null).rows[0]?.cells.some((each) => each.knowerId === mara)).toBe(
      false
    )
  })

  it('counts secrets readers learn later, and carries each reveal’s reading for ⓘ', () => {
    const readingId = insertReading(
      db,
      {
        nodeId: one,
        draftId: activeDraftId(db),
        purpose: 'first',
        pages: 1,
        paras: [[0, 2]],
        promptVersion: 'reader.v2',
        verifyVersion: 'verify.v2',
        model: 'flash',
        tokensIn: 4000,
        tokensOut: 500,
        reasoningTokens: 0,
        costUsd: 0.001,
        cloud: false,
        finishReason: null,
        yields: emptyYields()
      },
      NOW
    )
    soldMap(readingId)
    expect(knowsGridMemory(db, null).rows[0]?.defining?.reading).toMatchObject({
      model: 'flash',
      costUsd: 0.001
    })
    // A secret scene three reveals is not a row as of scene two: readers learn it later.
    laterSecret()
    const asOfTwo = knowsGridMemory(db, two)
    expect(asOfTwo.rows.map((row) => row.label)).toEqual(['the sold map'])
    expect(asOfTwo.later).toBe(1)
    expect(knowsGridMemory(db, null).rows.map((row) => row.label)).toEqual([
      'the map sale',
      'the sold map'
    ])
  })
})

/** "the map sale", revealed in scene three, where Orrin learns it too. */
function laterSecret(): string {
  const { recordId } = createTopic(
    db,
    {
      kind: 'secret',
      label: 'the map sale',
      quote: revealIn(db, three, {
        para: 0,
        quote: 'The map had been sold by Tomas',
        label: 'the map sale'
      })
    },
    NOW
  )
  seedClaims(
    db,
    three,
    [
      {
        recordId: orrin,
        slot: 'knows',
        value: 'deduced',
        how: 'deduced',
        objectId: recordId,
        quote: 'The map had been sold by Tomas',
        para: 0,
        proof: 'verified'
      }
    ],
    NOW
  )
  return recordId
}

describe('sheets: Knows and The secret (memory:sheet, F-16.22)', () => {
  it('gives a knower its lines, a secret its own view, and other records neither', () => {
    const map = soldMap()
    setKnewBefore(db, map, mara, true, NOW)
    const orrinSheet = SheetMemory.parse(sheetMemory(db, orrin, two))
    expect(orrinSheet.knows?.lines.map((line) => [line.label, line.cell.how])).toEqual([
      ['the sold map', 'overheard']
    ])
    expect(orrinSheet.topic).toBeNull()
    const maraSheet = sheetMemory(db, mara, two)
    expect(maraSheet.knows?.lines[0]?.cell).toMatchObject({ source: 'author' })
    const secretSheet = SheetMemory.parse(sheetMemory(db, map, two))
    expect(secretSheet.knows).toBeNull()
    expect(secretSheet.topic?.kind).toBe('secret')
    if (secretSheet.topic?.kind === 'secret') {
      expect(secretSheet.topic.secret.defining?.quote).toBe('Tomas sold the map')
      expect(secretSheet.topic.secret.knewBefore).toEqual([mara])
    }
    const place = sheetMemory(db, quay, two)
    expect(place.knows).toBeNull()
    expect(place.topic).toBeNull()
  })

  it('counts a knower’s lines that come later in the book', () => {
    soldMap()
    laterSecret()
    expect(sheetMemory(db, orrin, two).knows).toMatchObject({ later: 1 })
    expect(sheetMemory(db, orrin, two).knows?.lines.map((line) => line.label)).toEqual([
      'the sold map'
    ])
    expect(sheetMemory(db, orrin, null).knows?.lines.map((line) => line.cell.how)).toEqual([
      'deduced',
      'overheard'
    ])
  })
})

describe('Split and Not a secret (P2b-D5, D13)', () => {
  function mergedSale(map: string): string {
    const [line] = seedClaims(
      db,
      three,
      [
        {
          recordId: tomas,
          slot: 'knows',
          value: 'tells',
          how: 'tells',
          objectId: map,
          quote: 'The map had been sold by Tomas',
          para: 0,
          proof: 'verified'
        }
      ],
      NOW
    )
    return mergeInto(
      db,
      map,
      revealIn(db, three, {
        para: 0,
        quote: 'The map had been sold by Tomas',
        label: 'the map sale'
      }),
      [line ?? ''],
      NOW
    )
  }

  it('splits a merged reveal into a secret of its own, with a split row', () => {
    const map = soldMap()
    const merged = mergedSale(map)
    const result = splitReveal(db, merged, LATER)
    expect(getRecord(db, result.recordId)).toMatchObject({ name: 'the map sale', origin: 'ai' })
    expect(result.dismissed.kind).toBe('split')
    expect(result.change.topicIds).toEqual([map, result.recordId])
    expect(result.change.nodeIds).toContain(three)
    expect(result.change.recordIds).toEqual([tomas])
    expect(listTopics(db, 'secret')).toHaveLength(2)
    expect(invariants()).toEqual([])
  })

  it('takes an AI-made secret away with its lines, and Undo brings it all back', () => {
    const map = soldMap()
    const merged = mergedSale(map)
    setKnewBefore(db, map, mara, true, NOW)
    const todo = createAuthorTodo(db, { text: 'Check the map', nodeId: null, recordId: map }, NOW)
    const count = listDismissed(db).count
    const { dismissed, change } = topicNotRight(db, map, LATER)
    // One row per reveal (the defining one and the merged one).
    expect(dismissed).toHaveLength(2)
    expect(dismissed.every((row) => row.kind === 'notRight' && row.recordId === null)).toBe(true)
    expect(dismissed.map((row) => row.label)).toEqual([
      'Not a secret: the sold map',
      'Not a secret: the sold map'
    ])
    expect(change.topicIds).toEqual([map])
    expect(change.recordIds.sort()).toEqual([orrin, tomas].sort())
    expect(getRecord(db, map)).toBeNull()
    expect(listKnewBefore(db)).toEqual([])
    expect(listDismissed(db).count).toBe(count + 2)
    expect(listAuthorTodos(db).find((each) => each.id === todo.id)?.recordId).toBeNull()
    expect(getTopicSnapshots(db)).toHaveLength(1)
    expect(invariants()).toEqual([])

    // Undo on either row brings it back as it was, and takes the other row off the list.
    const [first, second] = dismissed
    undoDismissed(db, second?.id ?? '')
    const restored = restoreTopicNotRight(db, second?.id ?? '')
    expect(restored?.undone).toEqual([first?.id])
    expect(listDismissed(db).count).toBe(count)
    expect(getRecord(db, map)).toMatchObject({ name: 'the sold map', origin: 'ai' })
    expect(
      recordTopicQuotes(db, map)
        .map((quote) => quote.role)
        .sort()
    ).toEqual(['defining', 'merged'])
    expect(listKnewBefore(db)).toEqual([{ secretId: map, recordId: mara }])
    expect(listAuthorTodos(db).find((each) => each.id === todo.id)?.recordId).toBe(map)
    const tagged = sceneMemory(db, three).claims.find((claim) => claim.slot === 'knows')
    expect(getClaim(db, tagged?.id ?? '')?.topicQuoteId).toBe(merged)
    expect(getTopicSnapshots(db)).toEqual([])
    expect(invariants()).toEqual([])
    // Split still works on the restored merge.
    expect(splitReveal(db, merged, LATER).recordId).not.toBe(map)
  })

  it('keeps the same reveal from making it again, and refuses the author’s own secrets', () => {
    const map = soldMap()
    const { dismissed } = topicNotRight(db, map, LATER)
    const quote = revealIn(db, one, { para: 1, quote: 'Tomas sold the map', label: 'x' })
    const key = dismissedKey({
      kind: 'notRight',
      topic: { kind: 'secret', stating: quote.stating }
    })
    expect(getDismissedByKey(db, 'notRight', key)?.id).toBe(dismissed[0]?.id)
    const mine = record('the hidden will', 'secret')
    expect(() => topicNotRight(db, mine, LATER)).toThrow(/You made this secret/)
    expect(() => topicNotRight(db, mara, LATER)).toThrow(/Only a secret or a thread/)
  })

  it('puts a restored label beside one another record took since', () => {
    const map = soldMap()
    const { dismissed } = topicNotRight(db, map, LATER)
    record('the sold map', 'secret')
    undoDismissed(db, dismissed[0]?.id ?? '')
    restoreTopicNotRight(db, dismissed[0]?.id ?? '')
    expect(getRecord(db, map)?.name).toBe('the sold map (secret)')
    expect(restoreTopicNotRight(db, dismissed[0]?.id ?? '')).toBeNull()
  })
})

describe('Rebuild memory’s New secrets and threads (F-16.19, F-16.22)', () => {
  it('lists the topics the rebuild made, and Not right takes them all away', () => {
    const older = soldMap()
    startRebuild(db, NOW)
    const readingId = insertReading(
      db,
      {
        nodeId: three,
        draftId: activeDraftId(db),
        purpose: 'rebuild',
        pages: 1,
        paras: [[0, 0]],
        promptVersion: 'reader.v2',
        verifyVersion: 'verify.v2',
        model: 'flash',
        tokensIn: 1,
        tokensOut: 1,
        reasoningTokens: 0,
        costUsd: 0,
        cloud: false,
        finishReason: null,
        yields: emptyYields()
      },
      LATER
    )
    const { recordId: sale } = createTopic(
      db,
      {
        kind: 'secret',
        label: 'the map sale',
        quote: revealIn(db, three, {
          para: 0,
          quote: 'The map had been sold by Tomas',
          label: 'the map sale',
          readingId
        })
      },
      LATER
    )
    expect(rebuildSummary(db)?.topics).toEqual([
      { recordId: sale, kind: 'secret', label: 'the map sale' }
    ])
    const result = applyRebuildAction(db, { action: 'notTopics' }, LATER)
    expect(result).toMatchObject({ changed: 1, topicIds: [sale] })
    expect(getRecord(db, sale)).toBeNull()
    expect(getRecord(db, older)).not.toBeNull()
    expect(rebuildSummary(db)?.topics).toEqual([])
    expect(listRecords(db).some((each) => each.id === sale)).toBe(false)
  })
})
