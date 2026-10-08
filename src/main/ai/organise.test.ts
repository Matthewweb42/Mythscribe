import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { ORGANISE_MAX_OPS } from '@shared/organise'
import { aiProposal } from '../db/schema'
import { saveNotes } from '../document/notesStore'
import { createEntity } from '../entity/entityStore'
import { loadOrganiseProject, organiseCandidates } from '../organise/organiseProject'
import { setAiSettings } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { addDocumentTag } from '../tag/documentTagStore'
import { createTag } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import { parseOrganiseAnswer, runOrganise } from './organise'
import { ORGANISE_RETRY_TURN } from './prompts/organise.v1'
import {
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 8, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scene: string
let chapter: string

const reply = (text: string, finishReason = 'stop'): CompletionResult => ({
  text,
  model: 'gpt-5.4',
  usage: { inputTokens: 900, outputTokens: 80 },
  finishReason
})

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-organise-'))
  session = createProject(projectFolderFor(tmp, 'Org'), 'Org', 'novel')
  db = session.connection.orm
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  ledger = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream: async function* () {},
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
  const nodes = listNodes(db)
  scene = nodes.find((node) => node.kind === 'document' && node.parentId !== null)?.id ?? ''
  chapter = nodes.find((node) => node.id === nodes.find((n) => n.id === scene)?.parentId)?.id ?? ''
  createEntity(db, { kind: 'character', name: 'Rynna Falsire', fields: { age: '19' } })
  createEntity(db, { kind: 'character', name: 'High Crown Falsire' })
  createEntity(db, { kind: 'world', name: 'The Weave' })
  const rynna = createTag(db, { name: 'rynna', category: 'custom' })
  addDocumentTag(db, scene, rynna.id)
  createTag(db, { name: 'old-draft', category: 'custom' })
  saveNotes(db, scene, {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rynna has grey eyes.' }] }]
  })
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The refs this run will use, read the way the run reads them. */
function refs(): {
  tag: (name: string) => string
  sheet: (name: string) => string
  node: (id: string) => string
} {
  const project = loadOrganiseProject(db)
  return {
    tag: (name) => project.tagRef.get(project.tags.find((t) => t.name === name)?.id ?? '') ?? '',
    sheet: (name) =>
      project.sheetRef.get(project.sheets.find((s) => s.name === name)?.id ?? '') ?? '',
    node: (id) => project.agent.refOf.get(id) ?? ''
  }
}

const run = (instruction = 'Organise everything.'): ReturnType<typeof runOrganise> =>
  runOrganise(db, deps, { instruction, scope: [], requestId: 'org-1' })

describe('parseOrganiseAnswer (F-9.10)', () => {
  it('keeps the operations that parse, counts the rest, and caps them', () => {
    expect(
      parseOrganiseAnswer(
        '```json\n{"reply":" Done. ","ops":[{"op":"deleteTag","tag":"t1"},{"op":"explode"}]}\n```'
      )
    ).toEqual({ ops: [{ op: 'deleteTag', tag: 't1' }], reply: 'Done.', dropped: 1 })
    const many = Array.from({ length: ORGANISE_MAX_OPS + 2 }, () => ({
      op: 'deleteTag',
      tag: 't1'
    }))
    expect(parseOrganiseAnswer(JSON.stringify({ ops: many }))?.dropped).toBe(2)
    expect(parseOrganiseAnswer('not json')).toBeNull()
  })
})

describe('the local pass (F-9.10)', () => {
  it('finds the look-alike sheets and tags, the unused tag, and the empty sheets', () => {
    const found = organiseCandidates(loadOrganiseProject(db))
    // "Rynna" inside "rynna-falsire"; "High Crown Falsire" is the AI's to judge, not a look-alike.
    expect(found.duplicates.map((d) => [d.of, d.names])).toEqual([
      ['tag', ['rynna', 'rynna-falsire']]
    ])
    expect(found.unusedTags.map((t) => t.name)).toEqual(['old-draft'])
    expect(found.emptySheets.map((s) => s.name)).toEqual(['High Crown Falsire', 'The Weave'])
  })
})

describe('runOrganise (F-9.10)', () => {
  it('lists the project on the strong tier and resolves the plan against it', async () => {
    const r = refs()
    complete.mockResolvedValue(
      reply(
        JSON.stringify({
          reply: 'Merged Rynna.',
          ops: [
            {
              op: 'mergeTags',
              keep: r.tag('rynna-falsire'),
              merge: [r.tag('rynna')],
              why: 'one person'
            },
            {
              op: 'mergeSheets',
              keep: r.sheet('Rynna Falsire'),
              merge: [r.sheet('High Crown Falsire')]
            },
            { op: 'sheet', sheet: r.sheet('Rynna Falsire'), add: { Appearance: 'Grey eyes.' } },
            { op: 'deleteTag', tag: r.tag('old-draft') },
            { op: 'deleteTag', tag: r.tag('rynna') },
            { op: 'category', name: 'Magic Systems Two', fields: ['Cost'] },
            { op: 'sheet', sheet: r.sheet('The Weave'), category: 'Magic Systems Two' },
            { op: 'notes', id: r.node(scene), points: ['Pell hides the ledger.'] },
            { op: 'rename', id: r.node(scene), title: 'The mill' },
            { op: 'delete', id: r.node(chapter) },
            { op: 'sheet', sheet: 's99', name: 'Nobody' }
          ]
        })
      )
    )
    const answer = await run()
    const kinds = answer.plan.changes.map((c) => c.action.kind)
    expect(kinds).toEqual([
      'mergeTags',
      'mergeSheets',
      'sheet',
      'deleteTag',
      'category',
      'sheet',
      'notes',
      'binder'
    ])
    const [mergeTags, , fill, , category, move, notes] = answer.plan.changes
    expect(mergeTags?.reason).toBe('one person')
    expect(fill?.action).toMatchObject({
      kind: 'sheet',
      name: 'Rynna Falsire',
      patch: { fields: { appearance: 'Grey eyes.' } },
      before: { fields: { appearance: '' } }
    })
    expect(category?.action).toMatchObject({
      kind: 'category',
      id: 'c-magic-systems-two',
      fields: ['Cost']
    })
    expect(move?.action).toMatchObject({ kind: 'sheet', patch: { kind: 'c-magic-systems-two' } })
    expect(move?.requires).toEqual([category?.id])
    expect(notes?.action).toMatchObject({
      kind: 'notes',
      nodeId: scene,
      before: 'Rynna has grey eyes.',
      points: ['Pell hides the ledger.']
    })
    // The second deleteTag names a tag merged away above; the chapter has a scene; s99 is no sheet.
    expect(answer.plan.skipped).toHaveLength(3)
    expect(answer.plan.reply).toBe('Merged Rynna.')
    const request = complete.mock.calls[0]![0]
    expect(request.json).toBe(true)
    expect(request.messages[1]?.content).toContain('#rynna-falsire')
    expect(request.messages[2]?.content).toContain('The author asks: Organise everything.')
    expect(request.messages[2]?.content).toContain('Found locally')
    expect(ledger.map((row) => [row.feature, row.tier, row.promptVersion])).toEqual([
      ['organise', 'strong', 'organise.v1']
    ])
    const proposals = db.select().from(aiProposal).all()
    expect(proposals.map((p) => [p.id, p.feature])).toEqual([[answer.proposalId, 'organise']])
  })

  it('asks once more when an answer was cut off, then fails as PROVIDER with no proposal', async () => {
    complete
      .mockResolvedValueOnce(reply('{"reply":"Mer', 'length'))
      .mockResolvedValueOnce(reply('{"reply":"Nothing to do.","ops":[]}'))
    const answer = await run()
    expect(answer.plan.changes).toEqual([])
    const retry = complete.mock.calls[1]![0]
    expect(retry.messages.at(-1)?.content).toBe(ORGANISE_RETRY_TURN)
    expect(retry.maxTokens).toBeGreaterThan(complete.mock.calls[0]![0].maxTokens)

    complete.mockReset()
    complete.mockResolvedValue(reply('I would merge them.'))
    const before = db.select().from(aiProposal).all().length
    await expect(run()).rejects.toMatchObject({ code: 'PROVIDER' })
    expect(db.select().from(aiProposal).all()).toHaveLength(before)
  })

  it('is refused while Organise is switched off, before anything is sent', async () => {
    const settings = defaultAiSettings()
    setAiSettings(db, { ...settings, dial: 1, features: { ...settings.features, organise: false } })
    await expect(run()).rejects.toBeInstanceOf(AiProviderError)
    expect(complete).not.toHaveBeenCalled()
  })

  it('refuses a move that would clash with a name and a sheet field that does not exist', async () => {
    const r = refs()
    complete.mockResolvedValue(
      reply(
        JSON.stringify({
          ops: [
            { op: 'sheet', sheet: r.sheet('Rynna Falsire'), set: { Wingspan: '3 m' } },
            { op: 'newSheet', category: 'character', name: 'Rynna Falsire' },
            {
              op: 'newSheet',
              category: 'history',
              name: 'Ashfall War',
              fields: { When: 'Year 12', Odd: 'x' }
            }
          ]
        })
      )
    )
    const answer = await run()
    expect(answer.plan.changes.map((c) => c.action)).toEqual([
      {
        kind: 'createSheet',
        category: 'history',
        name: 'Ashfall War',
        fields: { when: 'Year 12', notes: 'Odd: x' },
        aliases: []
      }
    ])
    expect(answer.plan.skipped).toHaveLength(2)
  })
})
