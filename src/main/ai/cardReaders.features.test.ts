import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { CARD_PROMPT_HEADING } from '@shared/memory/cardText'
import { emptyCardFields } from '@shared/memory/claims'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { upsertSummary } from '../document/summaryStore'
import { activeDraftId } from '../draft/draftStore'
import { upsertCard } from '../memory/reading/cardStore'
import { setAiSettings } from '../project/settingsStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createSeededProject } from '../project/testProject'
import { createNode, getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { parseBetaReaderAnswerV2, runBetaReader } from './betaReader'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import { BETA_READER_MAP_HEADING } from './prompts/betaReader.v2'
import { SYNOPSIS_V2_SENTINEL } from './prompts/synopsis.v2'
import type { CompletionRequest, CompletionResult, Provider, StreamChunk } from './providers/types'
import type { AiRequestDeps } from './request'
import { runRewrite } from './rewrite'
import { runSuggestNotes, runSuggestSynopsis } from './sceneSuggest'
import type { UsageEntry } from './usageStore'

/**
 * F-16.20: the readers that read stored summaries read the v2 card in a story memory v2 project
 * (the synopsis and notes suggestions, the beta reader's earlier scenes as a map of gists, the
 * rewrite's mood) and send exactly what they sent before in a v1 project.
 */

const NOW = new Date(2026, 9, 12, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>
type Stream = (request: CompletionRequest) => AsyncIterable<StreamChunk>

let tmp: string
let session: ProjectSession
let db: TreeDb
let earlier: string
let scene: string
let complete: ReturnType<typeof vi.fn<Complete>>
let stream: ReturnType<typeof vi.fn<Stream>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let betaAnswer: string

const EARLIER_TEXT = 'Mara found the ledger her brother had copied and hid it under the floor.'
const SCENE_TEXT =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last. She had come to the landing to meet the ' +
  'ferryman, and the ferryman had not come. The river rose against the posts and the rope ' +
  'creaked in its iron ring. She waited, and the dark came down around her like a shut door.'
const EARLIER_GIST = 'Mara hides the copied ledger under the floor of the mill.'
const SUMMARY_TEXT = 'Mara finds and hides the ledger.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function card(nodeId: string, line: string, gist: string, mood: string | null = null): void {
  upsertCard(
    db,
    {
      nodeId,
      draftId: activeDraftId(db),
      readingId: null,
      line,
      gist,
      fields: emptyCardFields(),
      present: [],
      mood,
      theme: null,
      anchor: [],
      seen: []
    },
    NOW
  )
}

function answerFor(request: CompletionRequest): string {
  const system = request.messages[0]?.content ?? ''
  if (system.includes('synopsis feature')) return '{"synopsis":"Mara waits for the ferry."}'
  if (system.includes('scene-notes feature')) return '{"points":["The river is rising."]}'
  if (system.includes('beta-reader feature')) return betaAnswer
  return 'She turned back to the ridge.'
}

const sent = (): string =>
  [...complete.mock.calls, ...stream.mock.calls]
    .flatMap(([request]) => request.messages.map((m) => m.content))
    .join('\n')

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-card-readers-features-'))
  session = createSeededProject(projectFolderFor(tmp, 'Cards'), 'Cards', 'novel')
  db = session.connection.orm
  // The first scene in reading order (the seeded project's others come after it, empty).
  earlier = manuscriptDocuments(db)[0]?.id ?? ''
  scene = createNode(db, 'novel', {
    parentId: getNode(db, earlier)?.parentId ?? '',
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'The landing'
  }).id
  saveDocument(db, earlier, doc(EARLIER_TEXT))
  saveDocument(db, scene, doc(SCENE_TEXT))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  betaAnswer = JSON.stringify({ items: [] })
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
  // Both memories' material: a stored summary (v1's) and a v2 card for each scene.
  for (const id of [earlier, scene]) {
    upsertSummary(db, {
      nodeId: id,
      summary: SUMMARY_TEXT,
      keyPoints: ['The ledger is copied.'],
      characters: [],
      contentHash: 'h',
      promptVersion: 'summary.v5',
      model: 'gpt-5.4-mini',
      truncated: false,
      createdAt: NOW.toISOString(),
      card: { where: '', when: '', pov: '', changed: '', mood: 'v1 mood', theme: '' }
    })
  }
  card(earlier, 'Mara hides the ledger.', EARLIER_GIST)
  card(scene, 'Mara waits at the landing in a storm.', 'Mara waits at the landing.', 'dread')
})
afterEach(() => {
  resetVoiceProfileCache()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Runs `send` in one memory and answers the versions the ledger recorded and the text sent. */
async function run(
  memory: StoryMemoryVersion,
  send: (memory: StoryMemoryVersion) => Promise<unknown>
): Promise<{ versions: (string | null | undefined)[]; text: string }> {
  complete.mockClear()
  stream.mockClear()
  ledger.length = 0
  await send(memory)
  return { versions: ledger.map((row) => row.promptVersion), text: sent() }
}

describe('the summary readers read cards in v2 (F-16.20)', () => {
  it('suggested synopsis: synopsis.v1 with the stored summary in v1, synopsis.v2 with the card in v2', async () => {
    const send = (memory: StoryMemoryVersion): Promise<unknown> =>
      runSuggestSynopsis(db, deps, { nodeId: scene, memory })
    const v1 = await run('v1', send)
    expect(v1.versions).toEqual(['synopsis.v1'])
    expect(v1.text).toContain(`Stored summary:\n${SUMMARY_TEXT}`)
    expect(v1.text).not.toContain(CARD_PROMPT_HEADING)
    const v2 = await run('v2', send)
    expect(v2.versions).toEqual(['synopsis.v2'])
    expect(v2.text.startsWith(SYNOPSIS_V2_SENTINEL)).toBe(true)
    expect(v2.text).toContain(`${CARD_PROMPT_HEADING}\nLine: Mara waits at the landing in a storm.`)
    expect(v2.text).not.toContain('Stored summary')
  })

  it('suggested notes: the card in the summary’s place in v2 (notesSuggest.v4)', async () => {
    const send = (memory: StoryMemoryVersion): Promise<unknown> =>
      runSuggestNotes(db, deps, { nodeId: scene, memory })
    const v1 = await run('v1', send)
    expect(v1.versions).toEqual(['notesSuggest.v2'])
    expect(v1.text).toContain('Stored summary:')
    const v2 = await run('v2', send)
    expect(v2.versions).toEqual(['notesSuggest.v4'])
    expect(v2.text).toContain(CARD_PROMPT_HEADING)
    expect(v2.text).not.toContain('Stored summary')
  })

  it('the beta reader: earlier scenes as their gists, a map; items must quote the current scene', async () => {
    betaAnswer = JSON.stringify({
      items: [
        { category: 'knows', quote: 'the ferryman had not come', note: 'He is late.', ref: 1 },
        // Quotes the map, not the scene: dropped.
        { category: 'believes', quote: 'hides the copied ledger', note: 'A secret.' },
        // A ref past the earlier scenes is left off; the item stays.
        { category: 'expects', quote: 'the dark came down', note: 'Night falls.', ref: 7 }
      ]
    })
    const send = (memory: StoryMemoryVersion): Promise<unknown> =>
      runBetaReader(db, deps, { nodeId: scene, memory })
    const v1 = await run('v1', send)
    expect(v1.versions).toEqual(['betaReader.v1'])
    expect(v1.text).toContain('Scenes read so far, in order (summaries):')
    expect(v1.text).not.toContain(BETA_READER_MAP_HEADING)
    complete.mockClear()
    ledger.length = 0
    const result = await runBetaReader(db, deps, { nodeId: scene, memory: 'v2' })
    expect(ledger.map((row) => row.promptVersion)).toEqual(['betaReader.v2'])
    const text = sent()
    expect(text).toContain(`${BETA_READER_MAP_HEADING}\n[1] `)
    expect(text).toContain(EARLIER_GIST)
    expect(text).not.toContain(SUMMARY_TEXT)
    expect(text).not.toContain(EARLIER_TEXT)
    expect(result.items).toEqual([
      {
        category: 'knows',
        scene: 2,
        quote: 'the ferryman had not come',
        note: 'He is late.',
        ref: 1
      },
      { category: 'expects', scene: 2, quote: 'the dark came down', note: 'Night falls.' }
    ])
    expect(result.dropped).toBe(1)
    expect(result.missing).toBe(0)
  })

  it('the beta reader keeps an item whose ref is malformed, reading a ref written as digits', () => {
    const answer = JSON.stringify({
      items: [
        { category: 'knows', quote: 'the ferryman had not come', note: 'Late.', ref: '1' },
        { category: 'expects', quote: 'the dark came down', note: 'Night.', ref: 'two' },
        { category: 'confusion', quote: 'cold', note: 'Cold.', ref: 1.5 }
      ]
    })
    const { items, dropped } = parseBetaReaderAnswerV2(
      answer,
      'At the quay the ferryman had not come, and the dark came down. It was cold.',
      1
    )
    expect(dropped).toBe(0)
    expect(items).toEqual([
      { category: 'knows', scene: 2, quote: 'the ferryman had not come', note: 'Late.', ref: 1 },
      { category: 'expects', scene: 2, quote: 'the dark came down', note: 'Night.' },
      { category: 'confusion', scene: 2, quote: 'cold', note: 'Cold.' }
    ])
  })

  it('the beta reader counts an earlier scene with no card as missing in v2', async () => {
    const third = createNode(db, 'novel', {
      parentId: getNode(db, scene)?.parentId ?? '',
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'After'
    }).id
    saveDocument(db, third, doc(SCENE_TEXT))
    const result = await runBetaReader(db, deps, { nodeId: third, memory: 'v2' })
    // Both earlier scenes have cards: none missing. The third scene's own card is never read.
    expect(result.missing).toBe(0)
    expect(result.scenes.map((each) => each.current)).toEqual([false, false, true])
    // An earlier scene with no card yet is counted, never sent.
    const later = createNode(db, 'novel', {
      parentId: getNode(db, scene)?.parentId ?? '',
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Last'
    }).id
    saveDocument(db, later, doc(SCENE_TEXT))
    const next = await runBetaReader(db, deps, { nodeId: later, memory: 'v2' })
    expect(next.missing).toBe(1)
    expect(next.scenes).toHaveLength(3)
  })

  it('rewrite: the mood is the v2 card’s, and the Story notes block carries no Mood line', async () => {
    const send = (memory: StoryMemoryVersion): Promise<unknown> =>
      runRewrite(
        db,
        deps,
        { nodeId: scene, text: SCENE_TEXT.slice(0, 120), before: '', after: '', memory },
        () => undefined
      )
    const v2 = await run('v2', send)
    expect(v2.versions).toEqual(['rewrite.v5'])
    expect(v2.text).toContain('Scene mood: dread')
    expect(v2.text).not.toContain('Mood (as read from the prose)')
  })
})
