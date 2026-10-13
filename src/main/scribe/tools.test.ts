import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyCardFields } from '@shared/memory/claims'
import { saveDocument } from '../document/documentStore'
import { createAuthorTodo } from '../memory/authorTodoStore'
import { activeDraftId } from '../draft/draftStore'
import { loadAgentProject } from '../ai/agentTools'
import { navigatorMenuLine } from '../ai/prompts/navigator.v1'
import { cardAnchorOf, seedClaims } from '../memory/reading/claimFixture'
import { upsertCard } from '../memory/reading/cardStore'
import { indexOwner } from '../memory/passageIndexer'
import { savePage } from '../memory/recordStore'
import { ensureResearchRoot } from '../project/seed'
import { createResearchNote } from '../research/researchStore'
import { evidenceFrame } from './evidence'
import {
  closeScribeBook,
  doc,
  indexBook,
  readWhole,
  SCRIBE_NOW,
  scribeBook,
  type ScribeBook
} from './scribeFixture'
import { askIndexOf, EvidenceMenu, gatherStep0 } from './step0'
import { recordByNameV2, recordState, runNavigatorTool, type NavigatorWorld } from './tools'

/**
 * The navigator's tools (F-16.25; plan P3 §4.2, §4.4): each adds menu items (never prose) with a
 * step label, on the scribe test book; Research, Pinned and Ideas can be read; `knows` lists
 * positive lines only; every paragraph a call returns joins the search-miss baseline.
 */

let book: ScribeBook

beforeEach(() => {
  book = scribeBook()
  for (const id of [book.one, book.two, book.three]) readWhole(book.db, id)
  indexBook(book.db, {
    scenes: [book.one, book.two, book.three],
    records: [book.mara, book.orrin, book.tomas, book.quay]
  })
})
afterEach(() => closeScribeBook(book))

/** A navigation world for `question` asked with `nodeId` open, its menu seeded with Step 0's. */
function worldFor(question: string, nodeId: string = book.three): NavigatorWorld {
  const step0 = gatherStep0(book.db, {
    nodeId,
    question,
    focus: { caretPara: null, selection: null }
  })
  const frame = evidenceFrame(book.db, step0.nowId)
  return {
    project: loadAgentProject(book.db, nodeId, 'v2'),
    frame,
    ask: askIndexOf(book.db),
    step0,
    menu: new EvidenceMenu(frame, { items: step0.menu, hits: step0.hits }),
    terms: [],
    scope: null,
    reads: 0
  }
}

const lines = (world: NavigatorWorld, from: number): string[] =>
  world.menu.items.slice(from).map(navigatorMenuLine)

describe('search (F-16.25)', () => {
  it('finds the navigator’s own words over every source but cards, labelled, with new ids and hits', () => {
    const world = worldFor('What happened there?')
    const before = world.menu.items.length
    const run = runNavigatorTool(world, { tool: 'search', terms: ['stranger', 'buyer'] })
    expect(run.step).toEqual({ tool: 'search', label: "Searching 'stranger, buyer'…" })
    expect(run.added.map((item) => item.id)).toEqual(run.added.map((_, i) => `E${before + i + 1}`))
    expect(lines(world, before)).toContain(
      `E${before + 1} happened 1.1 ¶1: Tomas sold the map to a stranger.`
    )
    expect(world.menu.hits).toContainEqual({ nodeId: book.one, para: 1 })
    expect(world.terms).toEqual(['stranger', 'buyer'])
    // Nothing new: a note for the next step, no item.
    const again = runNavigatorTool(world, { tool: 'search', terms: ['stranger'] })
    expect(again.added).toEqual([])
    expect(again.note).toBe('No new passage matches stranger.')
  })

  it('searches every scene up to now in reading order for a first question, and records the scope', () => {
    const world = worldFor('When does Mara first see the harbour?')
    expect(world.step0.ordinal).toBe(true)
    const run = runNavigatorTool(world, { tool: 'search', terms: ['quay', 'dock'] })
    expect(run.added.map((item) => item.key)).toContainEqual({
      kind: 'passage',
      source: 'scene',
      ownerId: book.one,
      para: 0
    })
    expect(world.scope).toMatchObject({ from: '1.1', to: '1.3', allEarlier: true })
    expect(world.scope?.terms).toEqual(['quay', 'dock'])
  })
})

describe('cards, read, state (F-16.25)', () => {
  it('reads the cards of a range (maps, never citable) and of the scenes naming a record', () => {
    const draftId = activeDraftId(book.db)
    for (const [nodeId, line] of [
      [book.one, 'Tomas sells the map.'],
      [book.two, 'Mara waits at the harbour.']
    ] as const) {
      upsertCard(
        book.db,
        {
          nodeId,
          draftId,
          readingId: null,
          line,
          gist: '',
          fields: emptyCardFields(),
          present: [],
          mood: null,
          theme: null,
          anchor: cardAnchorOf(book.db, nodeId),
          seen: []
        },
        SCRIBE_NOW
      )
    }
    const world = worldFor('What happens in the chapter?')
    const run = runNavigatorTool(world, { tool: 'cards', arg: '1.1-1.2' })
    expect(run.step).toEqual({ tool: 'cards', label: 'Reading 2 scene cards…' })
    expect(run.added.map((item) => [item.label, item.snippet])).toEqual([
      ['map', 'Tomas sells the map.'],
      ['map', 'Mara waits at the harbour.']
    ])
    const byName = runNavigatorTool(worldFor('Where has Tomas been?'), {
      tool: 'cards',
      arg: 'Tomas'
    })
    expect(byName.added.map((item) => item.key)).toEqual([{ kind: 'card', nodeId: book.one }])
    expect(runNavigatorTool(world, { tool: 'cards', arg: 'Nobody' }).note).toBe(
      '"Nobody" names no scene or record.'
    )
  })

  it('reads a scene part, a record’s Pinned and Ideas, a Research page: two reads a message', () => {
    savePage(book.db, book.mara, 'pinned', doc('Born in the north.', 'Hates the sea.'), SCRIBE_NOW)
    savePage(book.db, book.mara, 'ideas', doc('Maybe Mara has a twin.'), SCRIBE_NOW)
    const world = worldFor('Tell me about Mara.')
    const scene = runNavigatorTool(world, { tool: 'read', arg: '1.1 ¶1-2' })
    expect(scene.step).toEqual({ tool: 'read', label: 'Reading 1.1 ¶1-2…' })
    expect(scene.added.map((item) => item.key)).toEqual([
      { kind: 'scene', nodeId: book.one, from: 1, to: 2 }
    ])
    expect(world.menu.hits).toEqual(
      expect.arrayContaining([
        { nodeId: book.one, para: 1 },
        { nodeId: book.one, para: 2 }
      ])
    )
    const pinned = runNavigatorTool(world, { tool: 'read', arg: "Mara's Pinned" })
    expect(pinned.added.map((item) => [item.label, item.snippet])).toEqual([
      ['notes', 'Born in the north.'],
      ['notes', 'Hates the sea.']
    ])
    const third = runNavigatorTool(world, { tool: 'read', arg: "Mara's Ideas" })
    expect(third.added).toEqual([])
    expect(third.note).toBe('Two reads a message: use what the menu holds.')

    const fresh = worldFor('Tell me about Mara.')
    expect(
      runNavigatorTool(fresh, { tool: 'read', arg: 'Mara Ideas' }).added.map((item) => item.label)
    ).toEqual(['idea'])
    // A written Research page: the author's notes, read by its title (F-16.8: from P3).
    const root = ensureResearchRoot(book.db)
    const note = createResearchNote(book.db, 'novel', { parentId: root, title: 'Harbour' }).id
    saveDocument(book.db, note, doc('The harbour freezes in winter.'))
    const later = worldFor('What is the harbour like?')
    const page = runNavigatorTool(later, { tool: 'read', arg: 'Harbour' })
    expect(page.step.label).toBe('Reading Harbour…')
    expect(page.added.map((item) => [item.label, item.snippet])).toEqual([
      ['notes', 'The harbour freezes in winter.']
    ])
    expect(runNavigatorTool(later, { tool: 'read', arg: 'Nowhere' }).note).toBe(
      '"Nowhere" names no scene, record page or Research page.'
    )
  })

  it('looks a record up as of now: its values, Pinned lines, where the book names it, never a slot it lacks', () => {
    seedClaims(
      book.db,
      book.one,
      [{ recordId: book.mara, slot: 'eyes', value: 'grey', quote: 'her grey eyes', para: 0 }],
      SCRIBE_NOW
    )
    savePage(book.db, book.mara, 'pinned', doc('Hates the sea.'), SCRIBE_NOW)
    indexOwner(book.db, 'record', book.mara, SCRIBE_NOW)
    const world = worldFor('What is happening?')
    const run = runNavigatorTool(world, { tool: 'state', arg: 'Mara' })
    expect(run.step).toEqual({ tool: 'state', label: 'Looking up Mara…' })
    const shown = run.added.map((item) => navigatorMenuLine(item))
    expect(shown.some((line) => line.includes('Mara · Eyes: grey (1.1)'))).toBe(true)
    expect(shown.some((line) => line.includes("Mara's Pinned ¶0: Hates the sea."))).toBe(true)
    expect(run.added.some((item) => item.key.kind === 'passage' && item.label === 'happened')).toBe(
      true
    )
    expect(runNavigatorTool(world, { tool: 'state', arg: 'Marra' }).note).toBe(
      'No record is called "Marra".'
    )
    // The helpers agent.v8's lookup shares (P3-D18).
    const project = loadAgentProject(book.db, book.three, 'v2')
    const mara = recordByNameV2(project, 'mara')
    expect(mara?.id).toBe(book.mara)
    const record = world.frame.records.get(book.mara) ?? null
    if (record === null) throw new Error('no record')
    const state = recordState(project, record)
    expect(state.pinned.map((paragraph) => paragraph.text)).toEqual(['Hates the sea.'])
    expect(state.named.map((each) => each.nodeId)).toEqual([book.one, book.two, book.three])
  })
})

describe('knows, timeline, ideas, outline, todos (F-16.25)', () => {
  beforeEach(() => {
    seedClaims(
      book.db,
      book.one,
      [
        {
          recordId: book.orrin,
          slot: 'knows',
          value: 'overheard',
          how: 'overheard',
          fromId: book.tomas,
          objectId: book.map,
          quote: 'Orrin overheard Tomas',
          para: 2,
          proof: 'verified'
        }
      ],
      SCRIBE_NOW
    )
  })

  it('lists who knows a secret, and what a person knows: positive lines only', () => {
    const world = worldFor('Who knows?')
    const secret = runNavigatorTool(world, { tool: 'knows', arg: 'the sold map' })
    expect(secret.step).toEqual({ tool: 'knows', label: 'Checking who knows the sold map…' })
    expect(secret.added.map((item) => item.key)).toEqual([{ kind: 'knows', secretId: book.map }])
    // (A neutral message: Step 0 would have put Orrin's line on the menu already.)
    const person = runNavigatorTool(worldFor('Tell me more.'), {
      tool: 'knows',
      arg: 'Orrin'
    })
    expect(person.step.label).toBe('Checking what Orrin knows…')
    expect(person.added.map((item) => item.snippet)).toEqual([
      'Orrin · Knows the sold map (overheard from Tomas, 1.1)'
    ])
    // Someone shown knowing nothing gets no line at all, never a "does not know".
    const tomasless = runNavigatorTool(worldFor('Tell me more.'), {
      tool: 'knows',
      arg: 'Mara'
    })
    expect(tomasless.added).toEqual([])
    expect(tomasless.note).toBe('No new line for Mara.')
    for (const run of [secret, person, tomasless]) {
      const text = [...run.added.map((item) => item.snippet), run.note ?? ''].join(' ')
      expect(text).not.toMatch(/does not know|doesn't know|never learns|checked up to/iu)
    }
  })

  it('reads the story years or an age, the Ideas, the outline and the to-dos', () => {
    savePage(book.db, book.mara, 'ideas', doc('Maybe Mara has a twin.'), SCRIBE_NOW)
    createAuthorTodo(
      book.db,
      { text: 'Fix the ferry timeline', nodeId: null, recordId: null },
      SCRIBE_NOW
    )
    const world = worldFor('What should I fix?')
    expect(runNavigatorTool(world, { tool: 'timeline', arg: '' }).step.label).toBe(
      'Reading the story years…'
    )
    const ideas = runNavigatorTool(world, { tool: 'ideas', arg: '' })
    expect(ideas.added.map((item) => [item.key, item.label])).toEqual([
      [{ kind: 'ideas', recordId: book.mara }, 'idea']
    ])
    const outline = runNavigatorTool(world, { tool: 'outline' })
    expect(outline.added.map((item) => [item.key, item.label])).toEqual([
      [{ kind: 'outline' }, 'computed']
    ])
    const todos = runNavigatorTool(world, { tool: 'todos' })
    expect(todos.step).toEqual({ tool: 'todos', label: 'Reading your to-dos…' })
    expect(todos.added.map((item) => [item.label, item.snippet])).toEqual([
      ['todo', '- Fix the ferry timeline']
    ])
  })
})
