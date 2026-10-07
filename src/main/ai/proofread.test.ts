import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { defaultProjectDictionary } from '@shared/dictionary'
import {
  PROOFREAD_CHAR_BUDGET,
  PROOFREAD_KEEP_WORDS_MAX,
  PROOFREAD_MAX_FIXES,
  PROOFREAD_TEXT_MIN
} from '@shared/proofread'
import { EMPTY_SCENE_BRIEF, emptySceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { createEntity } from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings, setAuthorRules, setProjectDictionary } from '../project/settingsStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import { parseProofreadAnswer, runProofread, type ProofreadInput } from './proofread'
import {
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 3, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scene: string
let folder: string

/** A misspelled name, a doubled word, a typo, and an invented word the dictionary keeps. */
const SCENE =
  'The ferry landing was empty when Marra reached it. The the rope hung slack in the water and ' +
  'teh bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
  'Kethra smoke drifted over the water.'

const NAME = { kind: 'name', quote: 'when Marra reached', fix: 'when Mara reached' }
const DOUBLED = { kind: 'doubledWord', quote: 'The the rope', fix: 'The rope' }
const TYPO = { kind: 'typo', quote: 'and teh bell', fix: 'and the bell' }

/** Nouns only, over the minimum: no tense, no person, too few words for a rule. */
const NEUTRAL =
  'Rope, lantern, bell, water, post, ferry, landing, clapper, plank, rail, fog, oar, rope, ' +
  'lantern, bell, water, post, ferry, landing, clapper, plank, rail, fog, oar, rope, lantern, ' +
  'bell, water, post, ferry, teh oar.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** The next answer, as the JSON the prompt asks for. */
function answers(...sets: unknown[][]): void {
  for (const fixes of sets) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify({ fixes }),
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 700, outputTokens: 90 }
    })
  }
}

const proofread = (over: Partial<ProofreadInput> = {}): ReturnType<typeof runProofread> =>
  runProofread(db, deps, { nodeId: scene, ...over })

async function failure(
  over: Partial<ProofreadInput> = {}
): Promise<{ code: string; message: string }> {
  try {
    await proofread(over)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

const sent = (call = 0): { system: string; user: string } => ({
  system: complete.mock.calls[call]?.[0].messages[0]?.content ?? '',
  user: complete.mock.calls[call]?.[0].messages[1]?.content ?? ''
})

/** The text between the `Text to proofread` fences of a request. */
const sentText = (call = 0): string =>
  sent(call).user.split('Text to proofread:\n"""\n')[1]?.split('\n"""')[0] ?? ''

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-proofread-'))
  session = createProject(projectFolderFor(tmp, 'Proofread'), 'Proofread', 'novel')
  db = session.connection.orm
  scene = manuscriptDocuments(db)[0]?.id ?? ''
  folder = listNodes(db).find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  if (!scene || !folder) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(SCENE))
  createEntity(db, { kind: 'character', name: 'Mara', fields: {} })
  setProjectDictionary(db, { ...defaultProjectDictionary(), words: ['Kethra'] })
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answers([NAME])
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

describe('runProofread (F-14.12)', () => {
  it('sends the scene as JSON to the fast tier under proofread.v1 and answers the kept fixes', async () => {
    const result = await proofread()
    expect(result).toEqual({
      fixes: [{ ...NAME, flagged: false, violation: null }],
      scope: 'scene',
      truncated: false,
      dropped: 0,
      usage: { inputTokens: 700, outputTokens: 90 },
      costUsd: priceFor('gpt-5.4-mini', 700, 90).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'proofread.v1'
    })
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'fast', json: true, maxTokens: 2_000 })
    expect('temperature' in request).toBe(false)
    expect(sentText()).toBe(SCENE)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'proofread',
      tier: 'fast',
      promptVersion: 'proofread.v1'
    })
  })

  it('refuses with DISABLED below Ask or with the feature off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Proofread needs the AI switch at Ask or Auto (it is at Off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 1, features: { ...on.features, proofread: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Proofread is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('refuses an unknown node with NOT_FOUND, a folder with VALIDATION, and short text with VALIDATION', async () => {
    expect((await failure({ nodeId: 'nope' })).code).toBe('NOT_FOUND')
    expect((await failure({ nodeId: folder })).code).toBe('VALIDATION')
    const selection = await failure({ selection: 'Too short.' })
    expect(selection.code).toBe('VALIDATION')
    expect(selection.message).toContain(`Select at least ${PROOFREAD_TEXT_MIN} characters`)
    saveDocument(db, scene, doc('x'.repeat(PROOFREAD_TEXT_MIN - 1)))
    const short = await failure()
    expect(short.code).toBe('VALIDATION')
    expect(short.message).toContain(`${PROOFREAD_TEXT_MIN} characters in this scene`)
    expect(complete).not.toHaveBeenCalled()
  })

  it('proofreads only the selection when one is sent, and a blank one means the scene', async () => {
    complete.mockReset()
    answers([NAME, TYPO])
    const selection = '  The the rope hung slack in the water and teh bell  '
    const result = await proofread({ selection })
    expect(result.scope).toBe('selection')
    expect(sentText()).toBe(selection.trim())
    // The name fix quotes the scene, but not the text that was sent.
    expect(result.fixes.map((fix) => fix.quote)).toEqual([TYPO.quote])
    expect(result.dropped).toBe(1)
    answers([NAME])
    expect((await proofread({ selection: '   ' })).scope).toBe('scene')
    expect(sentText(1)).toBe(SCENE)
  })

  it('head-truncates a long scene to the character budget and reports it as truncated', async () => {
    const long = `${SCENE} `.repeat(150)
    saveDocument(db, scene, doc(long))
    const result = await proofread()
    expect(result.truncated).toBe(true)
    expect(sentText()).toBe(`${long.trim().slice(0, PROOFREAD_CHAR_BUDGET)}…`)
    // Every passage now occurs many times in the saved scene: nothing can be located once.
    expect(result.fixes).toEqual([])
    expect(result.dropped).toBe(1)
  })

  it('sends the story names and dictionary words as the keep list, names first, capped', async () => {
    await proofread()
    expect(sent().system).toContain('\n\nKeep as written: Mara, Kethra.')
    const words = Array.from({ length: PROOFREAD_KEEP_WORDS_MAX + 20 }, (_, i) => `word${i}`)
    setProjectDictionary(db, { ...defaultProjectDictionary(), words })
    answers([NAME])
    await proofread()
    const line = sent(1).system.split('Keep as written: ')[1] ?? ''
    const listed = line.slice(0, -1).split(', ')
    expect(listed).toHaveLength(PROOFREAD_KEEP_WORDS_MAX)
    expect(listed[0]).toBe('Mara')
  })

  it('carries the scene brief as context and the voice block in the system turn', async () => {
    setSceneMeta(db, scene, {
      ...emptySceneMeta(),
      brief: { ...EMPTY_SCENE_BRIEF, goal: 'Mara wants the ledger back.' }
    })
    await proofread()
    expect(sent().user).toContain(
      'Scene brief (context only, not to proofread):\n"""\nScene brief:\n- Goal: Mara wants the ledger back.'
    )
    expect(
      sent().system.startsWith('You are the proofreading feature inside a novel-writing app.')
    ).toBe(true)
    // A fresh project's block is the seeded author rules (banned phrases) alone.
    expect(sent().system).toContain('Never use these phrases: ')
  })

  it('answers the same request from the cache, and misses it when the text, the scope, the keep list, or the voice version change', async () => {
    await proofread()
    await proofread()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(ledger[1]?.cached).toBe(true)
    answers([NAME])
    await proofread({ selection: SCENE })
    expect(complete).toHaveBeenCalledTimes(2)
    createEntity(db, { kind: 'character', name: 'Tomas', fields: {} })
    answers([NAME])
    await proofread()
    expect(complete).toHaveBeenCalledTimes(3)
    bumpVoiceVersion()
    answers([NAME])
    await proofread()
    expect(complete).toHaveBeenCalledTimes(4)
  })

  it('answers PROVIDER when the model does not reply in the expected shape', async () => {
    complete.mockReset()
    complete.mockResolvedValueOnce({
      text: 'All clean!',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 700, outputTokens: 3 }
    })
    expect((await failure()).code).toBe('PROVIDER')
    complete.mockResolvedValueOnce({
      text: '{"notes":[]}',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 700, outputTokens: 3 }
    })
    expect((await failure({ selection: SCENE })).code).toBe('PROVIDER')
  })

  it('flags a fix that uses a banned phrase (F-14.7) when a voice block went out', async () => {
    saveDocument(db, scene, doc(NEUTRAL))
    setAuthorRules(db, { rules: '', bannedPhrases: ['delve'] })
    bumpVoiceVersion()
    complete.mockReset()
    answers([{ kind: 'typo', quote: 'teh oar', fix: 'delve oar' }])
    const result = await proofread()
    expect(result.fixes[0]).toMatchObject({ flagged: true })
    expect(result.fixes[0]?.violation).toContain('delve')
  })
})

describe('parseProofreadAnswer (F-14.12)', () => {
  const parse = (fixes: unknown[], sent = SCENE): ReturnType<typeof parseProofreadAnswer> =>
    parseProofreadAnswer(JSON.stringify({ fixes }), sent, SCENE, ['Mara', 'Kethra'])

  it('keeps small corrections in document order, trimmed', () => {
    expect(parse([TYPO, { ...NAME, quote: `  ${NAME.quote} ` }, DOUBLED])).toEqual({
      fixes: [NAME, DOUBLED, TYPO],
      dropped: 0
    })
  })

  it('skips an unknown kind and a blank quote or fix without counting them', () => {
    expect(
      parse([
        { ...TYPO, kind: 'style' },
        { ...TYPO, quote: '  ' },
        { ...TYPO, fix: '' },
        { quote: TYPO.quote }
      ])
    ).toEqual({ fixes: [], dropped: 0 })
  })

  it('drops and counts a fix equal to its quote, a quote not in the text sent, and a quote not once in the scene', () => {
    const result = parse([
      { kind: 'grammar', quote: 'on the post', fix: 'on  the post' },
      { kind: 'spelling', quote: 'The dragon circled', fix: 'The dragon circles' },
      { kind: 'grammar', quote: 'the water', fix: 'the waters' },
      TYPO
    ])
    expect(result).toEqual({ fixes: [TYPO], dropped: 3 })
  })

  it('drops a change larger than a correction', () => {
    const result = parse([
      {
        kind: 'grammar',
        quote: 'She set the lantern down on the post and waited.',
        fix: 'She placed her lantern carefully upon the old wooden post, then waited.'
      }
    ])
    expect(result).toEqual({ fixes: [], dropped: 1 })
  })

  it('drops a "correction" of a keep word, but keeps a doubled name removed or a name capitalized', () => {
    expect(parse([{ kind: 'spelling', quote: 'Kethra smoke', fix: 'Kettle smoke' }])).toEqual({
      fixes: [],
      dropped: 1
    })
    const scene = 'Mara Mara reached the ferry, and mara waited by the post.'
    const doubled = { kind: 'doubledWord', quote: 'Mara Mara reached', fix: 'Mara reached' }
    const capital = { kind: 'name', quote: 'and mara waited', fix: 'and Mara waited' }
    expect(
      parseProofreadAnswer(JSON.stringify({ fixes: [doubled, capital] }), scene, scene, ['Mara'])
    ).toEqual({ fixes: [doubled, capital], dropped: 0 })
  })

  it('drops a quote overlapping a fix kept before it', () => {
    const result = parse([DOUBLED, { kind: 'doubledWord', quote: 'The the', fix: 'The' }])
    expect(result).toEqual({ fixes: [DOUBLED], dropped: 1 })
  })

  it('caps the kept fixes at the limit, in document order', () => {
    const words = Array.from({ length: PROOFREAD_MAX_FIXES + 5 }, (_, i) => `wrod${i}q`)
    const text = `${words.join(' ')} end of the line.`
    const fixes = words.map((word) => ({ kind: 'typo', quote: `${word} `, fix: `word ` }))
    const result = parseProofreadAnswer(JSON.stringify({ fixes }), text, text, [])
    expect(result.fixes).toHaveLength(PROOFREAD_MAX_FIXES)
    expect(result.fixes[0]?.quote).toBe('wrod0q')
  })
})
