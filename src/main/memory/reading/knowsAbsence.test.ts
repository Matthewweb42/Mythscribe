import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STORY_BIBLE_GHOST_TOKEN_BUDGET, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import type { TiptapNodeT } from '@shared/tiptap'
import { loadAgentProject, runAgentTool } from '../../ai/agentTools'
import { EVAL_CASES } from '../../ai/eval/fixtures'
import { resetInflight } from '../../ai/inflight'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { indexScene } from '../passageIndexer'
import { scanNamesFor } from '../nameIndexer'
import { resetNameQuestionCache } from '../questions'
import { createRecord } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { buildStoryNotes } from '../storyNotes'
import { revealIn, seedClaims } from './claimFixture'
import { setKnewBefore } from './knewBeforeStore'
import { runReading } from './pipeline'
import { fakeAi, requestKind } from './readingFixture'
import { writeSceneRead } from './sceneReadStore'
import { createTopic } from './topicStore'
import { sceneMemory } from './views'
import { evidenceFrame, renderEvidence, resolveEvidence } from '../../scribe/evidence'
import { askIndexOf, EvidenceMenu, gatherStep0 } from '../../scribe/step0'
import { navigatorPrefix } from '../../scribe/navigate'
import { runNavigatorTool, type NavigatorWorld } from '../../scribe/tools'
import {
  buildNavigatorPrompt,
  navigatorMenuLine,
  type NavigatorCall
} from '../../ai/prompts/navigator.v1'
import type { EvidenceKey } from '@shared/scribe'

/**
 * Absence is never a fact (F-16.22; plan P2b rule 9, §4.1): whatever the book holds (secrets,
 * knows lines, the author's *Knew before the book*, a POV with no line, scenes checked), nothing
 * that reaches a model or the Story notes block carries "No scene shows …", "checked up to" or a
 * not-knowing line: the Story notes block (both budgets), the `agent.v8` v2 tool outputs that read
 * the book (`lookup`, `cards`, `find_passages`), the `reader.v2` and `verify.v2` requests of a
 * reading, and every prompt eval fixture. The scoped line exists only in the renderer
 * (`knowsView.ts`).
 */

/** The words of the scoped absence line, wherever they would come from. */
const ABSENCE = /No scene shows|checked up to|not checked yet/i
/** A not-knowing line in any wording. */
const NOT_KNOWING = /(doesn['’]t|does not|did not|didn['’]t) know|has not learned|never learns/i

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let two: string
let mara: string
let orrin: string
let tomas: string
let secret: string

const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

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
  resetInflight()
  resetNameQuestionCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-knows-absence-'))
  session = createProject(projectFolderFor(tmp, 'Absence'), 'Absence', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  two = createNode(db, 'novel', {
    parentId: getNode(db, one)?.parentId ?? '',
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  saveDocument(
    db,
    one,
    doc(
      'Mara watched from the stair.',
      'Tomas sold the map to a stranger.',
      'Orrin overheard Tomas from the yard.'
    )
  )
  saveDocument(db, two, doc('Mara waited at the quay with the lantern.'))
  mara = record('Mara')
  orrin = record('Orrin')
  tomas = record('Tomas')
  for (const id of [one, two]) {
    scanNamesFor(db, id, NOW)
    indexScene(db, id, NOW)
  }
  for (const [nodeId, alsoHere] of [
    [one, [orrin, tomas]],
    [two, [orrin]]
  ] as const) {
    setSceneDetails(
      db,
      nodeId,
      {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: [...alsoHere]
      },
      NOW
    )
  }
  secret = createTopic(
    db,
    {
      kind: 'secret',
      label: 'the sold map',
      quote: revealIn(db, one, { para: 1, quote: 'Tomas sold the map', label: 'the sold map' })
    },
    NOW
  ).recordId
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
        objectId: secret,
        quote: 'Orrin overheard Tomas',
        para: 2,
        proof: 'verified'
      }
    ],
    NOW
  )
  setKnewBefore(db, secret, tomas, true, NOW)
  for (const nodeId of [one, two]) {
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
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('absence is never a fact on any surface that reaches a model (P2b rule 9)', () => {
  it('holds a book where the panel would show a scoped line and a tension line', () => {
    const memory = sceneMemory(db, two)
    expect(memory.secrets.tension.map((line) => line.recordId)).toContain(mara)
    expect(memory.secrets.checkedUpTo?.ref).toBe('1.2')
  })

  it('keeps the Story notes block free of absences and of who knows what', () => {
    for (const nodeId of [one, two]) {
      for (const maxTokens of [STORY_BIBLE_TOKEN_BUDGET, STORY_BIBLE_GHOST_TOKEN_BUDGET]) {
        const notes = buildStoryNotes(db, { nodeId, maxTokens }) ?? ''
        expect(notes).not.toMatch(ABSENCE)
        expect(notes).not.toMatch(NOT_KNOWING)
        expect(notes).not.toContain('the sold map')
        expect(notes).not.toMatch(/knew before|overheard/i)
      }
    }
  })

  it('keeps agent.v8’s v2 tool outputs free of absences', () => {
    const project = loadAgentProject(db, two, 'v2')
    for (const [tool, args] of [
      ['lookup', { name: 'Mara' }],
      ['lookup', { name: 'Orrin' }],
      ['lookup', { name: 'the sold map' }],
      ['cards', { name: 'Mara' }],
      ['find_passages', { query: 'map' }]
    ] as const) {
      const { result } = runAgentTool(project, null, tool, { ...args })
      expect(result, `${tool} ${JSON.stringify(args)}`).not.toMatch(ABSENCE)
      expect(result, `${tool} ${JSON.stringify(args)}`).not.toMatch(NOT_KNOWING)
    }
  })

  it('keeps Ms Scribe’s Step 0 and its evidence free of absences (F-16.24, F-16.25)', () => {
    for (const question of [
      'Does Mara know about the sold map?',
      'Who knows about the sold map?',
      'When does Mara first learn of the map?',
      'Mara’s eyes?'
    ]) {
      const step = gatherStep0(db, {
        nodeId: two,
        question,
        focus: { caretPara: null, selection: null }
      })
      const sent = JSON.stringify([step.e0, step.records, step.menu])
      expect(sent, question).not.toMatch(ABSENCE)
      expect(sent, question).not.toMatch(NOT_KNOWING)
      const keys: EvidenceKey[] = [
        ...step.menu.map((item) => item.key),
        { kind: 'knows', secretId: secret },
        { kind: 'timeline', recordId: mara },
        { kind: 'ideas', recordId: mara }
      ]
      const { items } = resolveEvidence(db, keys, two)
      const rendered = renderEvidence(items, 10_000).text
      expect(rendered, question).not.toMatch(ABSENCE)
      expect(rendered, question).not.toMatch(NOT_KNOWING)
    }
    // Mara, Here with no line, gets no line; Orrin and Tomas do.
    const knows = resolveEvidence(db, [{ kind: 'knows', secretId: secret }], two).items[0]?.text
    expect(knows).toContain('Orrin: overheard from Tomas')
    expect(knows).toContain('Tomas: knew before the book')
    expect(knows).not.toContain('Mara')
  })

  it('keeps the navigator’s tools and its prompt free of absences (F-16.25, P3 slice 4)', () => {
    const question = 'Does Mara know about the sold map?'
    const step0 = gatherStep0(db, {
      nodeId: two,
      question,
      focus: { caretPara: null, selection: null }
    })
    const frame = evidenceFrame(db, step0.nowId)
    const world: NavigatorWorld = {
      project: loadAgentProject(db, two, 'v2'),
      frame,
      ask: askIndexOf(db),
      step0,
      menu: new EvidenceMenu(frame, { items: step0.menu, hits: step0.hits }),
      terms: [],
      scope: null,
      reads: 0
    }
    const calls: NavigatorCall[] = [
      { tool: 'knows', arg: 'the sold map' },
      { tool: 'knows', arg: 'Mara' },
      { tool: 'knows', arg: 'Orrin' },
      { tool: 'state', arg: 'Mara' },
      { tool: 'timeline', arg: 'Mara' },
      { tool: 'search', terms: ['map', 'sold'] }
    ]
    for (const call of calls) {
      const run = runNavigatorTool(world, call)
      const shown = [...run.added.map(navigatorMenuLine), run.note ?? ''].join('\n')
      expect(shown, JSON.stringify(call)).not.toMatch(ABSENCE)
      expect(shown, JSON.stringify(call)).not.toMatch(NOT_KNOWING)
    }
    const built = buildNavigatorPrompt({
      prefix: navigatorPrefix(db, frame),
      tail: { now: '1.2', active: null, selection: null, history: [], message: question },
      menu: world.menu.items,
      steps: []
    })
    const sent = built.messages.map((message) => message.content).join('\n')
    expect(sent).not.toMatch(ABSENCE)
    expect(sent).not.toMatch(NOT_KNOWING)
  })

  it('keeps reader.v2 and verify.v2 requests free of absences', async () => {
    saveDocument(db, two, doc('Mara waited at the quay with the lantern.', 'Tomas sold the map.'))
    scanNamesFor(db, two, NOW)
    const ai = fakeAi((request) =>
      requestKind(request) === 'reader'
        ? {
            text: JSON.stringify({
              c: [
                {
                  p: 1,
                  r: 'r3',
                  s: 'knows',
                  o: 's1',
                  how: 'tells',
                  v: 'tells',
                  q: 'Tomas sold the map',
                  voice: 'narration',
                  sp: null,
                  mode: 'now',
                  chg: false
                }
              ],
              n: [],
              same: [],
              drop: []
            })
          }
        : { text: JSON.stringify({ v: [] }) }
    )
    await runReading(db, { ai: ai.deps }, { nodeId: two, caretPara: null, requestId: 'r-abs' })
    const kinds = ai.requests.map(requestKind)
    expect(kinds).toContain('reader')
    for (const request of ai.requests) {
      for (const message of request.messages) {
        expect(message.content).not.toMatch(ABSENCE)
        // The rules say never to list who does not know; nothing else may say it.
        if (message.role !== 'system') expect(message.content).not.toMatch(NOT_KNOWING)
      }
    }
  })

  it('keeps every prompt eval fixture free of the scoped line', () => {
    for (const evalCase of EVAL_CASES) {
      for (const message of evalCase.messages) {
        expect(message.content, `${evalCase.version} ${evalCase.name}`).not.toMatch(ABSENCE)
      }
    }
  })
})
