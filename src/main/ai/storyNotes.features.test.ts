import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { STORY_NOTES_CONTINUITY_HEADING, STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { STORY_BIBLE_HEADING, STORY_BIBLE_PLANS_HEADING } from '@shared/storyBible'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { revealIn, seedClaims } from '../memory/reading/claimFixture'
import { setKnewBefore } from '../memory/reading/knewBeforeStore'
import { createTopic } from '../memory/reading/topicStore'
import { createRecord, listRecords, savePage } from '../memory/recordStore'
import {
  SEEDED_CANON_LINE,
  SEEDED_IDEA_TEXT,
  SEEDED_NOT_CANON_TEXT,
  SEEDED_TONE,
  seedStoryNotes
} from '../memory/storyNotesFixture'
import { setAiSettings } from '../project/settingsStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createSeededProject } from '../project/testProject'
import { addDocumentTag } from '../tag/documentTagStore'
import { createTag } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { draftForAgent } from './agentDraft'
import { runChat } from './chat'
import { runCritique } from './critique'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { editScene } from './editPass'
import { resetInflight } from './inflight'
import type { CompletionRequest, CompletionResult, Provider, StreamChunk } from './providers/types'
import type { AiRequestDeps } from './request'
import { runRewrite } from './rewrite'
import { runSuggestNotes } from './sceneSuggest'
import type { UsageEntry } from './usageStore'
import { runWhatNext } from './whatNext'

/**
 * F-16.14: each prose feature sends its old prompt version in a story memory v1 project (the
 * story bible, unchanged) and its new one in a v2 project (the Story notes block in the bible's
 * slot, never Ideas or Not canon text). Ghost text has its own case in `ghostText.test.ts`.
 */

const NOW = new Date(2026, 9, 12, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>
type Stream = (request: CompletionRequest) => AsyncIterable<StreamChunk>

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let complete: ReturnType<typeof vi.fn<Complete>>
let stream: ReturnType<typeof vi.fn<Stream>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let maraTag: string

const SCENE_TEXT =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last. She had come to the landing to meet the ' +
  'ferryman, and the ferryman had not come. The river rose against the posts and the rope ' +
  'creaked in its iron ring. She waited, and the dark came down around her like a shut door.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** A JSON answer each feature's parser accepts (or at least reads), by its prompt's opening. */
function answerFor(request: CompletionRequest): string {
  const system = request.messages[0]?.content ?? ''
  if (system.includes('edit-pass feature')) return '{"changes":[]}'
  if (system.includes('what-comes-next feature')) {
    return JSON.stringify({
      directions: [1, 2, 3].map((n) => ({ title: `Way ${n}`, text: `Mara tries way ${n}.` }))
    })
  }
  if (system.includes('scene-notes feature')) return '{"points":["Mara fears the river."]}'
  if (request.json === true) return '{"notes":[]}'
  return 'She turned back to the ridge and he followed, and they said nothing.'
}

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-story-notes-features-'))
  session = createSeededProject(projectFolderFor(tmp, 'Notes'), 'Notes', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(SCENE_TEXT))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  // v1's bible needs a fact to render: a character tag in the bank.
  maraTag = createTag(db, { name: 'mara', category: 'character', color: '#112233' }).id
  seedStoryNotes(db, scene, NOW)
  complete = vi.fn<Complete>((request) =>
    Promise.resolve({
      text: answerFor(request),
      model: 'gpt-5.4',
      usage: { inputTokens: 100, outputTokens: 10 }
    })
  )
  stream = vi.fn<Stream>(async function* (request) {
    yield { delta: answerFor(request), usage: { inputTokens: 100, outputTokens: 10 } }
  })
  ledger = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream,
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: { get: () => undefined, put: () => {} },
    dailyCap: { get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }), spend: () => {} },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  resetVoiceProfileCache()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Every message of every request so far, in one string. */
const sent = (): string =>
  [...complete.mock.calls, ...stream.mock.calls]
    .flatMap(([request]) => request.messages.map((m) => m.content))
    .join('\n')

/**
 * Runs `send` in v1, then in v2, and answers the prompt versions the ledger recorded for each,
 * checking the v1 request carried a bible and no Story notes, and the v2 request the Story notes
 * (with the seeded canon line, without the Not canon or Ideas text) and no bible.
 */
async function bothMemories(
  send: (memory: StoryMemoryVersion) => Promise<unknown>,
  bibleHeading: string = STORY_BIBLE_HEADING
): Promise<{ v1: (string | null | undefined)[]; v2: (string | null | undefined)[] }> {
  await send('v1').catch(() => undefined)
  const v1 = ledger.map((row) => row.promptVersion)
  const v1Text = sent()
  expect(v1Text).toContain(bibleHeading)
  expect(v1Text).not.toContain(STORY_NOTES_HEADING)
  complete.mockClear()
  stream.mockClear()
  ledger.length = 0
  await send('v2').catch(() => undefined)
  const v2Text = sent()
  expect(v2Text).toContain(STORY_NOTES_HEADING)
  expect(v2Text).toContain(`Mara Vell: ${SEEDED_CANON_LINE}.`)
  expect(v2Text).not.toContain(bibleHeading)
  expect(v2Text).not.toContain(SEEDED_NOT_CANON_TEXT)
  expect(v2Text).not.toContain(SEEDED_IDEA_TEXT)
  return { v1, v2: ledger.map((row) => row.promptVersion) }
}

describe('the prose features by story memory (F-16.14)', () => {
  it('Rewrite in my voice: rewrite.v4 in v1, rewrite.v5 in v2', async () => {
    const run = (memory: StoryMemoryVersion): Promise<unknown> =>
      runRewrite(
        db,
        deps,
        { nodeId: scene, text: SCENE_TEXT.slice(0, 120), before: '', after: '', memory },
        () => undefined
      )
    expect(await bothMemories(run)).toEqual({ v1: ['rewrite.v4'], v2: ['rewrite.v5'] })
  })

  it('a rewrite asked again: rewriteRegen.v4 in v1, rewriteRegen.v5 in v2', async () => {
    const run = (memory: StoryMemoryVersion): Promise<unknown> =>
      runRewrite(
        db,
        deps,
        {
          nodeId: scene,
          text: SCENE_TEXT.slice(0, 120),
          before: '',
          after: '',
          note: 'Less.',
          memory
        },
        () => undefined
      )
    expect(await bothMemories(run)).toEqual({ v1: ['rewriteRegen.v4'], v2: ['rewriteRegen.v5'] })
  })

  it('the chat in Plan and Author mode: chat.v5 in v1, chat.v6 in v2', async () => {
    for (const mode of ['plan', 'agent'] as const) {
      const run = (memory: StoryMemoryVersion): Promise<unknown> =>
        runChat(
          db,
          deps,
          { nodeId: scene, mode, paragraphs: 1, message: 'What next?', history: [], memory },
          () => undefined
        )
      expect(await bothMemories(run), mode).toEqual({ v1: ['chat.v5'], v2: ['chat.v6'] })
      complete.mockClear()
      stream.mockClear()
      ledger.length = 0
    }
  })

  it('the chat agent’s drafted insertion: chat.v5 in v1, chat.v6 in v2', async () => {
    const run = (memory: StoryMemoryVersion): Promise<unknown> =>
      draftForAgent(
        db,
        deps,
        {
          nodeId: scene,
          brief: 'Tomas arrives.',
          words: 90,
          before: SCENE_TEXT,
          after: '',
          passage: null,
          memory
        },
        () => undefined
      )
    expect(await bothMemories(run)).toEqual({ v1: ['chat.v5'], v2: ['chat.v6'] })
  })

  it("editor's notes: critique.v3 in v1, critique.v4 in v2", async () => {
    const run = (memory: StoryMemoryVersion): Promise<unknown> =>
      runCritique(db, deps, { nodeId: scene, memory })
    expect(await bothMemories(run)).toEqual({ v1: ['critique.v3'], v2: ['critique.v4'] })
    ledger.length = 0
    await runCritique(db, deps, { nodeId: scene, note: 'Pacing.', memory: 'v2' })
    expect(ledger.map((row) => row.promptVersion)).toEqual(['critiqueRegen.v4'])
  })

  it('What comes next: whatNext.v3 in v1, whatNext.v4 in v2', async () => {
    const run = (memory: StoryMemoryVersion): Promise<unknown> =>
      runWhatNext(db, deps, { nodeId: scene, memory })
    expect(await bothMemories(run, STORY_BIBLE_PLANS_HEADING)).toEqual({
      v1: ['whatNext.v3'],
      v2: ['whatNext.v4']
    })
  })

  it('suggested notes: notesSuggest.v2 in v1, notesSuggest.v4 in v2 (F-16.20: the card)', async () => {
    const run = (memory: StoryMemoryVersion): Promise<unknown> =>
      runSuggestNotes(db, deps, { nodeId: scene, memory })
    expect(await bothMemories(run, STORY_BIBLE_PLANS_HEADING)).toEqual({
      v1: ['notesSuggest.v2'],
      v2: ['notesSuggest.v4']
    })
  })

  it('a continuity edit pass: checked against the Story notes with editPass.v3 in v2', async () => {
    const pass = (memory: StoryMemoryVersion): Promise<unknown> =>
      editScene(db, deps, {
        passId: 'p-1',
        memory,
        type: 'continuity',
        instruction: null,
        nodeId: scene,
        requestPrefix: 'ep',
        signal: new AbortController().signal
      })
    await pass('v2')
    expect(ledger.map((row) => row.promptVersion)).toEqual(['editPass.v3'])
    const text = sent()
    // The continuity form: the notes are the reference, with no tone line to "check".
    expect(text).toContain(STORY_NOTES_CONTINUITY_HEADING)
    expect(text).toContain(`Mara Vell: ${SEEDED_CANON_LINE}.`)
    expect(text).not.toContain(STORY_NOTES_HEADING)
    expect(text).not.toContain(SEEDED_TONE)
    expect(text).not.toContain('References:')
    expect(text).not.toContain(SEEDED_NOT_CANON_TEXT)
    expect(text).not.toContain(SEEDED_IDEA_TEXT)
    // A line edit in v2 sends editPass.v3 too, with version 2's messages (no notes).
    complete.mockClear()
    ledger.length = 0
    await editScene(db, deps, {
      passId: 'p-2',
      memory: 'v2',
      type: 'line',
      instruction: null,
      nodeId: scene,
      requestPrefix: 'ep2',
      signal: new AbortController().signal
    })
    expect(ledger.map((row) => row.promptVersion)).toEqual(['editPass.v3'])
    expect(sent()).not.toContain(STORY_NOTES_HEADING)
    expect(sent()).not.toContain(STORY_NOTES_CONTINUITY_HEADING)
    // With no Pinned line to check against (only Here and a tone label), nothing is sent.
    const mara = listRecords(db).find((record) => record.name === 'Mara Vell')
    savePage(db, mara?.id ?? '', 'pinned', null, NOW)
    complete.mockClear()
    ledger.length = 0
    await pass('v2')
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toEqual([])
  })

  it('a #name in a v2 chat sends no tagged document’s notes (tags are frozen v1 data)', async () => {
    // Another document of the book, tagged #mara, holds the note (the scene's own notes ride
    // in its side panel either way).
    const other = listNodes(db).find((r) => r.kind === 'document' && r.id !== scene)?.id ?? ''
    addDocumentTag(db, other, maraTag)
    saveNotes(db, other, doc('TAGGED-NOTE Mara fears the river.'))
    const run = (memory: StoryMemoryVersion): Promise<unknown> =>
      runChat(
        db,
        deps,
        {
          nodeId: scene,
          mode: 'plan',
          paragraphs: 1,
          message: 'Tell me about #mara',
          history: [],
          memory
        },
        () => undefined
      )
    await run('v1')
    expect(sent()).toContain('Referenced notes:\n#mara:\nTAGGED-NOTE')
    stream.mockClear()
    complete.mockClear()
    await run('v2')
    expect(sent()).not.toContain('Referenced notes')
    expect(sent()).not.toContain('TAGGED-NOTE Mara fears')
  })
})

describe('who knows what never reaches a prose prompt (F-16.22, P2b rule 9)', () => {
  it('sends no secret, knows line, knew-before or scoped absence in any v2 prose request', async () => {
    const mara = listRecords(db).find((record) => record.name === 'Mara Vell')?.id ?? ''
    const tomas = createRecord(db, { name: 'Tomas', categoryId: 'character', force: true }, NOW)
    if (!('record' in tomas)) throw new Error('blocked')
    const secret = createTopic(
      db,
      {
        kind: 'secret',
        label: 'the missing ferryman',
        quote: revealIn(db, scene, {
          para: 0,
          quote: 'the ferryman had not come',
          label: 'the missing ferryman'
        })
      },
      NOW
    ).recordId
    seedClaims(
      db,
      scene,
      [
        {
          recordId: mara,
          slot: 'knows',
          value: 'saw',
          how: 'saw',
          objectId: secret,
          quote: 'the ferryman had not come',
          para: 0,
          proof: 'verified'
        }
      ],
      NOW
    )
    setKnewBefore(db, secret, tomas.record.id, true, NOW)
    const runs: (() => Promise<unknown>)[] = [
      () =>
        runRewrite(
          db,
          deps,
          { nodeId: scene, text: SCENE_TEXT.slice(0, 120), before: '', after: '', memory: 'v2' },
          () => undefined
        ),
      () =>
        runChat(
          db,
          deps,
          {
            nodeId: scene,
            mode: 'plan',
            paragraphs: 1,
            message: 'Who knows about the ferryman?',
            history: [],
            memory: 'v2'
          },
          () => undefined
        ),
      () =>
        draftForAgent(
          db,
          deps,
          {
            nodeId: scene,
            brief: 'Tomas arrives.',
            words: 90,
            before: SCENE_TEXT,
            after: '',
            passage: null,
            memory: 'v2'
          },
          () => undefined
        ),
      () => runCritique(db, deps, { nodeId: scene, memory: 'v2' }),
      () => runWhatNext(db, deps, { nodeId: scene, memory: 'v2' }),
      () => runSuggestNotes(db, deps, { nodeId: scene, memory: 'v2' }),
      () =>
        editScene(db, deps, {
          passId: 'p-k',
          memory: 'v2',
          type: 'continuity',
          instruction: null,
          nodeId: scene,
          requestPrefix: 'epk',
          signal: new AbortController().signal
        })
    ]
    for (const run of runs) await run().catch(() => undefined)
    const text = sent()
    expect(text).toContain(STORY_NOTES_HEADING)
    expect(text).not.toMatch(/No scene shows|checked up to|not checked yet/i)
    expect(text).not.toMatch(/(doesn['’]t|does not) know/i)
    expect(text).not.toContain('the missing ferryman')
    expect(text).not.toMatch(/knew before/i)
  })
})
