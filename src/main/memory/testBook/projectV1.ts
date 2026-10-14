import { randomUUID } from 'node:crypto'
import { changeRunId } from '@shared/changes'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import { normName } from '@shared/memory/names'
import type { TiptapNodeT } from '@shared/tiptap'
import { fact, observedFact } from '../../db/schema'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { upsertSummary } from '../../document/summaryStore'
import { createEntity, updateEntity } from '../../entity/entityStore'
import { logChanges } from '../../knowledge/changeLog'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { setDismissedNames } from '../../project/settingsStore'
import { setProjectTimeline } from '../../project/timelineStore'
import { takeSnapshot } from '../../snapshot/snapshotStore'
import { createTag, getTag, updateTag } from '../../tag/tagStore'
import type { TreeDb } from '../../tree/treeStore'
import { TEST_BOOK, type TestBookScene } from './book'
import { TEST_BOOK_LABELS } from './labels'
import { layOutTestBook, TEST_BOOK_CATEGORY } from './project'

/**
 * The test book as a story memory v1 project (F-16.31 part A; plan `Switchover.md` §5.1), built
 * the way a v1 author would have it, through the v1 stores (the AI's frozen tables, `fact`,
 * `observed_fact` and `scene_summary`, take their rows as the background reading wrote them):
 *
 * - a sheet and a tag per labelled record (secrets and threads come from P2b's reading, never a
 *   sheet, as in the v2 builder), the record's other names as the tag's aliases;
 * - Mrs. Harrow's sheet without a tag: v1 keeps a name on one tag only (F-4.14), so the family
 *   name "Harrow" sits on Mr. Harrow's tag and on her sheet, which is how a v1 author gives two
 *   people one surname; the switch-over marks it shared on both (identity rule 4);
 * - a split pair the twin gate offers to merge: Callum Varrow's sheet and a `varrow` tag the
 *   author made for the surname alone (the test book has no "Captain Harrow": its Captain is
 *   never named Harrow, and Harrow is the Harrows' shared surname);
 * - inline tags on about a third of the scenes (and in the earlier draft of chapter 14), each on
 *   the first place a record's name stands in the prose exactly as the record is named, so the
 *   default replacement gives the test book's prose back byte for byte;
 * - scene meta POV and location strings and the scene's time, and timeline events with years:
 *   one over the run of 1811 scenes (s01–h07, and the flashback h16), one per later year;
 * - the Captain's sheet as a Plan sheet holding his Ideas line (P3's page); an AI-made sheet
 *   (the Widow Marsh, from a library run); an AI-written field (Ned Ashby's personality, from an
 *   Organise run); AI facts and observed facts; two scene summaries; a snapshot of a scene with
 *   an inline tag; the dismissed names;
 * - the Idea scene (h11), the cut scene (h12), h10 in an inactive draft and the planned card
 *   (h17) laid out as the v2 builder lays them (`layOutTestBook`).
 *
 * Built for the offline switch-over replay and the live switch-over run
 * (`ai/eval/switchover.eval.ts`); test data only.
 */

export interface TestBookV1Project {
  session: ProjectSession
  db: TreeDb
  /** The project's folder. */
  folder: string
  /** Label record id → its v1 sheet. */
  sheets: Map<string, string>
  /** Label record id → its tag (every record but Mrs. Harrow's). */
  tags: Map<string, string>
  /** The `varrow` tag of the split pair (merged into Callum Varrow when the author ticks it). */
  splitTagId: string
  /** Test-book scene id → node id (h10 maps to h09's node, in the inactive draft). */
  scenes: Map<string, string>
  inactiveDraftId: string
  /** Scene id → the words each of its inline tags stands for, in order. */
  inlineTags: Map<string, string[]>
  /** The snapshot of a scene with an inline tag. */
  snapshotId: string
  /** The sheet text an Organise run wrote (Ned Ashby's personality), and the sheet the AI made. */
  aiWritten: { label: string; text: string }
  aiSheet: string
}

/** The label whose sheet keeps the shared surname without a tag (F-4.14: one tag per name). */
const UNTAGGED = 'harrow-mrs'
/** The split pair: Callum Varrow's sheet and the tag of his surname alone. */
const SPLIT = { label: 'varrow', tag: 'varrow', name: 'Varrow' } as const
/** The Plan sheet: the Captain's, holding his Ideas line (P3's labelled page). */
const PLAN = 'captain'
/** The sheet an Organise run wrote a field of, and what it wrote. */
const AI_FIELD = { label: 'ashby', field: 'personality', text: 'Cheerful and easily led' } as const
/** The sheet a library run made (dropped by the switch-over). */
const AI_SHEET = 'Widow Marsh'

/** The scenes a third of the book: every third readable scene, from the first. */
const tokenScenes = (): Set<string> => {
  const readable = TEST_BOOK.filter((scene) => scene.source === 'scene')
  return new Set([
    ...readable.filter((_, i) => i % 3 === 0).map((scene) => scene.id),
    // The earlier draft of chapter 14: inline tags in an inactive draft convert too.
    'h10'
  ])
}

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char)

/** Where `name` stands in `text` as a whole word, exactly as written, from `from`; -1 if nowhere. */
function wholeWordAt(text: string, name: string, from = 0): number {
  for (let at = text.indexOf(name, from); at >= 0; at = text.indexOf(name, at + 1)) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + name.length])) return at
  }
  return -1
}

/** A token as v1's editor stores it. */
interface Token {
  tagId: string
  tagName: string
  words: string
}

interface Placed {
  para: number
  at: number
  token: Token
}

/** One paragraph, with tokens at the places given (in order, not overlapping). */
function paragraphWith(text: string, places: readonly Omit<Placed, 'para'>[]): TiptapNodeT {
  const content: TiptapNodeT[] = []
  let from = 0
  for (const place of [...places].sort((a, b) => a.at - b.at)) {
    if (place.at > from) content.push({ type: 'text', text: text.slice(from, place.at) })
    content.push({
      type: INLINE_TAG_NODE_TYPE,
      attrs: { id: place.token.tagId, name: place.token.tagName }
    })
    from = place.at + place.token.words.length
  }
  if (from < text.length) content.push({ type: 'text', text: text.slice(from) })
  return { type: 'paragraph', content }
}

/**
 * Builds the project in `dir` (an empty folder, or a missing one): `<dir>/Test book.mythscribe`
 * on story memory v1, open. The switch-over replay checks that the default words give the prose
 * back (`switchover.eval.ts`).
 */
export function buildTestBookV1Project(dir: string, now: Date): TestBookV1Project {
  const folder = projectFolderFor(dir, 'Test book')
  const session = createProject(folder, 'Test book', 'novel', { storyMemoryOverride: 'v1' })
  const db = session.connection.orm
  const at = now.toISOString()

  // ---- A sheet and a tag per labelled record (secrets and threads are the reading's).
  const sheets = new Map<string, string>()
  const tags = new Map<string, string>()
  const tagNames = new Map<string, string>()
  const ideas = TEST_BOOK_LABELS.pages.find((page) => page.record === PLAN && page.page === 'ideas')
  for (const label of TEST_BOOK_LABELS.records) {
    const kind = TEST_BOOK_CATEGORY[label.kind]
    if (kind === undefined) continue
    const untagged = label.id === UNTAGGED
    const made = createEntity(
      db,
      {
        kind,
        name: label.name,
        // A structured sheet where an AI run wrote a field; a blank page elsewhere.
        template: label.id === AI_FIELD.label ? 'structured' : 'blank',
        ...(label.id === PLAN && ideas !== undefined ? { body: ideas.lines.join('\n\n') } : {})
      },
      'author',
      untagged ? { tag: false } : {}
    ).entity
    sheets.set(label.id, made.id)
    const main = normName(label.name)
    const others = label.aliases
      .map((alias) => alias.text)
      .filter((text) => normName(text) !== main)
      // The split pair: the surname alone is the `varrow` tag's name, not an alias.
      .filter((text) => !(label.id === SPLIT.label && text === SPLIT.name))
    if (untagged) {
      if (others.length > 0) updateEntity(db, made.id, { aliases: others })
      continue
    }
    if (made.tagId === null) throw new Error(`The sheet of ${label.name} has no tag`)
    tags.set(label.id, made.tagId)
    if (others.length > 0) updateTag(db, made.tagId, { aliases: others })
    tagNames.set(made.tagId, getTag(db, made.tagId)?.name ?? '')
  }
  const split = createTag(db, { name: SPLIT.tag, category: 'character' })
  tagNames.set(split.id, split.name)
  const plan = sheets.get(PLAN)
  if (plan !== undefined) updateEntity(db, plan, { status: 'plan' })

  // ---- Inline tags: about a third of the scenes, and the earlier draft of chapter 14.
  const nameOf = new Map(TEST_BOOK_LABELS.records.map((label) => [label.id, label.name]))
  const named: Token[] = [...tags]
    .map(([label, tagId]) => ({
      tagId,
      tagName: tagNames.get(tagId) ?? '',
      words: nameOf.get(label) ?? ''
    }))
    .filter((token) => token.words !== '')
    // The longer name first, so "Mr. Harrow" is never read as a shorter record's name.
    .sort((a, b) => b.words.length - a.words.length)
  const surname: Token = { tagId: split.id, tagName: split.name, words: SPLIT.name }
  const chosen = tokenScenes()
  const inlineTags = new Map<string, string[]>()
  /** The scene's places: its first record name, and (once) Varrow's surname standing alone. */
  let surnamePlaced = false
  const placesFor = (scene: TestBookScene): Placed[] => {
    const places: Placed[] = []
    if (chosen.has(scene.id)) {
      const first = scene.paragraphs
        .flatMap((text, para) =>
          named.flatMap((token) => {
            const found = wholeWordAt(text, token.words)
            return found < 0 ? [] : [{ para, at: found, token }]
          })
        )
        .sort((a, b) => a.para - b.para || a.at - b.at)[0]
      if (first !== undefined) places.push(first)
    }
    if (!surnamePlaced && scene.source === 'scene') {
      for (const [para, text] of scene.paragraphs.entries()) {
        let found = wholeWordAt(text, surname.words)
        // Varrow alone: never inside "Mr. Varrow" or "Callum Varrow".
        while (found >= 0 && /(?:Mr\. |Callum )$/.test(text.slice(0, found))) {
          found = wholeWordAt(text, surname.words, found + 1)
        }
        const clash = places.some(
          (place) =>
            place.para === para &&
            found < place.at + place.token.words.length &&
            place.at < found + surname.words.length
        )
        if (found >= 0 && !clash) {
          places.push({ para, at: found, token: surname })
          surnamePlaced = true
          break
        }
      }
    }
    return places
  }
  const contentOf = (scene: TestBookScene): TiptapNodeT | null => {
    if (scene.paragraphs.length === 0) return null
    const places = placesFor(scene)
    if (places.length > 0) {
      inlineTags.set(
        scene.id,
        [...places].sort((a, b) => a.para - b.para || a.at - b.at).map((place) => place.token.words)
      )
    }
    return {
      type: 'doc',
      content: scene.paragraphs.map((text, para) =>
        paragraphWith(
          text,
          places.filter((place) => place.para === para)
        )
      )
    }
  }

  // ---- Scene meta: POV and location by name, the time, the timeline event of its year.
  const events: { id: string; label: string; when: string; year: number; note: string }[] = []
  const eventOf = new Map<string, string>()
  const EVENT_LABELS: Readonly<Record<number, string>> = {
    1811: 'The first autumn',
    1812: 'The spring after',
    1814: 'The later winter',
    1815: 'The summer at the end'
  }
  {
    const eventOfYear = new Map<number, string>()
    for (const scene of TEST_BOOK) {
      if (scene.source === 'inactiveDraft') continue
      const year = scene.details?.year
      if (year === undefined) continue
      // One event a year: the run of 1811 scenes shares one, and the flashback h16, back in
      // 1811, links to it again.
      let id = eventOfYear.get(year)
      if (id === undefined) {
        id = randomUUID()
        eventOfYear.set(year, id)
        events.push({
          id,
          label: EVENT_LABELS[year] ?? `The year ${year}`,
          when: '',
          year,
          note: ''
        })
      }
      eventOf.set(scene.id, id)
    }
  }
  setProjectTimeline(db, { events })
  const placed = (scene: TestBookScene, node: string): void => {
    const details = scene.details
    if (details === undefined && scene.source !== 'ideaScene') return
    const eventId = eventOf.get(scene.id)
    setSceneMeta(db, node, {
      location: details?.place === undefined ? '' : (nameOf.get(details.place) ?? ''),
      pov: details?.pov === undefined ? '' : (nameOf.get(details.pov) ?? ''),
      timeline: details?.time ?? '',
      ...(eventId === undefined ? {} : { eventId }),
      ...(scene.source === 'ideaScene' ? { status: 'idea' as const } : {})
    })
  }
  const { scenes, inactiveDraftId } = layOutTestBook(db, TEST_BOOK, {
    content: contentOf,
    placed
  })

  // ---- What the AI made: a sheet, a field, facts, observed facts, summaries.
  const ashby = sheets.get(AI_FIELD.label)
  if (ashby === undefined) throw new Error('The test book has no Ned Ashby')
  updateEntity(db, ashby, { fields: { [AI_FIELD.field]: AI_FIELD.text } })
  logChanges(
    db,
    changeRunId('organise', 'test-book'),
    [
      {
        kind: 'sheetEdit',
        nodeId: null,
        quote: null,
        entityId: ashby,
        targetId: ashby,
        label: `Ned Ashby: ${AI_FIELD.field}`,
        undo: {
          type: 'restoreSheet',
          entityId: ashby,
          before: { fields: { [AI_FIELD.field]: '' } },
          after: { fields: { [AI_FIELD.field]: AI_FIELD.text } }
        }
      }
    ],
    at
  )
  createEntity(
    db,
    {
      kind: 'character',
      name: AI_SHEET,
      template: 'blank',
      body: 'Keeps the Bell and lets rooms to officers.'
    },
    'ai'
  )
  const varrow = sheets.get(SPLIT.label)
  const s03 = scenes.get('s03')
  if (varrow === undefined || s03 === undefined) throw new Error('The test book has no s03 Varrow')
  db.insert(fact)
    .values({
      id: randomUUID(),
      entityId: varrow,
      attribute: 'appearance',
      value: 'grey eyes',
      nodeId: s03,
      quote: 'a cold, clear grey',
      origin: 'ai',
      status: 'canon',
      factKey: `ai\u0000${s03}\u0000appearance:grey eyes`,
      createdAt: at,
      updatedAt: at
    })
    .run()
  db.insert(observedFact)
    .values({
      id: randomUUID(),
      entityId: varrow,
      nodeId: s03,
      attribute: 'appearance',
      value: 'grey eyes',
      quote: 'a cold, clear grey',
      createdAt: at
    })
    .run()
  for (const id of ['s01', 's02']) {
    const nodeId = scenes.get(id)
    if (nodeId === undefined) continue
    upsertSummary(db, {
      nodeId,
      summary: 'A scene of the test book, summarised by the old background reading.',
      keyPoints: ['Thornmere is let'],
      characters: ['Mr. Harrow', 'Mrs. Harrow'],
      contentHash: `test-book-${id}`,
      promptVersion: 'summary.v5',
      model: 'deepseek/deepseek-v4-flash',
      truncated: false,
      createdAt: at
    })
  }

  // ---- The dismissed names; a snapshot of the first scene with an inline tag.
  setDismissedNames(db, { names: [...TEST_BOOK_LABELS.dismissed] })
  const snapped = scenes.get([...inlineTags.keys()].find((id) => id !== 'h10') ?? '')
  if (snapped === undefined) throw new Error('No scene of the test book holds an inline tag')
  const snapshots = takeSnapshot(db, {
    scope: 'document',
    nodeId: snapped,
    name: 'Before the switch',
    note: '',
    milestone: false
  })
  const snapshotId = snapshots[0]?.id ?? ''

  return {
    session,
    db,
    folder,
    sheets,
    tags,
    splitTagId: split.id,
    scenes,
    inactiveDraftId,
    inlineTags,
    snapshotId,
    aiWritten: { label: AI_FIELD.label, text: AI_FIELD.text },
    aiSheet: AI_SHEET
  }
}
