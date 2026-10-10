import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { Entity } from '@shared/ipc/contract'
import type { SheetSyncStatus } from '@shared/sheetSync'
import { createEntity, getEntity, type EntityDb } from '../entity/entityStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getSheetSyncDue, setAiSettings } from '../project/settingsStore'
import { createSeededProject } from '../project/testProject'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import type { CompletionRequest, CompletionResult, Provider } from './providers/types'
import type { AiRequestDeps } from './request'
import { createSheetSyncService, type SheetSyncService } from './sheetSyncService'

const NOW = new Date(2026, 9, 10, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: EntityDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let service: SheetSyncService
let ready: boolean
let published: SheetSyncStatus[][]
let entities: Entity[]

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout'] })
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-sheetsync-service-'))
  session = createSeededProject(projectFolderFor(tmp, 'Sheets'), 'Sheets', 'novel')
  db = session.connection.orm
  setAiSettings(db, { ...defaultAiSettings(), dial: 1, chatMode: 'auto' })
  complete = vi.fn<Complete>()
  const provider: Provider = {
    id: 'openai',
    resolveModel: () => 'gpt-5.4-mini',
    complete,
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  const cache = new Map<string, { text: string; usage: CompletionResult['usage'] }>()
  deps = {
    providers: { get: () => provider },
    ledger: { insert: () => {} },
    cache: {
      get: (key) => cache.get(key),
      put: (entry) => void cache.set(entry.key, { text: entry.text, usage: entry.usage })
    },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
  ready = true
  published = []
  entities = []
  service = createSheetSyncService({
    db: () => db,
    request: () => deps,
    ready: () => ready,
    cancelRequest: () => {},
    onStatuses: (statuses) => published.push(statuses),
    onEntity: (entity) => entities.push(entity),
    onChangesLogged: () => {}
  })
})
afterEach(() => {
  service.clear()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.useRealTimers()
})

const writeUp = (): void => {
  complete.mockResolvedValueOnce({
    text: '{"intro":"Mara is twenty-seven.","parts":{}}',
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 200, outputTokens: 30 }
  })
}

const mara = (): string =>
  createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '27' } }).entity.id

describe('createSheetSyncService (F-9.18)', () => {
  it('syncs a sheet only after it was left alone for 30 seconds, through the job queue', async () => {
    const id = mara()
    writeUp()
    service.touch(id)
    expect(service.statuses()).toEqual([{ entityId: id, phase: 'waiting', failure: null }])
    await vi.advanceTimersByTimeAsync(20_000)
    service.touch(id)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(complete).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(getEntity(db, id)?.body).toBe('Mara is twenty-seven.')
    expect(entities.map((entity) => entity.id)).toEqual([id])
    expect(service.statuses()).toEqual([])
    expect(getSheetSyncDue(db)).toEqual([])
    expect(published.some((list) => list.some((s) => s.phase === 'running'))).toBe(true)
  })

  it('schedules nothing while AI is off or no provider is ready: the sheet just reads out of date', async () => {
    const id = mara()
    ready = false
    service.touch(id)
    expect(service.statuses()).toEqual([])
    ready = true
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    service.touch(id)
    expect(service.runNow(id)).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(complete).not.toHaveBeenCalled()
    expect(getEntity(db, id)?.sync.state).toBe('pageStale')
  })

  it('runs now on request, and answers false when the views already agree', async () => {
    const id = mara()
    writeUp()
    expect(service.runNow(id)).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(service.runNow(id)).toBe(false)
  })

  it('shows a failure on the sheet with its next step', async () => {
    const id = mara()
    complete.mockResolvedValueOnce({
      text: 'not json',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 1, outputTokens: 1 }
    })
    service.runNow(id)
    await vi.advanceTimersByTimeAsync(10)
    const [status] = service.statuses()
    expect(status).toMatchObject({ entityId: id, phase: 'failed', failure: { code: 'PROVIDER' } })
    expect(status?.failure?.nextStep).toBe('Try again in a moment.')
  })
})
