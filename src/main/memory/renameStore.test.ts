import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dismissedKey } from '@shared/memory/dismissed'
import { describeRenameKept, describeRenamePreview } from '@shared/memory/rename'
import { docToText } from '@shared/docText'
import type { TiptapNodeT } from '@shared/tiptap'
import { draftText } from '../db/schema'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { duplicateDraft, listDrafts } from '../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listSnapshots } from '../snapshot/snapshotStore'
import { createNode, getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { sceneSentences } from '@shared/memory/anchor'
import { emptyCardFields } from '@shared/memory/claims'
import { gateSentences, nextReadSet } from '@shared/memory/gate'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { activeDraftId } from '../draft/draftStore'
import { dismiss, getDismissedByKey, listDismissed } from './dismissedStore'
import { nameScanShared } from './nameIndexer'
import { runAnchors } from './reading/anchors'
import { getCard, upsertCard } from './reading/cardStore'
import { anchoredClaim, revealIn, sceneTexts, seedClaims } from './reading/claimFixture'
import { getClaim, insertClaims, invariantClaims } from './reading/claimStore'
import { getSceneRead, writeSceneRead } from './reading/sceneReadStore'
import { createTopic, getTopicQuote } from './reading/topicStore'
import { sceneMemory } from './reading/views'
import { createRecord, requireRecord } from './recordStore'
import {
  applyRename,
  clearRenameUndo,
  hasRenameUndo,
  previewRename,
  undoRename
} from './renameStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]
let hesk: string
let heskName: string

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const textOf = (id: string): string => {
  const content = getDocumentContent(db, id).content
  return content === null ? '' : docToText(content)
}

const draftTextOf = (draftId: string, nodeId: string): string => {
  const row = db
    .select()
    .from(draftText)
    .where(and(eq(draftText.draftId, draftId), eq(draftText.nodeId, nodeId)))
    .get()
  return row?.content == null ? '' : docToText(JSON.parse(row.content) as TiptapNodeT)
}

beforeEach(() => {
  clearRenameUndo()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-rename-'))
  session = createProject(projectFolderFor(tmp, 'Rename'), 'Rename', 'novel')
  db = session.connection.orm
  const first = manuscriptDocuments(db)[0]?.id ?? ''
  const parentId = getNode(db, first)?.parentId ?? ''
  const second = createNode(db, 'novel', {
    parentId,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  const third = createNode(db, 'novel', {
    parentId,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Three'
  }).id
  scenes = [first, second, third]
  saveDocument(db, first, doc('Hesk came in.', "Hesk's coat was wet; Heskel stayed out."))
  saveDocument(db, second, doc('They waited for Hesk.'))
  saveDocument(db, third, doc('Nobody came. hesk is a word here.'))
  const made = createRecord(db, { name: 'Hesk', categoryId: 'character' }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  hesk = made.record.id
  heskName = made.record.aliases[0]?.id ?? ''
})
afterEach(() => {
  clearRenameUndo()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const request = (to = 'Haskel') => ({ recordId: hesk, aliasId: heskName, to })
const applying = (
  to = 'Haskel',
  extra: { openId?: string | null; otherDrafts?: boolean } = {}
) => ({
  ...request(to),
  openId: extra.openId ?? null,
  otherDrafts: extra.otherDrafts ?? false
})

/** A record made for a test, with its id and its names' ids by text. */
function make(
  name: string,
  aliases: { text: string; shared?: boolean }[] = [],
  force = true
): { id: string; alias: (text: string) => string } {
  const made = createRecord(db, { name, categoryId: 'character', aliases, force }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  const record = made.record
  return {
    id: record.id,
    alias: (text) => record.aliases.find((each) => each.text === text)?.id ?? ''
  }
}

const otherDraft = (): string => {
  const active = listDrafts(db).drafts[0]?.id ?? ''
  duplicateDraft(db, active, 'Second')
  return listDrafts(db).drafts.find((each) => each.name === 'Second')?.id ?? ''
}

describe('previewRename (F-16.13)', () => {
  it('counts the places per scene in reading order, possessives included, with samples', () => {
    const preview = previewRename(db, request())
    expect(preview.from).toBe('Hesk')
    expect(preview.to).toBe('Haskel')
    expect(preview.scenes.map((scene) => [scene.nodeId, scene.count])).toEqual([
      [scenes[0], 2],
      [scenes[1], 1]
    ])
    expect(preview.scenes[1]?.samples.map((sample) => sample.after.text)).toEqual([
      'They waited for Haskel.'
    ])
    expect(preview.total).toBe(3)
    // "hesk" written in lower case is a word, not the name; "Heskel" is another word.
    expect(preview.kept).toEqual({ notMention: 0, unsure: 0, other: 0 })
    expect(preview.otherDrafts).toEqual({ matches: 0, scenes: 0 })
    expect(describeRenamePreview(preview)).toBe('3 matches in 2 scenes')
    expect(describeRenameKept(preview)).toBeNull()
  })

  it('counts the inactive drafts apart', () => {
    otherDraft()
    const preview = previewRename(db, request())
    expect(preview.total).toBe(3)
    expect(preview.otherDrafts).toEqual({ matches: 3, scenes: 2 })
    expect(describeRenamePreview(preview)).toBe('3 matches in 2 scenes (+3 in other drafts)')
  })

  it('refuses what the apply refuses, before the click', () => {
    expect(() => previewRename(db, { ...request(), aliasId: 'nope' })).toThrow(/no longer/)
    expect(() => previewRename(db, request('Hesk'))).toThrow(/already its name/)
    make('Haskel')
    expect(() => previewRename(db, request())).toThrow(/already a name of Haskel/)
  })
})

describe('applyRename (F-16.13)', () => {
  it('rewrites every scene and the name after a snapshot, and leaves the other drafts unticked', () => {
    const other = otherDraft()
    const result = applyRename(db, applying(), NOW)
    expect(textOf(scenes[0] ?? '')).toBe(
      "Haskel came in.\nHaskel's coat was wet; Heskel stayed out."
    )
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Haskel.')
    // A lower-case word is not the name (its case rule is exact for a capitalised name).
    expect(textOf(scenes[2] ?? '')).toBe('Nobody came. hesk is a word here.')
    expect(draftTextOf(other, scenes[0] ?? '')).toContain("Hesk's coat")
    expect(result.written.map((each) => [each.id, each.count])).toEqual([
      [scenes[0], 2],
      [scenes[1], 1]
    ])
    expect(result.drafts).toBe(0)
    expect(result.record.name).toBe('Haskel')
    expect(requireRecord(db, hesk).aliases[0]?.norm).toBe('haskel')
    const snapshots = listSnapshots(db)
    expect(snapshots[0]?.kind).toBe('auto')
    expect(snapshots[0]?.name).toBe('Before renaming "Hesk" to "Haskel"')
    expect(hasRenameUndo()).toBe(true)
  })

  it('rewrites the inactive drafts when ticked', () => {
    const other = otherDraft()
    const result = applyRename(db, applying('Haskel', { otherDrafts: true }), NOW)
    expect(result.drafts).toBe(3)
    expect(draftTextOf(other, scenes[0] ?? '')).toContain("Haskel's coat")
  })

  it('leaves the open scene to the editor and answers its places', () => {
    const result = applyRename(db, applying('Haskel', { openId: scenes[0] ?? '' }), NOW)
    expect(textOf(scenes[0] ?? '')).toContain('Hesk came in.')
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Haskel.')
    expect(result.openId).toBe(scenes[0])
    // ProseMirror ranges of the stored text: ¶1 holds 1–5, ¶2 starts at 16.
    expect(result.openEdits).toEqual([
      { from: 1, to: 5, text: 'Hesk', replacement: 'Haskel' },
      { from: 16, to: 20, text: 'Hesk', replacement: 'Haskel' }
    ])
    // The open scene's text is in the snapshot taken before.
    expect(listSnapshots(db)[0]?.docCount).toBeGreaterThan(0)
  })

  it('leaves a place the author marked Not a mention, and its mark', () => {
    const hope = make('Hope')
    saveDocument(
      db,
      scenes[2] ?? '',
      doc('Hope came in late.', 'All Hope was gone from the room.', 'Hope walked out.')
    )
    const key = dismissedKey({ kind: 'notMention', recordId: hope.id, phrase: 'All Hope was' })
    dismiss(db, { kind: 'notMention', key, recordId: hope.id, label: 'not Hope' }, NOW)
    const ask = { recordId: hope.id, aliasId: hope.alias('Hope'), to: 'Faith' }
    const preview = previewRename(db, ask)
    expect(preview.total).toBe(2)
    expect(preview.kept).toEqual({ notMention: 1, unsure: 0, other: 0 })
    expect(describeRenameKept(preview)).toBe('Left as they are: 1 marked Not a mention.')
    applyRename(db, { ...ask, openId: null, otherDrafts: false }, NOW)
    expect(textOf(scenes[2] ?? '')).toBe(
      'Faith came in late.\nAll Hope was gone from the room.\nFaith walked out.'
    )
    expect(getDismissedByKey(db, 'notMention', key)).not.toBeNull()
  })

  it('leaves a sentence start the scan does not count as the name ("Will" beside "will")', () => {
    const will = make('Will')
    saveDocument(
      db,
      scenes[2] ?? '',
      doc('Will walked to the door.', 'She said she will wait. Will you come back?')
    )
    const ask = { recordId: will.id, aliasId: will.alias('Will'), to: 'Bill' }
    const preview = previewRename(db, ask)
    expect(preview.total).toBe(0)
    expect(preview.kept.other).toBe(2)
    applyRename(db, { ...ask, openId: null, otherDrafts: false }, NOW)
    expect(textOf(scenes[2] ?? '')).toBe(
      'Will walked to the door.\nShe said she will wait. Will you come back?'
    )
    // The record is renamed all the same, and no prose changed, so no snapshot was needed.
    expect(requireRecord(db, will.id).name).toBe('Bill')
    expect(listSnapshots(db)).toEqual([])
  })

  it('leaves a longer name that holds the nickname ("Mara Vell" for "Mara")', () => {
    const mara = make('Mara Vell', [{ text: 'Mara' }])
    saveDocument(db, scenes[2] ?? '', doc('Mara Vell came in. Later Mara sat down.'))
    const ask = { recordId: mara.id, aliasId: mara.alias('Mara'), to: 'Mira' }
    const preview = previewRename(db, ask)
    expect(preview.total).toBe(1)
    expect(preview.kept.other).toBe(1)
    applyRename(db, { ...ask, openId: null, otherDrafts: false }, NOW)
    expect(textOf(scenes[2] ?? '')).toBe('Mara Vell came in. Later Mira sat down.')
    expect(requireRecord(db, mara.id).aliases.map((each) => each.text)).toEqual([
      'Mara Vell',
      'Mira'
    ])
  })

  it('leaves another record’s name that holds it, and refuses a name shared with another record', () => {
    const tomas = make('Tomas Harrow', [{ text: 'Harrow' }])
    make('Ella Harrow')
    saveDocument(db, scenes[2] ?? '', doc('Ella Harrow met Tomas Harrow. Harrow nodded.'))
    const ask = { recordId: tomas.id, aliasId: tomas.alias('Harrow'), to: 'Harlow' }
    applyRename(db, { ...ask, openId: null, otherDrafts: false }, NOW)
    expect(textOf(scenes[2] ?? '')).toBe('Ella Harrow met Tomas Harrow. Harlow nodded.')

    const rynna = make('Rynna Ash', [{ text: 'Ash', shared: true }])
    make('Bren Ash', [{ text: 'Ash', shared: true }])
    expect(() =>
      previewRename(db, { recordId: rynna.id, aliasId: rynna.alias('Ash'), to: 'Oak' })
    ).toThrow(/shared with Bren Ash/)
  })

  it('keeps the case of each place: all caps, and a sentence start for a lower-case nickname', () => {
    saveDocument(db, scenes[2] ?? '', doc('Hesk came in.', '"HESK!" she shouted.'))
    applyRename(db, applying(), NOW)
    expect(textOf(scenes[2] ?? '')).toBe('Haskel came in.\n"HASKEL!" she shouted.')

    const captain = make('Orla Brand', [{ text: 'the captain' }])
    saveDocument(db, scenes[1] ?? '', doc('The captain smiled.', 'She saw the captain wave.'))
    const ask = { recordId: captain.id, aliasId: captain.alias('the captain'), to: 'the skipper' }
    applyRename(db, { ...ask, openId: null, otherDrafts: false }, NOW)
    expect(textOf(scenes[1] ?? '')).toBe('The skipper smiled.\nShe saw the skipper wave.')
  })

  it('moves a Not a mention key whose phrase held the renamed word, and undo puts it back', () => {
    const mara = make('Mara')
    saveDocument(db, scenes[1] ?? '', doc('Hesk, Mara, and Tomas left.'))
    const key = dismissedKey({ kind: 'notMention', recordId: mara.id, phrase: 'Hesk, Mara, and' })
    dismiss(
      db,
      {
        kind: 'notMention',
        key,
        recordId: mara.id,
        label: '"Hesk, Mara, and" is not Mara',
        quote: 'Hesk, Mara, and'
      },
      NOW
    )
    applyRename(db, applying(), NOW)
    expect(textOf(scenes[1] ?? '')).toBe('Haskel, Mara, and Tomas left.')
    const moved = dismissedKey({
      kind: 'notMention',
      recordId: mara.id,
      phrase: 'Haskel, Mara, and'
    })
    expect(getDismissedByKey(db, 'notMention', key)).toBeNull()
    expect(getDismissedByKey(db, 'notMention', moved)?.label).toBe(
      '"Haskel, Mara, and" is not Mara'
    )
    undoRename(db, NOW)
    expect(getDismissedByKey(db, 'notMention', key)?.label).toBe('"Hesk, Mara, and" is not Mara')
    expect(listDismissed(db).count).toBe(1)
  })

  it('keeps the old key while an untouched draft still writes the phrase, with a row for the new one', () => {
    const mara = make('Mara')
    saveDocument(db, scenes[1] ?? '', doc('Hesk, Mara, and Tomas left.'))
    otherDraft()
    const key = dismissedKey({ kind: 'notMention', recordId: mara.id, phrase: 'Hesk, Mara, and' })
    dismiss(db, { kind: 'notMention', key, recordId: mara.id, label: 'not Mara' }, NOW)
    applyRename(db, applying(), NOW)
    const moved = dismissedKey({
      kind: 'notMention',
      recordId: mara.id,
      phrase: 'Haskel, Mara, and'
    })
    expect(getDismissedByKey(db, 'notMention', key)).not.toBeNull()
    expect(getDismissedByKey(db, 'notMention', moved)).not.toBeNull()
    undoRename(db, NOW)
    expect(getDismissedByKey(db, 'notMention', moved)).toBeNull()
    expect(listDismissed(db).count).toBe(1)
  })

  it('refuses another record’s name and the name it already has', () => {
    make('Haskel')
    expect(() => applyRename(db, applying(), NOW)).toThrow(/already a name of Haskel/)
    expect(() => applyRename(db, applying('Hesk'), NOW)).toThrow(/already its name/)
    // Nothing was written by the refused renames.
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Hesk.')
    expect(listSnapshots(db)).toEqual([])
  })
})

describe('undoRename (F-16.13)', () => {
  it('restores every scene, the ticked drafts and the name', () => {
    const other = otherDraft()
    applyRename(db, applying('Haskel', { otherDrafts: true }), NOW)
    const undone = undoRename(db, NOW)
    expect(undone.restored.map((each) => each.id).sort()).toEqual(
      [scenes[0] ?? '', scenes[1] ?? ''].sort()
    )
    expect(undone.skipped).toEqual([])
    expect(undone.drafts).toEqual({ restored: 2, skipped: 0 })
    expect(undone.nameRestored).toBe(true)
    expect(undone.record?.name).toBe('Hesk')
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Hesk.')
    expect(draftTextOf(other, scenes[0] ?? '')).toContain("Hesk's coat")
    expect(hasRenameUndo()).toBe(false)
  })

  it('skips a scene edited since the rename and names it', () => {
    applyRename(db, applying(), NOW)
    saveDocument(db, scenes[1] ?? '', doc('They waited for Haskel, long.'))
    const undone = undoRename(db, NOW)
    expect(undone.skipped).toEqual([{ id: scenes[1], title: 'Two' }])
    expect(undone.restored.map((each) => each.id)).toEqual([scenes[0]])
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Haskel, long.')
    expect(textOf(scenes[0] ?? '')).toContain('Hesk came in.')
  })

  it('leaves the name when it was changed again since', () => {
    applyRename(db, applying(), NOW)
    applyRename(db, applying('Hasko'), NOW)
    // Only the last rename can be undone: it goes back to Haskel.
    expect(undoRename(db, NOW).record?.name).toBe('Haskel')
    expect(() => undoRename(db, NOW)).toThrow(/no rename/)
  })
})

describe('Rename in book over the evidence (F-16.17, plan P2a §1.4)', () => {
  /** The invariants over the active draft's claims against the scenes as stored now. */
  const clean = (): void => {
    const hashes = new Map(
      manuscriptDocuments(db).map((row) => [
        row.id,
        new Set(sceneSentences(sceneTexts(db, row.id)).map((each) => each.hash))
      ])
    )
    expect(
      checkMemoryInvariants({
        claims: invariantClaims(db),
        sceneHashes: hashes,
        aliases: [],
        citations: []
      })
    ).toEqual([])
  }

  /** A claim in the first scene, one in the second, a card, and both scenes read. */
  function seed(): { coat: string; waited: string } {
    const [coat] = seedClaims(
      db,
      scenes[0] ?? '',
      [
        {
          recordId: hesk,
          slot: 'traits',
          value: 'wet',
          quote: "Hesk's coat was wet",
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    const [waited] = seedClaims(
      db,
      scenes[1] ?? '',
      [
        {
          recordId: hesk,
          slot: 'history',
          value: 'waited for Hesk',
          quote: 'They waited for Hesk',
          para: 0,
          proof: 'verified'
        }
      ],
      NOW
    )
    upsertCard(
      db,
      {
        nodeId: scenes[0] ?? '',
        draftId: activeDraftId(db),
        readingId: null,
        line: 'Hesk comes in wet.',
        gist: 'Hesk arrives soaked.',
        fields: {
          ...emptyCardFields(),
          where: { value: 'in', quote: 'Hesk came in', p: 0, verified: false }
        },
        present: [{ recordId: hesk, quote: 'Hesk came in', p: 0, verified: true }],
        mood: null,
        theme: null,
        anchor: sceneSentences(sceneTexts(db, scenes[0] ?? ''))
          .map((each) => each.hash)
          .slice(0, 1),
        seen: []
      },
      NOW
    )
    const names = nameScanShared(db).index
    for (const id of [scenes[0] ?? '', scenes[1] ?? '']) {
      const current = gateSentences(sceneTexts(db, id), { caretPara: null, names })
      writeSceneRead(
        db,
        {
          nodeId: id,
          draftId: activeDraftId(db),
          entries: nextReadSet(null, current, 'all'),
          full: true,
          readingId: null
        },
        NOW
      )
    }
    return { coat: coat ?? '', waited: waited ?? '' }
  }

  it('rewrites quotes, values, the card and the read set: nothing goes stale or reads as changed', () => {
    const { coat, waited } = seed()
    applyRename(db, applying(), NOW)
    expect(getClaim(db, coat)?.quote).toBe("Haskel's coat was wet")
    expect(getClaim(db, waited)).toMatchObject({
      quote: 'They waited for Haskel',
      value: 'waited for Haskel',
      valueKey: 'waited for haskel'
    })
    const card = getCard(db, scenes[0] ?? '', activeDraftId(db))
    expect(card).toMatchObject({ line: 'Haskel comes in wet.', gist: 'Haskel arrives soaked.' })
    expect(card?.present[0]?.quote).toBe('Haskel came in')
    expect(card?.fields.where?.quote).toBe('Haskel came in')
    expect(
      getSceneRead(db, scenes[1] ?? '', activeDraftId(db))?.entries.map(([, text]) => text)
    ).toEqual(['They waited for Haskel.'])
    for (const id of [scenes[0] ?? '', scenes[1] ?? '']) {
      expect(runAnchors(db, id, NOW).staled).toEqual([])
      expect(sceneMemory(db, id).unread).toBe(0)
    }
    clean()
  })

  it('puts the evidence back with the text on undo', () => {
    const { coat, waited } = seed()
    const before = [getClaim(db, coat), getClaim(db, waited)]
    applyRename(db, applying(), NOW)
    undoRename(db, NOW)
    expect([getClaim(db, coat), getClaim(db, waited)]).toEqual(before)
    expect(getCard(db, scenes[0] ?? '', activeDraftId(db))?.line).toBe('Hesk comes in wet.')
    for (const id of [scenes[0] ?? '', scenes[1] ?? '']) {
      expect(runAnchors(db, id, NOW).staled).toEqual([])
      expect(sceneMemory(db, id).unread).toBe(0)
    }
    clean()
  })

  it('rewrites a secret’s reveal and its label, and puts them back on undo (P2b)', () => {
    const topic = createTopic(
      db,
      {
        kind: 'secret',
        label: 'waiting for Hesk',
        quote: revealIn(db, scenes[1] ?? '', {
          para: 0,
          quote: 'They waited for Hesk',
          label: 'waiting for Hesk'
        })
      },
      NOW
    )
    const mine = createRecord(db, { name: 'Hesk’s debt', categoryId: 'secret' }, NOW)
    if (!('record' in mine)) throw new Error('blocked')
    const before = getTopicQuote(db, topic.topicQuoteId)
    applyRename(db, applying(), NOW)
    expect(getTopicQuote(db, topic.topicQuoteId)).toMatchObject({
      quote: 'They waited for Haskel',
      label: 'waiting for Haskel',
      // The gate texts fold names: the Dismissed key's input never moves.
      stating: before?.stating
    })
    // The AI-made secret's label follows; the author's own label is hers.
    expect(requireRecord(db, topic.recordId).name).toBe('waiting for Haskel')
    expect(requireRecord(db, mine.record.id).name).toBe('Hesk’s debt')
    expect(runAnchors(db, scenes[1] ?? '', NOW).topicQuotes).toEqual([])
    expect(getTopicQuote(db, topic.topicQuoteId)?.state).toBe('live')
    undoRename(db, NOW)
    expect(getTopicQuote(db, topic.topicQuoteId)).toEqual(before)
    expect(requireRecord(db, topic.recordId).name).toBe('waiting for Hesk')
    // The secret's own label is renamed on its sheet, never in the book.
    const label = requireRecord(db, topic.recordId).aliases[0]?.id ?? ''
    expect(() =>
      previewRename(db, { recordId: topic.recordId, aliasId: label, to: 'the long wait' })
    ).toThrow(/not named in the book/)
    clean()
  })

  it('finds a quote whose paragraph moved before the anchors job ran, and rewrites it there', () => {
    const { coat } = seed()
    // A paragraph put above the quote; the rename comes before the anchors job runs.
    saveDocument(
      db,
      scenes[0] ?? '',
      doc('A new start.', 'Hesk came in.', "Hesk's coat was wet; Heskel stayed out.")
    )
    applyRename(db, applying(), NOW)
    expect(getClaim(db, coat)).toMatchObject({ quote: "Haskel's coat was wet", para: 2 })
    expect(getCard(db, scenes[0] ?? '', activeDraftId(db))?.present[0]).toMatchObject({
      quote: 'Haskel came in',
      p: 1
    })
    expect(runAnchors(db, scenes[0] ?? '', NOW).staled).toEqual([])
    clean()
  })

  it('brings the open scene’s claims back once its renamed text is saved, after a check between', () => {
    const { coat } = seed()
    applyRename(db, applying('Haskel', { openId: scenes[0] ?? '' }), NOW)
    // The anchors job runs before the editor's save: the stored text still has the old name.
    expect(runAnchors(db, scenes[0] ?? '', NOW).staled).toEqual([coat])
    saveDocument(
      db,
      scenes[0] ?? '',
      doc('Haskel came in.', "Haskel's coat was wet; Heskel stayed out.")
    )
    expect(runAnchors(db, scenes[0] ?? '', NOW).restored).toEqual([coat])
    expect(getClaim(db, coat)?.state).toBe('live')
    clean()
  })

  it('puts another draft’s evidence back only with that draft’s text', () => {
    seed()
    const other = otherDraft()
    const [inOther] = insertClaims(
      db,
      [
        {
          ...anchoredClaim(db, scenes[1] ?? '', {
            recordId: hesk,
            slot: 'history',
            value: 'waited',
            quote: 'They waited for Hesk',
            para: 0
          }),
          draftId: other
        }
      ],
      NOW
    )
    applyRename(db, applying('Haskel', { otherDrafts: true }), NOW)
    // The other draft's text of the scene changes after the rename: its undo is skipped.
    db.update(draftText)
      .set({ content: JSON.stringify(doc('They waited for Haskel, long.')) })
      .where(and(eq(draftText.draftId, other), eq(draftText.nodeId, scenes[1] ?? '')))
      .run()
    const undone = undoRename(db, NOW)
    expect(undone.drafts.skipped).toBe(1)
    expect(textOf(scenes[1] ?? '')).toBe('They waited for Hesk.')
    expect(getClaim(db, inOther ?? '')?.quote).toBe('They waited for Haskel')
  })

  it('rewrites the open scene’s evidence for the editor’s save that follows, and an inactive draft’s', () => {
    const { coat } = seed()
    const other = otherDraft()
    const elsewhere = {
      ...anchoredClaim(db, scenes[1] ?? '', {
        recordId: hesk,
        slot: 'history',
        value: 'waited',
        quote: 'They waited for Hesk',
        para: 0
      }),
      draftId: other
    }
    const [inOther] = insertClaims(db, [elsewhere], NOW)
    const result = applyRename(
      db,
      applying('Haskel', { openId: scenes[0] ?? '', otherDrafts: true }),
      NOW
    )
    expect(getClaim(db, coat)?.quote).toBe("Haskel's coat was wet")
    expect(getClaim(db, inOther ?? '')?.quote).toBe('They waited for Haskel')
    // The renderer writes the same edits through the editor, then saves.
    expect(result.openEdits).toHaveLength(2)
    saveDocument(
      db,
      scenes[0] ?? '',
      doc('Haskel came in.', "Haskel's coat was wet; Heskel stayed out.")
    )
    expect(runAnchors(db, scenes[0] ?? '', NOW).staled).toEqual([])
    clean()
  })
})
