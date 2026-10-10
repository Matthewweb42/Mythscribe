import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { normalizeForMatch } from '@shared/critique'
import type { EditPassSummary } from '@shared/editPass'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { upsertSummary } from '../document/summaryStore'
import {
  getPresets,
  interruptRunningPasses,
  listChanges,
  listPassRows,
  passDetail,
  pendingChangesFor,
  proposalChangeCounts,
  requirePass,
  setPresets,
  settleChanges,
  toSummary
} from '../editPass/editPassStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { createNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { defaultAiUsageState, dayOf } from './dailyCap'
import {
  createEditPassRunner,
  parseEditChanges,
  parseEditNotes,
  type EditPassRunner
} from './editPass'
import { resetInflight } from './inflight'
import { EDIT_PASS_SENTINEL } from './prompts/editPass.v1'
import { getProposal } from './proposalStore'
import type { CompletionRequest, CompletionResult, Provider } from './providers/types'
import { AiRateLimitError } from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 6, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

const SCENE_ONE =
  'The ferry landing was empty when Mara reached it. She walked very slowly to the end of the ' +
  'pier.\n\nThe the rope hung slack in the water.'
const SCENE_TWO = 'Tomas waited by the gate for an hour. He was very, very angry about the delay.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: text
    .split('\n\n')
    .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }))
})

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let one: string
let two: string
let runner: EditPassRunner
let events: EditPassSummary[]

function reply(body: unknown, model = 'gpt-5.4'): CompletionResult {
  return { text: JSON.stringify(body), model, usage: { inputTokens: 900, outputTokens: 120 } }
}

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-editpass-'))
  session = createProject(projectFolderFor(tmp, 'Edits'), 'Edits', 'novel')
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  if (!one) throw new Error('skeleton not seeded')
  const parent = manuscriptDocuments(db)[0]
  const chapter = parent?.parentId ?? ''
  two = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Scene 2'
  }).id
  saveDocument(db, one, doc(SCENE_ONE))
  saveDocument(db, two, doc(SCENE_TWO))
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
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
  events = []
  runner = createEditPassRunner({
    db: () => db,
    requestDeps: () => deps,
    onChange: (summary) => void events.push(summary),
    now: () => NOW.toISOString()
  })
})

afterEach(() => {
  runner.clear()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('parseEditChanges (F-14.15)', () => {
  const scene = normalizeForMatch(SCENE_ONE)
  const parse = (
    changes: unknown[],
    type: 'line' | 'proofread' = 'line',
    taken: { at: number; end: number }[] = []
  ): ReturnType<typeof parseEditChanges> =>
    parseEditChanges(JSON.stringify({ changes }), SCENE_ONE, scene, {
      type,
      keep: new Set(['mara']),
      taken
    })

  it('keeps a change quoted once in the scene and drops what would misfire', () => {
    const { changes, dropped } = parse([
      { quote: 'She walked very slowly', replacement: 'She trudged', why: 'A stronger verb.' },
      { quote: 'Nowhere in the text', replacement: 'x', why: '' },
      { quote: 'the', replacement: 'a', why: 'Occurs many times.' },
      { quote: 'The the rope', replacement: 'The the rope', why: 'No change.' },
      { quote: 'walked very slowly to', replacement: 'went to', why: 'Overlaps the first.' },
      { quote: 'pier.\n\nThe the', replacement: 'pier. The', why: 'Crosses paragraphs.' },
      { nope: true }
    ])
    expect(changes).toEqual([
      {
        original: 'She walked very slowly',
        replacement: 'She trudged',
        rationale: 'A stronger verb.',
        at: scene.indexOf('She walked')
      }
    ])
    expect(dropped).toBe(5)
  })

  it('allows a cut (an empty replacement) and, for a proofread, only small corrections', () => {
    expect(parse([{ quote: 'very slowly ', replacement: '' }]).changes).toHaveLength(1)
    const proofread = parse(
      [
        { quote: 'The the rope', replacement: 'The rope' },
        {
          quote: 'She walked very slowly to the end of the pier.',
          replacement: 'Slowly, at the far end of the long pier, she arrived at last.'
        }
      ],
      'proofread'
    )
    expect(proofread.changes.map((c) => c.replacement)).toEqual(['The rope'])
    expect(proofread.dropped).toBe(1)
  })

  it('refuses an answer that is not the shape asked for', () => {
    expect(() =>
      parseEditChanges('not json', SCENE_ONE, scene, { type: 'line', keep: new Set(), taken: [] })
    ).toThrow(/expected format/)
    expect(() =>
      parseEditChanges('{"fixes":[]}', SCENE_ONE, scene, {
        type: 'line',
        keep: new Set(),
        taken: []
      })
    ).toThrow(/expected format/)
  })
})

describe('parseEditNotes (F-14.15)', () => {
  it('keeps cited notes, reads an unknown category as other, and drops uncited ones', () => {
    const scene = normalizeForMatch(SCENE_ONE)
    const { notes, dropped } = parseEditNotes(
      JSON.stringify({
        notes: [
          { category: 'pacing', quote: 'The the rope hung slack', note: 'The ending lingers.' },
          { category: 'mood', quote: 'The ferry landing was empty', note: 'A quiet opening.' },
          { category: 'pacing', quote: 'Not in the scene', note: 'Uncited.' }
        ]
      }),
      SCENE_ONE,
      scene
    )
    expect(notes.map((n) => [n.category, n.original])).toEqual([
      ['pacing', 'The the rope hung slack'],
      ['other', 'The ferry landing was empty']
    ])
    expect(dropped).toBe(1)
  })
})

describe('the edit pass runner (F-14.15)', () => {
  it('reads each scene in order, writes its changes with one proposal per scene, and finishes', async () => {
    complete
      .mockResolvedValueOnce(
        reply({
          changes: [
            { quote: 'She walked very slowly', replacement: 'She trudged', why: 'Stronger verb.' },
            { quote: 'missing passage', replacement: 'x', why: 'Dropped.' }
          ]
        })
      )
      .mockResolvedValueOnce(
        reply({ changes: [{ quote: 'very, very angry', replacement: 'furious', why: 'Tighter.' }] })
      )
    const started = runner.start({ type: 'line', instruction: null, nodeIds: [one, two] })
    expect(started).toMatchObject({ type: 'line', status: 'running', nodeIds: [one, two] })
    await runner.idle()

    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'strong', json: true, maxTokens: 4_000 })
    expect(request.messages[0]?.content.startsWith(EDIT_PASS_SENTINEL)).toBe(true)
    expect(request.messages[1]?.content).toContain(SCENE_ONE)
    expect(ledger.map((entry) => entry.feature)).toEqual(['editPass', 'editPass'])

    const detail = passDetail(db, started.id)
    expect(detail.pass).toMatchObject({
      status: 'done',
      doneNodeIds: [one, two],
      tokensIn: 1_800,
      tokensOut: 240,
      dropped: 1,
      model: 'gpt-5.4',
      counts: { pending: 2, accepted: 0, rejected: 0, stale: 0 },
      finishedAt: NOW.toISOString()
    })
    expect(detail.pass.costUsd).toBeCloseTo(2 * priceFor('gpt-5.4', 900, 120).costUsd)
    expect(detail.changes.map((c) => [c.nodeId, c.original, c.replacement, c.kind])).toEqual([
      [one, 'She walked very slowly', 'She trudged', 'change'],
      [two, 'very, very angry', 'furious', 'change']
    ])
    const proposal = getProposal(db, detail.changes[0]!.proposalId ?? '')
    expect(proposal).toMatchObject({ feature: 'editPass', nodeId: one, status: 'pending' })
    expect(detail.titles[two]).toBe('Scene 2')
    expect(events.at(-1)?.status).toBe('done')
    expect(pendingChangesFor(db, two)).toHaveLength(1)
  })

  it('asks the fast tier for a proofread and writes notes only for a developmental pass', async () => {
    complete.mockResolvedValue(
      reply({
        notes: [{ category: 'ending', quote: 'The the rope hung slack', note: 'Ends flat.' }]
      })
    )
    const pass = runner.start({ type: 'developmental', instruction: null, nodeIds: [one] })
    await runner.idle()
    expect(complete.mock.calls[0]![0].tier).toBe('strong')
    expect(listChanges(db, { passId: pass.id })).toMatchObject([
      { kind: 'note', replacement: null, category: 'ending', rationale: 'Ends flat.' }
    ])

    complete.mockResolvedValue(reply({ changes: [] }, 'gpt-5.4-mini'))
    runner.start({ type: 'proofread', instruction: null, nodeIds: [one] })
    await runner.idle()
    expect(complete.mock.calls[1]![0].tier).toBe('fast')
  })

  it('sends the instruction of a custom pass', async () => {
    complete.mockResolvedValue(reply({ changes: [] }))
    runner.start({ type: 'custom', instruction: 'Cut every adverb.', nodeIds: [one] })
    await runner.idle()
    expect(complete.mock.calls[0]![0].messages[1]?.content).toContain(
      `The author's instruction:\n"""\nCut every adverb.\n"""`
    )
  })

  it("sends the scene's mood and theme to a line pass but not to a proofread (F-5.6)", async () => {
    upsertSummary(db, {
      nodeId: one,
      summary: 'Mara waits at the ferry.',
      keyPoints: [],
      characters: [],
      contentHash: 'h',
      promptVersion: 'summary.v5',
      model: 'gpt-5.4-mini',
      truncated: false,
      createdAt: NOW.toISOString(),
      card: { where: '', when: '', pov: '', changed: '', mood: 'quiet dread', theme: '' }
    })
    complete.mockResolvedValue(reply({ changes: [] }))
    runner.start({ type: 'line', instruction: null, nodeIds: [one] })
    await runner.idle()
    expect(ledger[0]?.promptVersion).toBe('editPass.v2')
    expect(
      complete.mock.calls[0]![0].messages[1]?.content.startsWith(
        'Scene mood: quiet dread\nKeep the edit in line with it.\n\nScene: '
      )
    ).toBe(true)
    runner.start({ type: 'proofread', instruction: null, nodeIds: [one] })
    await runner.idle()
    expect(complete.mock.calls[1]![0].messages[1]?.content).not.toContain('Scene mood')
  })

  it('refuses to start below Ask, and while another pass runs', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(() => runner.start({ type: 'line', instruction: null, nodeIds: [one] })).toThrow(
      /Edit passes needs Use AI turned on/
    )
    setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
    complete.mockImplementation(() => new Promise(() => undefined))
    runner.start({ type: 'line', instruction: null, nodeIds: [one] })
    expect(() => runner.start({ type: 'line', instruction: null, nodeIds: [two] })).toThrow(
      /already running/
    )
  })

  it('stops on cancel, keeps the finished scenes, and resumes the rest', async () => {
    complete.mockResolvedValueOnce(
      reply({
        changes: [{ quote: 'She walked very slowly', replacement: 'She trudged', why: 'w' }]
      })
    )
    complete.mockImplementationOnce(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const pass = runner.start({ type: 'line', instruction: null, nodeIds: [one, two] })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    runner.cancel(pass.id)
    await runner.idle()
    expect(requirePass(db, pass.id)).toMatchObject({ status: 'cancelled' })
    expect(listChanges(db, { passId: pass.id })).toHaveLength(1)

    complete.mockResolvedValueOnce(
      reply({ changes: [{ quote: 'very, very angry', replacement: 'furious', why: 't' }] })
    )
    runner.resume(pass.id)
    await runner.idle()
    expect(complete).toHaveBeenCalledTimes(3)
    expect(complete.mock.calls[2]![0].messages[1]?.content).toContain(SCENE_TWO)
    expect(toSummary(db, requirePass(db, pass.id))).toMatchObject({
      status: 'done',
      counts: { pending: 2 }
    })
  })

  it('fails with the cause and the next step when the provider refuses for good', async () => {
    complete.mockRejectedValue(new AiRateLimitError('Rate limited.'))
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const pass = runner.start({ type: 'line', instruction: null, nodeIds: [one] })
      await vi.runAllTimersAsync()
      await runner.idle()
      const row = requirePass(db, pass.id)
      expect(row.status).toBe('failed')
      expect(row.error).toMatch(/^Rate limited\./)
      expect(complete).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a pass left running by a crash as stopped, so it can be resumed', () => {
    complete.mockImplementation(() => new Promise(() => undefined))
    const pass = runner.start({ type: 'line', instruction: null, nodeIds: [one] })
    runner.clear()
    expect(requirePass(db, pass.id).status).toBe('running')
    expect(interruptRunningPasses(db)).toBe(1)
    expect(requirePass(db, pass.id)).toMatchObject({
      status: 'cancelled',
      error: 'Stopped when MythScribe closed.'
    })
    expect(listPassRows(db).map((row) => row.id)).toEqual([pass.id])
  })
})

describe('edit pass store (F-14.15)', () => {
  it('settles only pending changes and counts them per proposal', async () => {
    complete.mockResolvedValueOnce(
      reply({
        changes: [
          { quote: 'She walked very slowly', replacement: 'She trudged', why: 'w' },
          { quote: 'The the rope', replacement: 'The rope', why: 'd' }
        ]
      })
    )
    const pass = runner.start({ type: 'line', instruction: null, nodeIds: [one] })
    await runner.idle()
    const [first, second] = listChanges(db, { passId: pass.id })
    expect(settleChanges(db, [first!.id], 'accepted').map((c) => c.status)).toEqual(['accepted'])
    expect(settleChanges(db, [first!.id], 'rejected')).toEqual([])
    settleChanges(db, [second!.id], 'stale')
    expect(proposalChangeCounts(db, first!.proposalId ?? '')).toEqual({
      pending: 0,
      accepted: 1,
      rejected: 0,
      stale: 1
    })
    expect(pendingChangesFor(db, one)).toEqual([])
  })

  it('stores the custom presets and reads a bad row as none', () => {
    expect(getPresets(db)).toEqual([])
    const presets = [{ id: 'p1', name: 'Adverbs', instruction: 'Cut every adverb.' }]
    expect(setPresets(db, presets)).toEqual(presets)
    expect(getPresets(db)).toEqual(presets)
  })
})
