import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { TiptapNodeT } from '@shared/tiptap'
import { VOICE_AUTO_REFRESH_WORDS } from '@shared/voice'
import { defaultAiUsageState, dayOf } from '../ai/dailyCap'
import { resetInflight } from '../ai/inflight'
import {
  AiCancelledError,
  InvalidKeyError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getVoiceNotes, setAiSettings, setVoiceNotes } from '../project/settingsStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { listExemplars } from './exemplarStore'
import { manuscriptDocuments } from './profile'
import { resetVoiceProfileCache } from './versionCache'
import { manuscriptRootId, runVoiceJob, type VoiceJobDeps, type VoiceJobMemo } from './voiceJob'

const NOW = new Date(2026, 9, 6, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

const OWN =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited. The ' +
  'wind came off the water and pushed the lantern flame flat.'

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let ready: boolean
let deps: VoiceJobDeps
let memo: VoiceJobMemo

function requestDeps(): AiRequestDeps {
  const provider: Provider = {
    id: 'openai',
    resolveModel: () => 'gpt-5.4-mini',
    complete,
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  return {
    providers: { get: () => provider },
    ledger: { insert: () => {} },
    cache: { get: () => undefined, put: () => {} },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
}

/** Notes stored long ago, so the next run is due whatever the manuscript holds. */
const staleNotes = (): void =>
  void setVoiceNotes(db, { notes: ['Old.'], basedOnWords: 100_000, model: 'm', updated: 'x' })

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-voicejob-'))
  session = createProject(projectFolderFor(tmp, 'Voice job'), 'Voice job', 'novel')
  db = session.connection.orm
  const scene = manuscriptDocuments(db)[0]?.id ?? ''
  const doc: TiptapNodeT = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: OWN }] }]
  }
  saveDocument(db, scene, doc)
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  complete.mockResolvedValue({
    text: JSON.stringify({ notes: ['New note.'] }),
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 500, outputTokens: 20 }
  })
  ready = true
  deps = { request: requestDeps, providerReady: () => ready, now: () => NOW }
  memo = { failedAtWords: null }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('manuscriptRootId', () => {
  it('answers the manuscript section root', () => {
    const root = listNodes(db).find((r) => r.parentId === null && r.sectionType === 'manuscript')
    expect(manuscriptRootId(db)).toBe(root?.id)
  })
})

describe('runVoiceJob (F-14.14)', () => {
  it('picks the automatic exemplars locally even with the AI off, and sends nothing', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    staleNotes()
    const result = await runVoiceJob(db, deps, { memo })
    expect(result).toEqual({ exemplarsChanged: true, notesChanged: false, requested: false })
    expect(listExemplars(db).map((e) => [e.text, e.source])).toEqual([[OWN, 'auto']])
    expect(complete).not.toHaveBeenCalled()
  })

  it('does not ask for notes without a provider or before they are due', async () => {
    ready = false
    staleNotes()
    expect((await runVoiceJob(db, deps, { memo })).requested).toBe(false)
    ready = true
    // A short manuscript and no notes yet: under the minimum, nothing is due.
    setVoiceNotes(db, { notes: [], basedOnWords: 0, model: null, updated: 'x' })
    expect((await runVoiceJob(db, deps, { memo })).requested).toBe(false)
    expect(complete).not.toHaveBeenCalled()
  })

  it('refreshes the notes when due and allowed', async () => {
    staleNotes()
    const result = await runVoiceJob(db, deps, { memo })
    expect(result).toMatchObject({ notesChanged: true, requested: true })
    expect(getVoiceNotes(db)?.notes).toEqual(['New note.'])
  })

  it('swallows a failure and does not ask again until the manuscript has moved', async () => {
    staleNotes()
    complete.mockReset()
    complete.mockRejectedValue(new InvalidKeyError('bad key'))
    const first = await runVoiceJob(db, deps, { memo })
    expect(first).toMatchObject({ notesChanged: false })
    expect(memo.failedAtWords).toBe(manuscriptDocuments(db)[0]?.wordCount)
    expect(complete).toHaveBeenCalledTimes(1)
    await runVoiceJob(db, deps, { memo })
    expect(complete).toHaveBeenCalledTimes(1)
    memo.failedAtWords = -VOICE_AUTO_REFRESH_WORDS
    await runVoiceJob(db, deps, { memo })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('passes a cancel on, so Stop still stops the job', async () => {
    staleNotes()
    complete.mockReset()
    complete.mockRejectedValue(new AiCancelledError('stopped'))
    await expect(runVoiceJob(db, deps, { memo })).rejects.toBeInstanceOf(AiCancelledError)
  })
})
