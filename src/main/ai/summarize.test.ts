import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { emptySceneMeta } from '@shared/sceneMeta'
import {
  OBSERVED_FACT_QUOTE_MAX,
  OBSERVED_FACT_VALUE_MAX,
  type ObservedFact
} from '@shared/observedFacts'
import {
  SUMMARY_CHARACTER_MAX,
  SUMMARY_CHARACTERS_MAX,
  SUMMARY_FACTS_MAX,
  SUMMARY_KEY_POINT_MAX,
  SUMMARY_KEY_POINTS_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_SCENE_CHAR_BUDGET,
  SUMMARY_TAGS_MAX,
  SUMMARY_TEXT_MIN
} from '@shared/summary'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { getSummary, upsertSummary } from '../document/summaryStore'
import { createEntity, deleteEntity, listEntities } from '../entity/entityStore'
import { listFactsForEntity, setFactHidden } from '../entity/observedFactStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { addDocumentTag, listDocumentTags, removeDocumentTag } from '../tag/documentTagStore'
import { createTag, deleteTag, getTag, listTags } from '../tag/tagStore'
import { node } from '../db/schema'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import {
  AiProviderError,
  AiRateLimitError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AutoTagsChange } from './autoTags'
import type { ObservedFactsChange } from './observedFacts'
import type { AiRequestDeps } from './request'
import {
  parseSummaryAnswer,
  staleSummaryNodeIds,
  summarizeScene,
  summarySource,
  type SummarizeSceneInput
} from './summarize'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 8, 15, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scene: string
let folder: string
let dailyCapUsd: number

/** The scene summarised: comfortably over `SUMMARY_TEXT_MIN`. */
const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
  '"You came alone," a voice said behind her. She did not turn. "You said to."'

const ANSWER = {
  summary: 'Mara waited alone at the ferry landing until Tomas came out of the dark.',
  keyPoints: ['The bell has no clapper', 'Tomas arrives empty-handed'],
  characters: ['Mara', 'Tomas']
}

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** The next answers, as the JSON the prompt asks for. */
function answers(...replies: unknown[]): void {
  for (const reply of replies) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify(reply),
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 600, outputTokens: 90 }
    })
  }
}

const summarize = (over: Partial<SummarizeSceneInput> = {}): ReturnType<typeof summarizeScene> =>
  summarizeScene(db, deps, { nodeId: scene, ...over })

async function failure(
  over: Partial<SummarizeSceneInput> = {}
): Promise<{ code: string; message: string }> {
  try {
    await summarize(over)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

/** The messages of a request, as the provider saw them. */
const sent = (call = 0): { system: string; user: string } => ({
  system: complete.mock.calls[call]?.[0].messages[0]?.content ?? '',
  user: complete.mock.calls[call]?.[0].messages[1]?.content ?? ''
})

/** A front-matter document, to prove only the manuscript is summarised. */
function matterDocument(): string {
  const front = listNodes(db).find((row) => row.sectionType === 'front')
  if (!front) throw new Error('no front section')
  const now = NOW.toISOString()
  db.insert(node)
    .values({
      id: 'matter-1',
      parentId: front.id,
      kind: 'document',
      title: 'Dedication',
      position: 0,
      created: now,
      modified: now
    })
    .run()
  saveDocument(db, 'matter-1', doc(SCENE))
  return 'matter-1'
}

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-summary-'))
  session = createProject(projectFolderFor(tmp, 'Summary'), 'Summary', 'novel')
  db = session.connection.orm
  const rows = listNodes(db)
  scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  if (!scene || !folder) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(SCENE))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answers(ANSWER)
  ledger = []
  dailyCapUsd = defaultAiUsageState().dailyCapUsd
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
      get: () => ({ ...defaultAiUsageState(), dailyCapUsd, spentDate: dayOf(NOW) }),
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

describe('summarizeScene (F-5.6)', () => {
  it('sends the scene as JSON to the fast tier under summary.v3 and stores the row', async () => {
    const result = await summarize()
    expect(result).toEqual({
      summary: {
        ...ANSWER,
        nodeId: scene,
        contentHash: summarySource(db, scene)?.contentHash,
        promptVersion: 'summary.v3',
        model: 'gpt-5.4-mini',
        truncated: false,
        createdAt: NOW.toISOString()
      },
      usage: { inputTokens: 600, outputTokens: 90 },
      costUsd: priceFor('gpt-5.4-mini', 600, 90).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'summary.v3',
      droppedFacts: 0
    })
    expect(getSummary(db, scene)).toEqual(result.summary)
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'fast', json: true, maxTokens: 800 })
    expect(
      sent().system.startsWith('You are the scene-summary feature inside a novel-writing app.')
    ).toBe(true)
    expect(sent().user).toBe(`Scene text:\n"""\n${SCENE}\n"""\n\nSummarize the scene.`)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'summary',
      tier: 'fast',
      promptVersion: 'summary.v3',
      cached: false
    })
  })

  it('refuses with DISABLED below Ask or with the feature off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message:
        'Scene summaries, story bible, and tags needs the AI switch at Ask or Auto (it is at Off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 1, features: { ...on.features, summary: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Scene summaries, story bible, and tags is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('summarises manuscript documents only: a folder, front matter, and an unknown id are VALIDATION', async () => {
    for (const nodeId of [folder, matterDocument(), 'nope']) {
      expect((await failure({ nodeId })).code).toBe('VALIDATION')
      expect(summarySource(db, nodeId)).toBeNull()
    }
    expect(complete).not.toHaveBeenCalled()
  })

  it('drops the stored row when the scene falls back under the minimum, and refuses', async () => {
    await summarize()
    expect(getSummary(db, scene)).not.toBeNull()
    saveDocument(db, scene, doc('x'.repeat(SUMMARY_TEXT_MIN - 1)))
    const short = await failure()
    expect(short.code).toBe('VALIDATION')
    expect(short.message).toContain(`${SUMMARY_TEXT_MIN} characters`)
    expect(getSummary(db, scene)).toBeNull()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('answers an unchanged scene from the stored row without a request at all', async () => {
    const first = await summarize()
    const again = await summarize()
    expect(again).toEqual({
      summary: first.summary,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      cached: true,
      model: 'gpt-5.4-mini',
      promptVersion: 'summary.v3',
      droppedFacts: 0
    })
    expect(complete).toHaveBeenCalledTimes(1)
    // No request, so no ledger row either: nothing was spent and nothing was sent.
    expect(ledger).toHaveLength(1)
  })

  it('runs again when the text, the metadata, or the story-bible names the scene contains change', async () => {
    await summarize()
    saveDocument(db, scene, doc(`${SCENE} The lantern went out.`))
    answers(ANSWER)
    await summarize()
    expect(complete).toHaveBeenCalledTimes(2)
    setSceneMeta(db, scene, { ...emptySceneMeta(), pov: 'Mara' })
    answers(ANSWER)
    await summarize()
    expect(complete).toHaveBeenCalledTimes(3)
    expect(sent(2).system).toContain('Scene: location —, POV Mara, timeline —.')
    // A name the scene does not contain changes nothing it sends: no rerun, no cost.
    createTag(db, { name: 'tomas', category: 'character', color: '#aabbcc' })
    createEntity(db, { kind: 'setting', name: 'North pasture' })
    await summarize()
    expect(complete).toHaveBeenCalledTimes(3)
    createEntity(db, { kind: 'character', name: 'Mara' })
    answers(ANSWER)
    await summarize()
    expect(complete).toHaveBeenCalledTimes(4)
    expect(sent(3).system).toContain('Story-bible names in this scene: characters Mara.')
  })

  it('head-truncates a long scene to the character budget and records it as truncated', async () => {
    saveDocument(db, scene, doc(`${SCENE} `.repeat(400)))
    answers(ANSWER)
    const result = await summarize()
    expect(result.summary.truncated).toBe(true)
    const scenePart = sent().user.split('Scene text:\n"""\n')[1]?.split('\n"""')[0] ?? ''
    expect(scenePart).toHaveLength(SUMMARY_SCENE_CHAR_BUDGET + 1)
  })

  it('sends only the story-bible names the scene contains, never the whole bank', async () => {
    createTag(db, { name: 'mara', category: 'character', color: '#aabbcc' })
    createTag(db, { name: 'ferry-landing', category: 'setting', color: '#aabbcc' })
    createTag(db, { name: 'tomas', category: 'character', color: '#aabbcc' })
    createTag(db, { name: 'lantern', category: 'tone', color: '#aabbcc' })
    await summarize()
    expect(sent().system).toContain(
      'Story-bible names in this scene: characters Mara; settings ferry landing.'
    )
    expect(sent().system).not.toContain('tomas')
    expect(sent().system).not.toContain('lantern,')
  })

  it('lets a budget refusal and a provider error propagate, storing and logging nothing', async () => {
    dailyCapUsd = 0
    expect((await failure()).code).toBe('BUDGET')
    dailyCapUsd = 2
    complete.mockReset()
    complete.mockRejectedValueOnce(new AiRateLimitError('Slow down.'))
    expect((await failure()).code).toBe('RATE_LIMIT')
    expect(ledger).toHaveLength(0)
    expect(getSummary(db, scene)).toBeNull()
  })

  it('reports an answer that is not JSON, or carries no summary, as a PROVIDER failure', async () => {
    complete.mockReset()
    complete.mockResolvedValueOnce({
      text: 'Mara waits at the landing.',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 600, outputTokens: 90 }
    })
    expect((await failure()).code).toBe('PROVIDER')
    answers({ keyPoints: ['no summary line'] })
    expect((await failure()).code).toBe('PROVIDER')
    expect(getSummary(db, scene)).toBeNull()
  })
})

/** Parses an answer object against the fixture scene. */
const parse = (answer: unknown): ReturnType<typeof parseSummaryAnswer> =>
  parseSummaryAnswer(JSON.stringify(answer), SCENE)

/** A fact the fixture scene grounds. */
const FACT = {
  entity: 'Mara',
  kind: 'character',
  attribute: 'appearance',
  value: 'Carries a lantern',
  quote: 'She set the lantern down on the post'
}

describe('parseSummaryAnswer (F-5.6)', () => {
  it('trims the summary and cuts it to the stored cap', () => {
    const long = 's'.repeat(SUMMARY_MAX_CHARS + 50)
    expect(parse({ ...ANSWER, summary: `  ${long}  ` }).summary.summary).toBe(
      's'.repeat(SUMMARY_MAX_CHARS)
    )
  })

  it('refuses an answer with no usable summary, whatever else it carries', () => {
    for (const summary of ['', '   ', 7, null, undefined]) {
      expect(() => parse({ ...ANSWER, summary })).toThrow()
    }
    expect(() => parseSummaryAnswer('not json', SCENE)).toThrow()
    expect(() => parse(['a', 'b'])).toThrow()
  })

  it('drops non-strings, blanks, and case-insensitive duplicates from the two lists', () => {
    const parsed = parse({
      ...ANSWER,
      keyPoints: ['  The bell has no clapper  ', 7, '', 'the bell has no clapper', null],
      characters: ['Mara', 'mara', { name: 'Tomas' }, 'Tomas']
    }).summary
    expect(parsed.keyPoints).toEqual(['The bell has no clapper'])
    expect(parsed.characters).toEqual(['Mara', 'Tomas'])
  })

  it('caps each entry and how many of them are kept', () => {
    const parsed = parse({
      ...ANSWER,
      keyPoints: Array.from(
        { length: SUMMARY_KEY_POINTS_MAX + 3 },
        (_, i) => `${i} ${'k'.repeat(SUMMARY_KEY_POINT_MAX + 20)}`
      ),
      characters: Array.from(
        { length: SUMMARY_CHARACTERS_MAX + 3 },
        (_, i) => `${i} ${'c'.repeat(SUMMARY_CHARACTER_MAX + 20)}`
      )
    }).summary
    expect(parsed.keyPoints).toHaveLength(SUMMARY_KEY_POINTS_MAX)
    expect(parsed.characters).toHaveLength(SUMMARY_CHARACTERS_MAX)
    expect(parsed.keyPoints[0]).toHaveLength(SUMMARY_KEY_POINT_MAX)
    expect(parsed.characters[0]).toHaveLength(SUMMARY_CHARACTER_MAX)
  })

  it('reads a missing list as none, and ignores anything the prompt did not ask for', () => {
    expect(parse({ summary: 'Mara waits.', extra: 1 })).toEqual({
      summary: { summary: 'Mara waits.', keyPoints: [], characters: [] },
      facts: [],
      droppedFacts: 0,
      tags: []
    })
  })
})

describe('parseSummaryAnswer facts (F-5.16)', () => {
  it('keeps a well-formed fact whose quote is in the scene, trimmed, with kind and attribute lower-cased', () => {
    expect(
      parse({
        ...ANSWER,
        facts: [
          {
            entity: '  Mara ',
            kind: 'Character',
            attribute: ' Appearance ',
            value: '  Carries a lantern ',
            quote: '  She set the lantern down on the post  '
          }
        ]
      })
    ).toMatchObject({
      facts: [
        {
          entity: 'Mara',
          kind: 'character',
          attribute: 'appearance',
          value: 'Carries a lantern',
          quote: 'She set the lantern down on the post'
        }
      ],
      droppedFacts: 0
    })
  })

  it('finds a quote across curly quotes and line breaks, as every other citation is matched', () => {
    const { facts } = parse({
      ...ANSWER,
      facts: [{ ...FACT, quote: '“You came alone,”\n a voice said' }]
    })
    expect(facts).toHaveLength(1)
  })

  it('drops and counts a fact with no passage, a bad shape, a blank field, an unknown kind, or an attribute outside its kind', () => {
    const parsed = parse({
      ...ANSWER,
      facts: [
        { ...FACT, quote: 'The lighthouse blinked twice.' },
        { ...FACT, quote: '   ' },
        { ...FACT, value: '' },
        { ...FACT, entity: ' ' },
        { ...FACT, kind: 'animal' },
        // `type` is a setting's attribute, not a character's; `notes` is the author's own field.
        { ...FACT, attribute: 'type' },
        { ...FACT, attribute: 'notes' },
        { ...FACT, value: 7 },
        'Mara is nineteen',
        null,
        { ...FACT, entity: 'n'.repeat(201) },
        FACT
      ]
    })
    expect(parsed.facts).toEqual([FACT])
    expect(parsed.droppedFacts).toBe(11)
  })

  it('reads facts that are missing or not a list as none, without failing the summary', () => {
    expect(parse(ANSWER)).toMatchObject({ facts: [], droppedFacts: 0 })
    expect(parse({ ...ANSWER, facts: 'none' })).toMatchObject({ facts: [], droppedFacts: 0 })
    expect(parse({ ...ANSWER, facts: { entity: 'Mara' } }).summary.summary).toBe(ANSWER.summary)
  })

  it('cuts the value and the quote to their caps; the cut quote is still a passage of the scene', () => {
    const long = `${SCENE} `.repeat(3)
    const { facts } = parseSummaryAnswer(
      JSON.stringify({
        ...ANSWER,
        facts: [{ ...FACT, value: 'v'.repeat(OBSERVED_FACT_VALUE_MAX + 40), quote: long }]
      }),
      long
    )
    expect(facts[0]?.value).toHaveLength(OBSERVED_FACT_VALUE_MAX)
    expect(facts[0]?.quote.length).toBeLessThanOrEqual(OBSERVED_FACT_QUOTE_MAX)
    expect(long.startsWith(facts[0]?.quote ?? '?')).toBe(true)
  })

  it('keeps a statement given twice once, uncounted, and caps the list', () => {
    const twice = parse({
      ...ANSWER,
      facts: [FACT, { ...FACT, entity: 'mara', value: 'Carries a lantern.' }]
    })
    expect(twice.facts).toEqual([FACT])
    expect(twice.droppedFacts).toBe(0)
    const many = parse({
      ...ANSWER,
      facts: Array.from({ length: SUMMARY_FACTS_MAX + 3 }, (_, i) => ({ ...FACT, value: `v${i}` }))
    })
    expect(many.facts).toHaveLength(SUMMARY_FACTS_MAX)
    expect(many.droppedFacts).toBe(0)
  })
})

describe('summarizeScene logs the story bible (F-5.16)', () => {
  const TOMAS = {
    entity: 'Tomas',
    kind: 'character',
    attribute: 'personality',
    value: 'Speaks from behind',
    quote: 'a voice said behind her'
  }
  let changes: ObservedFactsChange[]
  const run = (): ReturnType<typeof summarizeScene> =>
    summarize({ onFactsChanged: (change) => void changes.push(change) })
  const factsOf = (name: string): ObservedFact[] => {
    const entity = listEntities(db).find((candidate) => candidate.name === name)
    return entity === undefined ? [] : listFactsForEntity(db, entity.id)
  }

  beforeEach(() => {
    changes = []
    complete.mockReset()
  })

  it('stores the grounded facts with the summary, creating the missing entity, in one request', async () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    answers({ ...ANSWER, facts: [FACT, TOMAS, { ...FACT, quote: 'Never written.' }] })
    const result = await run()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(ledger).toHaveLength(1)
    expect(result.droppedFacts).toBe(1)
    expect(factsOf('Mara')).toMatchObject([
      { entityId: mara.id, nodeId: scene, attribute: 'appearance', value: 'Carries a lantern' }
    ])
    expect(factsOf('Tomas')).toMatchObject([{ attribute: 'personality', hidden: false }])
    const tomas = listEntities(db).find((entity) => entity.name === 'Tomas')
    expect(tomas).toMatchObject({ origin: 'ai', template: 'blank' })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.created.map((write) => write.entity.id)).toEqual([tomas?.id])
    expect(changes[0]?.entityIds).toEqual([mara.id, tomas?.id].sort())
    // Nothing of it is in the stored summary row or the manuscript: facts live in their own table.
    expect(getSummary(db, scene)).toEqual(result.summary)
    expect(result.summary).not.toHaveProperty('facts')
  })

  it('leaves the scene current after creating an entity from it: the run does not mark itself out of date', async () => {
    // "Mara" is a name the scene contains, so creating her changes what the scene would send.
    answers({ ...ANSWER, facts: [FACT] })
    const result = await run()
    expect(listEntities(db).map((entity) => entity.name)).toEqual(['Mara'])
    expect(result.summary.contentHash).toBe(summarySource(db, scene)?.contentHash)
    expect(staleSummaryNodeIds(db)).toEqual([])
    expect((await run()).cached).toBe(true)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('still reads as out of date when the author added a name the scene contains while the request was out', async () => {
    // The request lists no known name. While it is in flight the author makes a setting the
    // scene names; the answer then creates Mara. Stamping the row with the names "as they stand
    // now" would cover the author's entity too, which the model was never told about.
    complete.mockImplementationOnce(() => {
      createEntity(db, { kind: 'setting', name: 'Ferry Landing' })
      return Promise.resolve({
        text: JSON.stringify({ ...ANSWER, facts: [FACT] }),
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 600, outputTokens: 90 }
      })
    })
    await run()
    expect(sent().system).not.toContain('Ferry Landing')
    expect(listEntities(db).map((entity) => entity.name)).toEqual(['Mara', 'Ferry Landing'])
    expect(staleSummaryNodeIds(db)).toEqual([scene])
  })

  it('reads every stored summary.v1 row as stale', async () => {
    answers(ANSWER)
    await run()
    const stored = getSummary(db, scene)
    if (!stored) throw new Error('no stored summary')
    upsertSummary(db, { ...stored, promptVersion: 'summary.v1' })
    expect(staleSummaryNodeIds(db)).toEqual([scene])
    // The rerun rewrites the row under the current version (from the local response cache here:
    // the scene itself has not changed, so the same request is not paid for twice).
    await run()
    expect(getSummary(db, scene)?.promptVersion).toBe('summary.v3')
    expect(staleSummaryNodeIds(db)).toEqual([])
  })

  it('does not bring back a fact the author hid, nor an entity the author deleted', async () => {
    answers({ ...ANSWER, facts: [FACT, TOMAS] })
    await run()
    setFactHidden(db, factsOf('Mara')[0]?.id ?? '', true)
    deleteEntity(db, listEntities(db).find((entity) => entity.name === 'Tomas')?.id ?? '')
    saveDocument(db, scene, doc(`${SCENE} The lantern went out.`))
    answers({ ...ANSWER, facts: [FACT, TOMAS] })
    const result = await run()
    expect(factsOf('Mara')).toMatchObject([{ hidden: true }])
    expect(listEntities(db).map((entity) => entity.name)).toEqual(['Mara'])
    expect(result.droppedFacts).toBe(1)
  })

  it("clears the scene's facts with its summary when it falls under the minimum, and says so", async () => {
    answers({ ...ANSWER, facts: [FACT] })
    await run()
    const mara = listEntities(db)[0]
    saveDocument(db, scene, doc('x'.repeat(SUMMARY_TEXT_MIN - 1)))
    changes = []
    expect((await failure({ onFactsChanged: (change) => void changes.push(change) })).code).toBe(
      'VALIDATION'
    )
    expect(factsOf('Mara')).toEqual([])
    expect(changes).toEqual([{ entityIds: [mara?.id], created: [], skipped: 0 }])
    // The entity itself stays: only the author removes an entity.
    expect(listEntities(db)).toHaveLength(1)
  })

  it('stores nothing and tells no one when the answer is unusable', async () => {
    answers({ facts: [FACT] })
    expect((await failure({ onFactsChanged: (change) => void changes.push(change) })).code).toBe(
      'PROVIDER'
    )
    expect(listEntities(db)).toEqual([])
    expect(changes).toEqual([])
  })

  it('does not call back for a run that changed no fact', async () => {
    answers(ANSWER)
    await run()
    await run()
    expect(changes).toEqual([])
  })
})

describe('staleSummaryNodeIds (F-5.13)', () => {
  /** A second manuscript scene right after the seeded one, with the text it is given. */
  function secondScene(text: string): string {
    const now = NOW.toISOString()
    const first = listNodes(db).find((row) => row.id === scene)
    if (!first) throw new Error('no seeded scene')
    db.insert(node)
      .values({
        id: 'scene-2',
        parentId: first.parentId,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: 'Scene 2',
        position: first.position + 1,
        created: now,
        modified: now
      })
      .run()
    saveDocument(db, 'scene-2', doc(text))
    return 'scene-2'
  }

  it('lists a scene with no summary and skips the ones too short to have one', () => {
    const second = secondScene('Too short to summarise.')
    expect(staleSummaryNodeIds(db)).toEqual([scene])
    expect(second).toBe('scene-2')
  })

  it('skips a scene whose stored summary is still current, and the front matter', async () => {
    // A front-matter document is long enough but is not in the manuscript: never summarised.
    matterDocument()
    await summarize()
    expect(staleSummaryNodeIds(db)).toEqual([])
  })

  it('lists a scene again once its text has changed', async () => {
    await summarize()
    expect(staleSummaryNodeIds(db)).toEqual([])
    saveDocument(db, scene, doc(`${SCENE} She left the lantern burning on the post.`))
    expect(staleSummaryNodeIds(db)).toEqual([scene])
  })

  it('lists a scene whose summary came from an older prompt version', async () => {
    await summarize()
    const stored = getSummary(db, scene)
    if (!stored) throw new Error('no stored summary')
    upsertSummary(db, { ...stored, promptVersion: 'summary.v0' })
    expect(staleSummaryNodeIds(db)).toEqual([scene])
  })

  it('answers in reading order', () => {
    secondScene(SCENE)
    expect(staleSummaryNodeIds(db)).toEqual([scene, 'scene-2'])
  })
})

describe('summarizeScene tags the scene (F-4.13)', () => {
  let changes: AutoTagsChange[]
  const run = (): ReturnType<typeof summarizeScene> =>
    summarize({ onTagsChanged: (change) => void changes.push(change) })
  const links = (): Record<string, string> =>
    Object.fromEntries(listDocumentTags(db, scene).map((tag) => [tag.name, tag.source]))
  /** Saves the scene with one more sentence, so the next run asks again. */
  let edits = 0
  const edit = (): void => {
    edits += 1
    saveDocument(db, scene, doc(`${SCENE} ${'She waited. '.repeat(edits)}`))
  }

  beforeEach(() => {
    changes = []
    edits = 0
    complete.mockReset()
  })

  it('lists the bank’s tone, content, plot-thread, and custom names, most used first, outside the hash', async () => {
    const dread = createTag(db, { name: 'Dread', category: 'tone' })
    createTag(db, { name: 'Calm', category: 'tone' })
    createTag(db, { name: 'The Debt', category: 'plotThread' })
    createTag(db, { name: 'Oslo', category: 'setting' })
    addDocumentTag(db, folder, dread.id)
    const before = summarySource(db, scene)?.contentHash
    answers(ANSWER)
    await run()
    expect(sent().system).toContain('\n\nTag bank: tone dread, calm; plotThread the-debt.')
    expect(sent().system).not.toContain('oslo')
    // A new tone tag changes what the next request lists, but marks no scene out of date.
    createTag(db, { name: 'Hope', category: 'tone' })
    expect(summarySource(db, scene)?.contentHash).toBe(before)
    expect(staleSummaryNodeIds(db)).toEqual([])
  })

  it('links bank tags and creates the missing ones as AI-made, in the same single request', async () => {
    const dread = createTag(db, { name: 'Dread', category: 'tone' })
    answers({
      ...ANSWER,
      tags: [
        { name: 'dread', category: 'custom' },
        { name: 'Waiting', category: 'custom' },
        { name: 'Mara', category: 'character' },
        { name: 'Ferry Landing', category: 'setting' }
      ]
    })
    await run()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(ledger).toHaveLength(1)
    expect(links()).toEqual({ dread: 'ai', waiting: 'ai', mara: 'ai', 'ferry-landing': 'ai' })
    // The bank's category wins for a known name; a new one takes the answered category.
    expect(getTag(db, dread.id)).toMatchObject({ category: 'tone', origin: 'author' })
    const made = listTags(db).filter((tag) => tag.id !== dread.id)
    expect(made.map((tag) => [tag.name, tag.category])).toEqual([
      ['ferry-landing', 'setting'],
      ['mara', 'character'],
      ['waiting', 'custom']
    ])
    for (const tag of made) expect(getTag(db, tag.id)?.origin).toBe('ai')
    expect(changes).toHaveLength(1)
    expect(changes[0]?.created.map((tag) => tag.name).sort()).toEqual([
      'ferry-landing',
      'mara',
      'waiting'
    ])
    expect(changes[0]?.moved).toHaveLength(4)
    expect(changes[0]?.moved.every((tag) => tag.usageCount === 1)).toBe(true)
    // Nothing of it is in the summary row.
    expect(getSummary(db, scene)).not.toHaveProperty('tags')
  })

  it('leaves the scene current after creating a name tag from it', async () => {
    answers({ ...ANSWER, tags: [{ name: 'Mara', category: 'character' }] })
    const result = await run()
    expect(result.summary.contentHash).toBe(summarySource(db, scene)?.contentHash)
    expect(staleSummaryNodeIds(db)).toEqual([])
    expect((await run()).cached).toBe(true)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('creates no name the scene does not hold, no common-noun character, no content tag, and at most three', async () => {
    answers({
      ...ANSWER,
      tags: [
        { name: 'Zephyr', category: 'character' },
        { name: 'lantern', category: 'character' },
        { name: 'lantern', category: 'worldBuilding' },
        { name: 'dialogue', category: 'content' },
        { name: 'loneliness', category: 'custom' },
        { name: 'patience', category: 'custom' },
        { name: 'duty', category: 'custom' }
      ]
    })
    await run()
    // "lantern" is deduped by name on the way in, so its first (character) entry decides.
    expect(Object.keys(links()).sort()).toEqual(['duty', 'loneliness', 'patience'])
    answers({
      ...ANSWER,
      tags: ['a', 'b', 'c', 'd'].map((name) => ({ name: `theme ${name}`, category: 'custom' }))
    })
    edit()
    await run()
    expect(Object.keys(links()).sort()).toEqual(['theme-a', 'theme-b', 'theme-c'])
  })

  it('replaces its own links on the next run and never touches the author’s', async () => {
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    createTag(db, { name: 'Dread', category: 'tone' })
    createTag(db, { name: 'Hope', category: 'tone' })
    addDocumentTag(db, scene, rain.id)
    answers({ ...ANSWER, tags: [{ name: 'dread', category: 'tone' }] })
    await run()
    expect(links()).toEqual({ rain: 'author', dread: 'ai' })
    answers({ ...ANSWER, tags: [{ name: 'hope', category: 'tone' }] })
    edit()
    await run()
    expect(links()).toEqual({ rain: 'author', hope: 'ai' })
    expect(changes[1]?.moved.map((tag) => [tag.name, tag.usageCount]).sort()).toEqual([
      ['dread', 0],
      ['hope', 1]
    ])
  })

  it('never re-applies a tag the author removed from the scene, nor recreates one the author deleted', async () => {
    answers({
      ...ANSWER,
      tags: [
        { name: 'dread', category: 'tone' },
        { name: 'waiting', category: 'custom' }
      ]
    })
    await run()
    const dread = listTags(db).find((tag) => tag.name === 'dread')
    const waiting = listTags(db).find((tag) => tag.name === 'waiting')
    if (!dread || !waiting) throw new Error('tags not created')
    removeDocumentTag(db, scene, dread.id)
    deleteTag(db, waiting.id)
    answers({
      ...ANSWER,
      tags: [
        { name: 'dread', category: 'tone' },
        { name: 'waiting', category: 'custom' }
      ]
    })
    edit()
    await run()
    expect(links()).toEqual({})
    expect(listTags(db).map((tag) => tag.name)).toEqual(['dread'])
    // The second run moved nothing, so the windows are not told.
    expect(changes).toHaveLength(1)
  })

  it('clears its links, not the author’s, when the scene is cut back under the minimum', async () => {
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    addDocumentTag(db, scene, rain.id)
    answers({ ...ANSWER, tags: [{ name: 'dread', category: 'tone' }] })
    await run()
    saveDocument(db, scene, doc('Too short.'))
    await expect(run()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(links()).toEqual({ rain: 'author' })
    expect(changes[1]?.moved.map((tag) => tag.name)).toEqual(['dread'])
    expect(changes[1]?.created).toEqual([])
  })

  it('reads a malformed tag list leniently and caps it', () => {
    const parsed = parseSummaryAnswer(
      JSON.stringify({
        ...ANSWER,
        tags: [
          { name: ' Dread ', category: 'tone' },
          { name: 'dread', category: 'custom' },
          { name: 'x', category: 'mood' },
          { name: '!!!', category: 'tone' },
          { name: 'n'.repeat(61), category: 'tone' },
          'dread',
          { name: 7, category: 'tone' },
          ...Array.from({ length: 10 }, (_, i) => ({ name: `tag ${i}`, category: 'custom' }))
        ]
      }),
      SCENE
    )
    expect(parsed.tags[0]).toEqual({ name: 'Dread', category: 'tone' })
    expect(parsed.tags).toHaveLength(SUMMARY_TAGS_MAX)
    expect(parsed.tags.map((tag) => tag.name)).not.toContain('x')
    expect(parseSummaryAnswer(JSON.stringify({ ...ANSWER, tags: 'dread' }), SCENE).tags).toEqual([])
  })
})
