import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { createAuthorTodo, updateAuthorTodo } from '../memory/authorTodoStore'
import { scanNamesFor } from '../memory/nameIndexer'
import { indexOwner, indexScene } from '../memory/passageIndexer'
import { createRecord, savePage } from '../memory/recordStore'
import { setSceneDetails } from '../memory/sceneDetailStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { ensureResearchRoot } from '../project/seed'
import { createResearchNote } from '../research/researchStore'
import { createNode, getNode, moveNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { AGENT_TOOLS } from '@shared/agent'
import { emptyCardFields } from '@shared/memory/claims'
import { CARD_MAP_NOTE } from '@shared/memory/cardText'
import { activeDraftId } from '../draft/draftStore'
import { upsertCard } from '../memory/reading/cardStore'
import { cardAnchorOf } from '../memory/reading/claimFixture'
import { loadAgentProject, resolveAgentEdit, runAgentTool, type AgentProject } from './agentTools'
import { AGENT_V2_REFUSED, AGENT_V2_REFUSED_EDITS, passageMark } from './agentToolsV2'

/**
 * F-16.4 (P1 slice 4): `agent.v8` runs unchanged in a story memory v2 project until P3, so its
 * tag and sheet tools and edits are refused with one fixed result, and lookup, find_passages,
 * todo and cards read the v2 records, the labelled passage index and the author's to-dos.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]
let mara: string
let research: string

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

const doc = (...paragraphs: { text: string; notCanon?: true }[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map(({ text, notCanon }) => ({
    type: 'paragraph',
    ...(notCanon ? { attrs: { notCanon: true } } : {}),
    content: [{ type: 'text', text }]
  }))
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-agent-v2-'))
  session = createProject(projectFolderFor(tmp, 'Agent'), 'Agent', 'novel')
  db = session.connection.orm
  const first = manuscriptDocuments(db)[0]?.id ?? ''
  const second = createNode(db, 'novel', {
    parentId: getNode(db, first)?.parentId ?? '',
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'The ferry'
  }).id
  scenes = [first, second]
  saveDocument(db, first, doc({ text: 'Mara walked in with the lantern.' }))
  saveDocument(db, second, doc({ text: 'The ferry left.' }, { text: 'Mara Vell slept below.' }))
  saveNotes(db, second, doc({ text: 'Remember the lantern burns blue here.' }))
  const made = createRecord(
    db,
    { name: 'Mara Vell', categoryId: 'character', aliases: [{ text: 'Mara' }] },
    NOW
  )
  if (!('record' in made)) throw new Error('blocked')
  mara = made.record.id
  savePage(
    db,
    mara,
    'pinned',
    doc(
      { text: 'Eyes: grey as the harbour.' },
      { text: 'She has a twin lantern.', notCanon: true }
    ),
    NOW
  )
  savePage(db, mara, 'ideas', doc({ text: 'Maybe the lantern was her mother’s.' }), NOW)
  setSceneDetails(
    db,
    second,
    {
      povRecordId: mara,
      place: { recordId: null, text: 'the ferry deck' },
      time: { text: 'night' },
      storyYear: null,
      alsoHere: []
    },
    NOW
  )
  const root = ensureResearchRoot(db)
  research = createResearchNote(db, 'novel', { parentId: root, title: 'Lantern lore' }).id
  saveDocument(db, research, doc({ text: 'A ferry lantern burns whale oil.' }))
  for (const scene of scenes) {
    scanNamesFor(db, scene, NOW)
    indexScene(db, scene, NOW)
  }
  indexOwner(db, 'record', mara, NOW)
  indexOwner(db, 'research', research, NOW)
  createAuthorTodo(db, { text: 'Check the tide tables', nodeId: second, recordId: mara }, NOW)
  const done = createAuthorTodo(db, { text: 'Name the ferry', nodeId: null, recordId: null }, NOW)
  updateAuthorTodo(db, done.id, { done: true }, NOW)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const v2 = (): AgentProject => loadAgentProject(db, scenes[1] ?? null, 'v2')
const ref = (project: AgentProject, id: string | undefined): string =>
  project.refOf.get(id ?? '') ?? '?'

describe('the agent in a v2 project refuses tags and sheets (F-16.4)', () => {
  it('answers every tag and sheet read with the one fixed result', () => {
    const project = v2()
    expect(project.entities).toEqual([])
    for (const tool of ['tags', 'read_sheet', 'list_sheets']) {
      expect(runAgentTool(project, null, tool, { name: 'Mara', kind: 'character' }).result).toBe(
        AGENT_V2_REFUSED
      )
    }
  })

  it('refuses every tag, sheet, status, To do, summaries and upload edit', () => {
    const project = v2()
    const id = ref(project, scenes[0])
    for (const edit of AGENT_V2_REFUSED_EDITS) {
      expect(resolveAgentEdit(project, { edit, id, tag: 'storm', name: 'Mara' })).toEqual({
        error: AGENT_V2_REFUSED
      })
    }
    expect(resolveAgentEdit(project, { edit: 'delete', sheet: 'Mara' })).toEqual({
      error: AGENT_V2_REFUSED
    })
    expect(resolveAgentEdit(project, { edit: 'delete', tag: 'storm' })).toEqual({
      error: AGENT_V2_REFUSED
    })
    // The book's own edits stay.
    expect(
      resolveAgentEdit(project, { edit: 'text', id, find: 'the lantern', replace: 'a lamp' })
    ).toMatchObject({ edit: { kind: 'text' } })
    expect(resolveAgentEdit(project, { edit: 'delete', id })).toMatchObject({
      edit: { kind: 'delete', target: 'node' }
    })
  })

  it('leaves a v1 run as it was', () => {
    const project = loadAgentProject(db, null, 'v1')
    expect(runAgentTool(project, null, 'tags', {}).result).not.toBe(AGENT_V2_REFUSED)
    expect(resolveAgentEdit(project, { edit: 'summaries' })).toEqual({
      edit: { kind: 'summaries' }
    })
  })
})

describe('lookup in v2 (F-16.4)', () => {
  it('reads the record: names, Pinned canon lines, Ideas, POV scenes and where it is named', () => {
    const project = v2()
    const result = runAgentTool(project, null, 'lookup', { name: 'mara' }).result
    expect(result).toContain('Mara Vell (character); also Mara')
    expect(result).toContain('Pinned [canon]: Eyes: grey as the harbour.')
    expect(result).not.toContain('twin lantern')
    expect(result).toContain('Ideas [idea]: Maybe the lantern was her mother’s.')
    expect(result).toContain(
      `POV in: ${ref(project, scenes[1])} (place: the ferry deck, time: night)`
    )
    expect(result).toContain(
      `Named in 2 scenes (2 up to now): first ${ref(project, scenes[0])} ¶0, last ${ref(project, scenes[1])} ¶1`
    )
  })

  it('says what to try for a name no record answers', () => {
    expect(runAgentTool(v2(), null, 'lookup', { name: 'Pell' }).result).toContain(
      'No record is called "Pell"'
    )
  })

  it('finds the scenes for cards by the name scan', () => {
    const result = runAgentTool(v2(), null, 'cards', { name: 'Mara Vell' })
    expect(result.step.label).toBe('Reading 2 scene cards…')
  })
})

describe('the v2 cards in tool outputs (F-16.20)', () => {
  const card = (nodeId: string, line: string, gist: string): void =>
    upsertCard(
      db,
      {
        nodeId,
        draftId: activeDraftId(db),
        readingId: null,
        line,
        gist,
        fields: {
          ...emptyCardFields(),
          where: { value: 'the ferry', quote: 'The ferry left', p: 0, verified: true }
        },
        present: [],
        mood: 'still',
        theme: null,
        anchor: cardAnchorOf(db, nodeId),
        seen: []
      },
      NOW
    )

  it('cards reads the v2 card as a map, and says when a scene has none yet', () => {
    card(scenes[1] ?? '', 'The ferry leaves with Mara asleep.', 'The ferry leaves at night.')
    const project = v2()
    const result = runAgentTool(project, null, 'cards', { name: 'Mara Vell' }).result
    expect(result).toContain(`Map (${CARD_MAP_NOTE}): The ferry leaves with Mara asleep.`)
    expect(result).toContain('Where: the ferry')
    expect(result).toContain('Mood: still')
    expect(result).toContain('No card yet; read the scene.')
  })

  it('read_summary gives the gist labelled as a map; lookup gives the last card up to now', () => {
    card(scenes[1] ?? '', 'The ferry leaves with Mara asleep.', 'The ferry leaves at night.')
    const project = v2()
    // `read_summary` left the tool list in agent.v6; a run on an older list still reaches it.
    const read = runAgentTool(
      project,
      null,
      'read_summary',
      { id: ref(project, scenes[1]) },
      AGENT_TOOLS
    ).result
    expect(read).toContain(CARD_MAP_NOTE)
    expect(read).toContain('The ferry leaves at night.')
    expect(
      runAgentTool(project, null, 'read_summary', { id: ref(project, scenes[0]) }, AGENT_TOOLS)
        .result
    ).toContain('has no card yet; read the scene.')
    const lookup = runAgentTool(project, null, 'lookup', { name: 'Mara' }).result
    expect(lookup).toContain(`Last seen ${ref(project, scenes[1])}`)
    expect(lookup).toContain('Map (')
  })
})

describe('find_passages in v2 (F-16.4)', () => {
  it('labels every hit by what it means', () => {
    const project = v2()
    const result = runAgentTool(project, null, 'find_passages', { query: 'lantern' }).result
    const lines = result.split('\n')
    const line = (start: string): string => lines.find((each) => each.startsWith(start)) ?? ''
    expect(line(`${ref(project, scenes[0])} ¶0`)).toContain('[canon]: Mara walked in')
    expect(line(`${ref(project, scenes[1])} notes ¶0`)).toContain('[plan]')
    expect(line("Mara Vell's Pinned ¶1")).toContain('[idea]: She has a twin lantern')
    expect(line("Mara Vell's Ideas ¶0")).toContain('[idea]')
    expect(line('Research "Lantern lore" ¶0')).toContain('[canon]: A ferry lantern')
  })

  it('never places an Idea scene or a scene note in time, and lookup lists Idea scenes apart', () => {
    // An Idea scene before now: it never happened, wherever it sits.
    const parentId = getNode(db, scenes[0] ?? '')?.parentId ?? ''
    const idea = createNode(db, 'novel', {
      parentId,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Dream'
    }).id
    moveNode(db, idea, parentId, scenes[0] ?? null)
    saveDocument(db, idea, doc({ text: 'Mara dreamed the lantern went out.' }))
    setSceneMeta(db, idea, { location: '', pov: '', timeline: '', status: 'idea' })
    scanNamesFor(db, idea, NOW)
    indexScene(db, idea, NOW)
    const project = v2()
    const result = runAgentTool(project, null, 'find_passages', { query: 'lantern' }).result
    const lines = result.split('\n')
    const line = (start: string): string => lines.find((each) => each.startsWith(start)) ?? ''
    expect(line(`${ref(project, idea)} ¶0`)).toBe(
      `${ref(project, idea)} ¶0 (an Idea scene: never happened) [idea]: Mara dreamed the lantern went out.`
    )
    const notes = line(`${ref(project, scenes[1])} notes ¶0`)
    expect(notes).toContain(`(notes for ${ref(project, scenes[1])}: a plan) [plan]`)
    expect(result).not.toMatch(/never happened\) \[canon\]|notes ¶0 \(before now/)
    const lookup = runAgentTool(project, null, 'lookup', { name: 'Mara Vell' }).result
    expect(lookup).toContain(
      `Named in 2 scenes (2 up to now): first ${ref(project, scenes[0])} ¶0, last ${ref(project, scenes[1])} ¶1`
    )
    expect(lookup).toContain(
      `[idea] Also named in Idea or left-out scenes (never happened): ${ref(project, idea)}`
    )
  })

  it('maps each source to its mark', () => {
    expect(passageMark('scene')).toBe('[canon]')
    expect(passageMark('pinned')).toBe('[canon]')
    expect(passageMark('note')).toBe('[canon]')
    expect(passageMark('research')).toBe('[canon]')
    expect(passageMark('sceneNote')).toBe('[plan]')
    expect(passageMark('idea')).toBe('[idea]')
    expect(passageMark('notCanon')).toBe('[idea]')
    expect(passageMark('ideaScene')).toBe('[idea]')
  })
})

describe('todo in v2 (F-16.10)', () => {
  it('lists the author’s open to-dos with their links, and how many are done', () => {
    const project = v2()
    const result = runAgentTool(project, null, 'todo', {}).result
    expect(result).toBe(
      `The author's to-dos:\n- Check the tide tables (${ref(project, scenes[1])}; Mara Vell)\n(1 done.)`
    )
  })
})
