import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { STORY_BIBLE_HEADING, STORY_BIBLE_PLANS_HEADING } from '@shared/storyBible'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { setAiSettings } from '../project/settingsStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createSeededProject } from '../project/testProject'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { runChat } from './chat'
import {
  ARCHIVED_BIBLE_MARKERS,
  NAMED_NOTE_TEXT,
  seedArchivedBible
} from './context/archivedBibleFixture'
import { runCritique } from './critique'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { generateGhostText } from './ghostText'
import { resetInflight } from './inflight'
import type { CompletionRequest, CompletionResult, Provider, StreamChunk } from './providers/types'
import type { AiRequestDeps } from './request'
import { runRewrite } from './rewrite'
import { runSuggestNotes } from './sceneSuggest'
import { runWhatNext } from './whatNext'

/**
 * Notes redesign (2026-10-15, `vibe.md` part A): with the old story bible archived, each v1 prose
 * feature's story-bible block carries the note page the scene names and no tag, bank line, sheet
 * or scene steer: ghost text, Rewrite, the old chat in both modes, critique, What next and the
 * suggested notes.
 */

const NOW = new Date(2026, 9, 15, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>
type Stream = (request: CompletionRequest) => AsyncIterable<StreamChunk>

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let complete: ReturnType<typeof vi.fn<Complete>>
let stream: ReturnType<typeof vi.fn<Stream>>
let deps: AiRequestDeps

const SCENE_TEXT =
  'The storm broke at dusk over the dark forest. Wren pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last. She had come to the landing to meet the ' +
  'ferryman, and the ferryman had not come. The river rose against the posts and the rope ' +
  'creaked in its iron ring. She waited, and the dark came down around her like a shut door.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** A JSON answer each feature's parser reads, by its prompt's opening. */
function answerFor(request: CompletionRequest): string {
  const system = request.messages[0]?.content ?? ''
  if (system.includes('what-comes-next feature')) {
    return JSON.stringify({
      directions: [1, 2, 3].map((n) => ({ title: `Way ${n}`, text: `Wren tries way ${n}.` }))
    })
  }
  if (system.includes('scene-notes feature')) return '{"points":["Wren fears the river."]}'
  if (request.json === true) return '{"notes":[]}'
  return 'She turned back to the ridge and said nothing.'
}

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-archived-bible-'))
  session = createSeededProject(projectFolderFor(tmp, 'Archived'), 'Archived', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(SCENE_TEXT))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  seedArchivedBible(db, scene)
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
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream,
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  deps = {
    providers: { get: () => provider },
    ledger: { insert: () => {} },
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

/** Runs `send` and checks its requests carried the named page and nothing of the old bible. */
async function carriesNotesOnly(
  send: () => Promise<unknown>,
  heading: string = STORY_BIBLE_HEADING
): Promise<void> {
  await send()
  const text = sent()
  expect(text).toContain(heading)
  expect(text).toContain(`Note “Wren — powers”: ${NAMED_NOTE_TEXT}`)
  for (const marker of ARCHIVED_BIBLE_MARKERS) expect(text).not.toContain(marker)
}

describe('the v1 prose features with the old story bible archived (notes redesign, 2026-10-15)', () => {
  it('ghost text', async () => {
    await carriesNotesOnly(() =>
      generateGhostText(db, deps, {
        nodeId: scene,
        before: SCENE_TEXT.slice(0, 200),
        after: '',
        memory: 'v1'
      })
    )
  })

  it('Rewrite in my voice', async () => {
    await carriesNotesOnly(() =>
      runRewrite(
        db,
        deps,
        { nodeId: scene, text: SCENE_TEXT.slice(0, 120), before: '', after: '', memory: 'v1' },
        () => undefined
      )
    )
  })

  it('the old chat in Plan and Author mode', async () => {
    for (const mode of ['plan', 'agent'] as const) {
      complete.mockClear()
      stream.mockClear()
      await carriesNotesOnly(() =>
        runChat(
          db,
          deps,
          { nodeId: scene, mode, paragraphs: 1, message: 'What next?', history: [], memory: 'v1' },
          () => undefined
        )
      )
    }
  })

  it("editor's notes", async () => {
    await carriesNotesOnly(() => runCritique(db, deps, { nodeId: scene, memory: 'v1' }))
  })

  it('What comes next', async () => {
    await carriesNotesOnly(
      () => runWhatNext(db, deps, { nodeId: scene, memory: 'v1' }),
      STORY_BIBLE_PLANS_HEADING
    )
  })

  it('suggested notes', async () => {
    await carriesNotesOnly(
      () => runSuggestNotes(db, deps, { nodeId: scene, memory: 'v1' }),
      STORY_BIBLE_PLANS_HEADING
    )
  })
})
