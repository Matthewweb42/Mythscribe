import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { createEntity, getEntity, updateEntity, type EntityDb } from '../entity/entityStore'
import { undoRun, listChanges } from '../knowledge/changeLog'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings, setStoryBibleSettings } from '../project/settingsStore'
import { createSeededProject } from '../project/testProject'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import type { CompletionRequest, CompletionResult, Provider } from './providers/types'
import type { AiRequestDeps } from './request'
import {
  applyHeldSheetSync,
  dismissHeldSheetSync,
  parseRefileAnswer,
  parseWriteUpAnswer,
  runSheetSync,
  sheetNeedsSync
} from './sheetSync'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 10, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: EntityDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]

function answer(json: unknown): void {
  complete.mockResolvedValueOnce({
    text: JSON.stringify(json),
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 300, outputTokens: 120 }
  })
}

const mode = (chatMode: 'auto' | 'ask' | 'plan'): void => {
  setAiSettings(db, { ...defaultAiSettings(), dial: 1, chatMode })
}

const sheet = (id: string) => {
  const found = getEntity(db, id)
  if (found === undefined) throw new Error('no sheet')
  return found
}

function mara(fields = { age: '27', appearance: 'A scar over her left eye.' }): string {
  return createEntity(db, { kind: 'character', name: 'Mara', fields }).entity.id
}

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-sheetsync-'))
  session = createSeededProject(projectFolderFor(tmp, 'Sheets'), 'Sheets', 'novel')
  db = session.connection.orm
  mode('auto')
  complete = vi.fn<Complete>()
  ledger = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  const cache = new Map<string, { text: string; usage: CompletionResult['usage'] }>()
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
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
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the answers (F-9.18)', () => {
  it('reads a write-up and drops parts that are not text', () => {
    expect(
      parseWriteUpAnswer('{"intro":"Mara is 27.","parts":{"appearance":"A scar.","x":3}}')
    ).toEqual({
      intro: 'Mara is 27.',
      parts: { appearance: 'A scar.' }
    })
    expect(() => parseWriteUpAnswer('not json')).toThrow(/expected format/)
  })

  it('reads a filing and drops malformed entries', () => {
    expect(
      parseRefileAnswer(
        '{"edits":[{"f":"age","old":"27","new":"28"},{"nope":1}],"add":[{"label":"Weapon","value":"A bow."},{"label":2}]}'
      )
    ).toEqual({
      edits: [{ f: 'age', old: '27', new: '28' }],
      adds: [{ label: 'Weapon', value: 'A bow.' }]
    })
  })
})

describe('runSheetSync (F-9.18)', () => {
  it('writes the page up from the fields at Auto, in the style, logged with an Undo', async () => {
    const id = mara()
    expect(sheet(id).sync.state).toBe('pageStale')
    answer({
      intro: 'Mara is twenty-seven.',
      parts: { appearance: 'A scar crosses her left eye.' }
    })
    const result = await runSheetSync(db, deps, { entityId: id })
    expect(result).toMatchObject({ requested: true, outcome: 'applied', logged: true })
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'fast', json: true, maxTokens: 700 })
    expect(request.messages[1]?.content).toContain(
      '[appearance] Appearance: A scar over her left eye.'
    )
    expect(request.messages[1]?.content).toContain('Heading fields: appearance')
    expect(ledger[0]).toMatchObject({ feature: 'sheetSync', promptVersion: 'sheetWriteUp.v1' })
    const after = sheet(id)
    expect(after.body).toBe('Mara is twenty-seven.\n\nAppearance\nA scar crosses her left eye.')
    expect(after.sync).toMatchObject({ state: 'synced', aiParagraphs: 2, paragraphs: 2 })
    expect(after.sync.writtenUpAt).toBe(NOW.toISOString())
    // The Changes log has it, and its Undo puts the empty page back.
    const [entry] = listChanges(db, { limit: 10 }).entries
    expect(entry).toMatchObject({ source: 'sync', kind: 'sheetEdit', undoable: true })
    undoRun(db, entry!.runId)
    expect(sheet(id).body).toBeNull()
  })

  it('sends nothing while the views agree, and answers an identical request from the cache', async () => {
    const id = mara()
    answer({ intro: 'Mara is twenty-seven.', parts: { appearance: 'A scar.' } })
    await runSheetSync(db, deps, { entityId: id })
    expect(await runSheetSync(db, deps, { entityId: id })).toMatchObject({
      requested: false,
      outcome: 'nothing'
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(sheetNeedsSync(db, id)).toBe(false)
    // The same fields again (after an edit and its revert) are answered from the local cache.
    updateEntity(db, id, { fields: { age: '28' } })
    updateEntity(db, id, { fields: { age: '27' } })
    updateEntity(db, id, { body: null })
    expect(sheetNeedsSync(db, id)).toBe(true)
  })

  it('files the page edits into the fields and makes a field of the sheet’s own', async () => {
    const id = mara()
    answer({ intro: 'Mara is twenty-seven.', parts: { appearance: 'A scar over her left eye.' } })
    await runSheetSync(db, deps, { entityId: id })
    updateEntity(db, id, {
      body: 'Mara is twenty-eight.\n\nAppearance\nA scar over her left eye.\n\nShe carries a bone bow.'
    })
    expect(sheet(id).sync.state).toBe('fieldsStale')
    answer({
      edits: [{ f: 'age', old: '27', new: '28' }],
      add: [{ label: 'Weapon', value: 'A bone bow.' }]
    })
    const result = await runSheetSync(db, deps, { entityId: id })
    expect(result.outcome).toBe('applied')
    const user = complete.mock.calls[1]![0].messages[1]?.content ?? ''
    expect(user).toContain('Removed from the page:\n"""\nMara is twenty-seven.\n"""')
    expect(user).toContain(
      'Added to the page:\n"""\nMara is twenty-eight.\n\nShe carries a bone bow.\n"""'
    )
    expect(ledger[1]).toMatchObject({ promptVersion: 'sheetRefile.v1' })
    const after = sheet(id)
    expect(after.fields).toMatchObject({ age: '28', weapon: 'A bone bow.' })
    expect(after.extraFields).toEqual([{ id: 'weapon', label: 'Weapon', multiline: true }])
    // The page is the author's and stays as written; the views agree.
    expect(after.body).toContain('She carries a bone bow.')
    expect(after.sync.state).toBe('synced')
  })

  it('fills an existing Blank page sheet’s fields from its page and keeps the page', async () => {
    const page = 'Kael is a smuggler.\n\nHe owes the harbour guild.'
    const id = createEntity(db, { kind: 'character', name: 'Kael', template: 'blank', body: page })
      .entity.id
    expect(sheet(id).sync.state).toBe('fieldsStale')
    answer({ edits: [{ f: 'background', old: '', new: 'A smuggler who owes the harbour guild.' }] })
    await runSheetSync(db, deps, { entityId: id })
    expect(sheet(id).fields.background).toBe('A smuggler who owes the harbour guild.')
    expect(sheet(id).body).toBe(page)
    expect(sheet(id).sync.state).toBe('synced')
  })

  it('never writes the page over a never-synced sheet that has both texts', async () => {
    const id = createEntity(db, {
      kind: 'character',
      name: 'Ilse',
      fields: { age: '40' },
      body: 'Ilse runs the ferry.'
    }).entity.id
    expect(sheet(id).sync.state).toBe('both')
    answer({ edits: [{ f: 'background', old: '', new: 'Runs the ferry.' }] })
    await runSheetSync(db, deps, { entityId: id })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(sheet(id).body).toBe('Ilse runs the ferry.')
    expect(sheet(id).fields).toMatchObject({ age: '40', background: 'Runs the ferry.' })
  })

  it('files first and then writes up when both views moved since they agreed', async () => {
    const id = mara()
    answer({ intro: 'Mara is twenty-seven.', parts: { appearance: 'A scar.' } })
    await runSheetSync(db, deps, { entityId: id })
    updateEntity(db, id, { fields: { age: '30' } })
    updateEntity(db, id, { body: `${sheet(id).body ?? ''}\n\nShe hates boats.` })
    expect(sheet(id).sync.state).toBe('both')
    answer({ edits: [{ f: 'notes', old: '', new: 'Hates boats.' }] })
    answer({ intro: 'Mara is thirty and hates boats.', parts: { appearance: 'A scar.' } })
    await runSheetSync(db, deps, { entityId: id })
    expect(complete).toHaveBeenCalledTimes(3)
    expect(sheet(id).fields).toMatchObject({ age: '30', notes: 'Hates boats.' })
    expect(sheet(id).body).toContain('Mara is thirty and hates boats.')
    expect(sheet(id).sync.state).toBe('synced')
  })

  it('holds the write-up at Ask until Apply, and Dismiss leaves the sheet out of date', async () => {
    mode('ask')
    const id = mara()
    answer({ intro: 'Mara is twenty-seven.', parts: {} })
    expect((await runSheetSync(db, deps, { entityId: id })).outcome).toBe('held')
    expect(sheet(id).body).toBeNull()
    expect(sheet(id).sync.pending).toMatchObject({
      direction: 'page',
      page: 'Mara is twenty-seven.'
    })
    // A held sync that still matches is not asked for again.
    await runSheetSync(db, deps, { entityId: id })
    expect(complete).toHaveBeenCalledTimes(1)
    dismissHeldSheetSync(db, id)
    expect(sheet(id).sync).toMatchObject({ state: 'pageStale', pending: null })
    answer({ intro: 'Mara is twenty-seven.', parts: {} })
    await runSheetSync(db, deps, { entityId: id })
    const applied = applyHeldSheetSync(db, id, NOW)
    expect(applied.entity.body).toBe('Mara is twenty-seven.')
    expect(applied.entity.sync.state).toBe('synced')
    expect(listChanges(db, { limit: 10 }).entries[0]).toMatchObject({ source: 'sync' })
  })

  it('refuses to apply a held sync once the sheet moved, and drops it', async () => {
    mode('plan')
    const id = mara()
    answer({ intro: 'Mara is twenty-seven.', parts: {} })
    await runSheetSync(db, deps, { entityId: id })
    updateEntity(db, id, { fields: { age: '29' } })
    expect(sheet(id).sync.pending).toBeNull()
    expect(() => applyHeldSheetSync(db, id, NOW)).toThrow(/changed since/)
  })

  it('drops an answer that comes back after the author edited the sheet again', async () => {
    const id = mara()
    complete.mockImplementationOnce(async () => {
      updateEntity(db, id, { fields: { age: '31' } })
      return {
        text: '{"intro":"Old.","parts":{}}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 1, outputTokens: 1 }
      }
    })
    expect((await runSheetSync(db, deps, { entityId: id })).outcome).toBe('dropped')
    expect(sheet(id).body).toBeNull()
  })

  it('never empties the page from empty fields, nor the fields from an emptied page', async () => {
    const id = mara()
    answer({ intro: 'Mara is twenty-seven.', parts: { appearance: 'A scar.' } })
    await runSheetSync(db, deps, { entityId: id })
    updateEntity(db, id, { body: null })
    await runSheetSync(db, deps, { entityId: id })
    expect(sheet(id).fields).toMatchObject({ age: '27' })
    updateEntity(db, id, { body: 'Kept page.', fields: { age: '', appearance: '' } })
    answer({ edits: [] })
    await runSheetSync(db, deps, { entityId: id })
    // The filing was asked; the write-up was not (no field has text), and the page stays.
    expect(complete).toHaveBeenCalledTimes(2)
    expect(sheet(id).body).toBe('Kept page.')
  })

  it('obeys Use AI and its toggle', async () => {
    const id = mara()
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    await expect(runSheetSync(db, deps, { entityId: id })).rejects.toThrow()
    setAiSettings(db, {
      ...defaultAiSettings(),
      dial: 1,
      features: { ...defaultAiSettings().features, sheetSync: false }
    })
    await expect(runSheetSync(db, deps, { entityId: id })).rejects.toThrow()
    expect(complete).not.toHaveBeenCalled()
  })

  it('marks the page out of date when the write-up style changes', async () => {
    const id = mara()
    answer({ intro: 'Mara is twenty-seven.', parts: { appearance: 'A scar.' } })
    await runSheetSync(db, deps, { entityId: id })
    setStoryBibleSettings(db, { writeUp: { character: { length: 'short', roles: {} } } })
    expect(sheet(id).sync.state).toBe('pageStale')
  })
})
