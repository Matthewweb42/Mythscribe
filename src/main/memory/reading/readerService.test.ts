import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetInflight } from '../../ai/inflight'
import { AiRateLimitError } from '../../ai/providers/types'
import { saveDocument } from '../../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import type { TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { createRecord } from '../recordStore'
import { createReaderService } from './readerService'
import { fakeAi, requestKind, rosterIds, sentChecks, type FakeAi } from './readingFixture'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let settings: AiSettings
let changed: { nodeIds: string[]; recordIds: string[] }[]
let questions: number

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function service(ai: FakeAi): ReturnType<typeof createReaderService> {
  return createReaderService({
    db: () => db,
    settings: () => settings,
    requestDeps: () => ai.deps,
    changed: (payload) => void changed.push(payload),
    questions: () => {
      questions += 1
    }
  })
}

const reading = (): FakeAi =>
  fakeAi((request) => {
    if (requestKind(request) === 'verify') {
      return {
        text: JSON.stringify({
          v: sentChecks(request).map((check) => ({
            i: check.i,
            ok: true,
            r: check.who[0] ?? null,
            voice: 'narration',
            mode: 'now'
          }))
        })
      }
    }
    const mara = rosterIds(request).get('Mara Vell') ?? ''
    return {
      text: JSON.stringify({
        c: [
          {
            p: 0,
            r: mara,
            s: 'eyes',
            v: 'grey',
            q: "Mara's eyes were grey",
            voice: 'narration',
            mode: 'now'
          }
        ],
        n: [
          {
            n: 'Hesk',
            p: 1,
            q: 'Hesk rowed out',
            c: [
              {
                p: 1,
                s: 'role',
                v: 'a boatman',
                q: 'Hesk rowed out, a boatman',
                voice: 'narration',
                mode: 'now'
              }
            ]
          }
        ]
      })
    }
  })

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-reader-service-'))
  session = createProject(projectFolderFor(tmp, 'Service'), 'Service', 'novel')
  db = session.connection.orm
  scene = manuscriptDocuments(db)[0]?.id ?? ''
  saveDocument(db, scene, doc("Mara's eyes were grey.", 'At dawn Hesk rowed out, a boatman.'))
  const made = createRecord(
    db,
    { name: 'Mara Vell', categoryId: 'character', aliases: [{ text: 'Mara' }] },
    NOW
  )
  if (!('record' in made)) throw new Error('blocked')
  settings = { ...defaultAiSettings(), dial: 1 }
  changed = []
  questions = 0
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the reader service’s Read now (F-16.16, F-16.17)', () => {
  it('reads the scene, pushes memory:changed, and the questions when a name waits', async () => {
    const ai = reading()
    const result = await service(ai).readNow(scene, 'read-1')
    expect(result).toMatchObject({ ok: true, read: true, reason: null })
    expect(changed).toHaveLength(1)
    expect(changed[0]?.nodeIds).toEqual([scene])
    expect(questions).toBe(1)
    // Nothing new: up to date, nothing sent, nothing pushed.
    const sent = ai.requests.length
    expect(await service(ai).readNow(scene, 'read-2')).toEqual({
      ok: true,
      read: false,
      reason: 'upToDate',
      readingId: null,
      costUsd: 0
    })
    expect(ai.requests).toHaveLength(sent)
    expect(changed).toHaveLength(1)
  })

  it('answers Use AI off, or the reading switch off, as a DISABLED failure without sending', async () => {
    const ai = reading()
    settings = defaultAiSettings()
    expect(await service(ai).readNow(scene, 'read-3')).toMatchObject({
      ok: false,
      code: 'DISABLED'
    })
    settings = {
      ...defaultAiSettings(),
      dial: 1,
      features: { ...defaultAiSettings().features, verify: false }
    }
    expect(await service(ai).readNow(scene, 'read-4')).toMatchObject({
      ok: false,
      code: 'DISABLED',
      message: 'Story memory check is turned off for this project.'
    })
    expect(ai.requests).toEqual([])
  })

  it('answers a provider failure as data, and a local cut-off as paused', async () => {
    const failing = fakeAi(() => {
      throw new AiRateLimitError('OpenAI is rate-limiting this key.')
    })
    expect(await service(failing).readNow(scene, 'read-5')).toMatchObject({
      ok: false,
      code: 'RATE_LIMIT',
      message: 'OpenAI is rate-limiting this key.'
    })
    const cut = fakeAi(() => ({ text: '', finishReason: 'length' }), { providerId: 'local' })
    expect(await service(cut).readNow(scene, 'read-6')).toMatchObject({
      ok: true,
      read: false,
      reason: 'paused'
    })
  })
})
