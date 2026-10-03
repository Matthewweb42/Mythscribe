import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import {
  CONTINUITY_FIX_MAX,
  CONTINUITY_MAX_FINDINGS,
  CONTINUITY_QUOTE_MAX,
  CONTINUITY_REF_VALUE_MAX,
  CONTINUITY_SCENE_CHAR_BUDGET,
  CONTINUITY_TEXT_MIN,
  CONTINUITY_WHY_MAX,
  continuityDedupeKey,
  type ContinuityRef
} from '@shared/continuity'
import type { ObservedFact } from '@shared/observedFacts'
import { emptySceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { createEntity, updateEntity } from '../entity/entityStore'
import { replaceSceneFacts, setFactHidden, factsForNode } from '../entity/observedFactStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings, setAuthorRules } from '../project/settingsStore'
import { addDocumentTag } from '../tag/documentTagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import {
  candidateContext,
  continuityRefs,
  localCandidates,
  parseContinuityAnswer,
  runBackgroundContinuity,
  runContinuity,
  settleContinuityFinding,
  storeContinuityRun,
  type ContinuityRun
} from './continuity'
import { dismissedKeys, listOpenFindings, openFindingsForNode } from './continuityFindingStore'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import { getProposal } from './proposalStore'
import {
  AiProviderError,
  AiRateLimitError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 2, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
/** The scene before the one under check, in reading order: where the other statements come from. */
let earlier: string
/** The scene under check. */
let scene: string
let folder: string
let mara: string
let memo: Map<string, string>

const OPENING =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago.'
const AGE_LINE = 'Mara was twenty-nine that winter, and she had stopped counting the crossings.'
const CLOSING =
  'She set the lantern down on the post and waited. "You came alone," a voice said behind her. ' +
  'She did not turn.'
const QUOTE = 'Mara was twenty-nine that winter'
const WHY = 'The sheet gives her age as 34.'
const FIX = 'Mara was thirty-four that winter'

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

interface ModelFinding {
  ref?: unknown
  quote?: unknown
  why?: unknown
  fix?: unknown
}

const found = (over: ModelFinding = {}): ModelFinding => ({
  ref: 1,
  quote: QUOTE,
  why: WHY,
  fix: FIX,
  ...over
})

/** The next answers, each as the JSON the prompt asks for. */
function answers(...sets: ModelFinding[][]): void {
  for (const findings of sets) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify({ findings }),
      model: 'gpt-fake',
      usage: { inputTokens: 700, outputTokens: 90 }
    })
  }
}

const sent = (call = 0): { system: string; user: string } => ({
  system: complete.mock.calls[call]?.[0].messages[0]?.content ?? '',
  user: complete.mock.calls[call]?.[0].messages[1]?.content ?? ''
})

async function failure(nodeId = scene): Promise<{ code: string; message: string }> {
  try {
    await runContinuity(db, deps, { nodeId })
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

/** The sheet says Mara is 34; the scene under check says twenty-nine. */
const ageRef = (): ContinuityRef => ({
  kind: 'sheet',
  entityId: mara,
  entityName: 'Mara',
  entityKind: 'character',
  attribute: 'age',
  label: 'Age',
  value: '34',
  nodeId: null,
  quote: null
})

/** What the summary job logs for the scene under check: its own statement of her age. */
const logAge = (): void => {
  replaceSceneFacts(db, scene, [
    { entityId: mara, attribute: 'age', value: 'twenty-nine', quote: QUOTE }
  ])
}

const background = (): Promise<ContinuityRun | null> =>
  runBackgroundContinuity(db, deps, { nodeId: scene, memo })

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-continuity-'))
  session = createProject(projectFolderFor(tmp, 'Continuity'), 'Continuity', 'novel')
  db = session.connection.orm
  const documents = manuscriptDocuments(db)
  earlier = documents[0]?.id ?? ''
  scene = documents[1]?.id ?? ''
  folder = listNodes(db).find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  if (!earlier || !scene || !folder) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(OPENING, AGE_LINE, CLOSING))
  mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '34' } }).entity.id
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  memo = new Map()
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

describe('continuityRefs (F-13.4)', () => {
  const text = (): string => [OPENING, AGE_LINE, CLOSING].join('\n')

  it('lists the sheet first, then what other scenes state, then the previous scene’s timeline', () => {
    updateEntity(db, mara, { fields: { appearance: 'Grey eyes,\n  a burn scar.' } })
    replaceSceneFacts(db, earlier, [
      { entityId: mara, attribute: 'age', value: 'thirty-four', quote: 'She was thirty-four.' },
      { entityId: mara, attribute: 'goals', value: 'Cross the river', quote: 'She meant to cross.' }
    ])
    // The scene's own facts are what is checked, never what it is checked against.
    replaceSceneFacts(db, scene, [
      { entityId: mara, attribute: 'gender', value: 'woman', quote: 'She did not turn.' }
    ])
    setSceneMeta(db, earlier, { ...emptySceneMeta(), timeline: 'Day 3, dusk' })
    setSceneMeta(db, scene, { ...emptySceneMeta(), timeline: 'Day 2, morning' })

    expect(continuityRefs(db, scene, text())).toEqual({
      refs: [
        ageRef(),
        {
          ...ageRef(),
          attribute: 'appearance',
          label: 'Appearance',
          value: 'Grey eyes, a burn scar.'
        },
        // The sheet fills `age`, so the earlier scene's age is left out: the author's word wins.
        {
          ...ageRef(),
          kind: 'fact',
          attribute: 'goals',
          label: 'Goals / motivations',
          value: 'Cross the river',
          nodeId: earlier,
          quote: 'She meant to cross.'
        },
        {
          kind: 'timeline',
          entityId: null,
          entityName: null,
          entityKind: null,
          attribute: null,
          label: 'Timeline',
          value: 'Day 3, dusk',
          nodeId: earlier,
          quote: null
        }
      ],
      truncated: false,
      timeline: 'Day 2, morning'
    })
  })

  it('needs a timeline on both scenes, and leaves a hidden fact out', () => {
    replaceSceneFacts(db, earlier, [
      { entityId: mara, attribute: 'goals', value: 'Cross the river', quote: 'She meant to cross.' }
    ])
    setFactHidden(db, factsForNode(db, earlier)[0]?.id ?? '', true)
    setSceneMeta(db, earlier, { ...emptySceneMeta(), timeline: 'Day 3, dusk' })
    expect(continuityRefs(db, scene, text())).toEqual({
      refs: [ageRef()],
      truncated: false,
      timeline: null
    })
  })

  it('covers the entities the scene names, the ones linked to its tags, and the ones it has facts about', () => {
    const tomas = createEntity(db, { kind: 'character', name: 'Tomas', fields: { age: '50' } })
    const mill = createEntity(db, { kind: 'setting', name: 'The mill', fields: { type: 'Mill' } })
    const vell = createEntity(db, { kind: 'character', name: 'Dr. Vell', fields: { age: '61' } })
    createEntity(db, { kind: 'world', name: 'Thaw', fields: { rules: 'Comes late.' } })
    if (mill.entity.tagId === null) throw new Error('the entity has no tag')
    addDocumentTag(db, scene, mill.entity.tagId)
    replaceSceneFacts(db, scene, [
      { entityId: vell.entity.id, attribute: 'age', value: 'sixty', quote: 'the doctor was sixty' }
    ])
    const names = continuityRefs(db, scene, text()).refs.map((ref) => ref.entityName)
    // Story-bible order; Tomas and the thaw are in neither the text, the tags, nor the facts.
    expect(names).toEqual(['Dr. Vell', 'Mara', 'The mill'])
    expect(names).not.toContain(tomas.entity.name)
  })

  it('sends a blank page as one Notes entry, one line, cut at the value cap', () => {
    const page = `Born on the river.\n\n${'x'.repeat(CONTINUITY_REF_VALUE_MAX)}`
    updateEntity(db, mara, { template: 'blank', body: page })
    const [ref, ...rest] = continuityRefs(db, scene, text()).refs
    expect(rest).toEqual([])
    expect(ref).toMatchObject({ kind: 'sheet', attribute: 'notes', label: 'Notes' })
    expect(ref?.value).toHaveLength(CONTINUITY_REF_VALUE_MAX)
    expect(ref?.value.startsWith('Born on the river. xxx')).toBe(true)
    expect(ref?.value.endsWith('…')).toBe(true)
  })

  it('leaves out a reference the author dismissed for this scene, and only for this scene', () => {
    const run: ContinuityRun = {
      findings: [
        { ref: ageRef(), quote: QUOTE, why: WHY, fix: null, flagged: false, violation: null }
      ],
      truncated: false,
      dropped: 0,
      references: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      promptVersion: 'continuity.v1',
      requested: true,
      fullText: text()
    }
    const [finding] = storeContinuityRun(db, scene, 'request', run, NOW).findings
    settleContinuityFinding(db, finding?.id ?? '', 'dismissed')
    expect(continuityRefs(db, scene, text()).refs).toEqual([])
    expect(continuityRefs(db, earlier, text()).refs).toEqual([ageRef()])
    // A changed sheet value is a new statement, so it is checked again.
    updateEntity(db, mara, { fields: { age: '35' } })
    expect(continuityRefs(db, scene, text()).refs).toEqual([{ ...ageRef(), value: '35' }])
  })

  it('caps the references at their token budget: facts go first, then the timeline, then sheets', () => {
    const long = (seed: string): string => `${seed} ${'word '.repeat(60)}`
    for (const name of ['Tomas', 'Pell', 'Ansel', 'Brann']) {
      createEntity(db, {
        kind: 'character',
        name,
        fields: {
          age: long('a'),
          gender: long('g'),
          appearance: long('p'),
          personality: long('y'),
          background: long('b'),
          goals: long('o'),
          relationships: long('r'),
          notes: long('n')
        }
      })
    }
    replaceSceneFacts(db, earlier, [
      { entityId: mara, attribute: 'goals', value: 'Cross the river', quote: 'She meant to cross.' }
    ])
    setSceneMeta(db, earlier, { ...emptySceneMeta(), timeline: 'Day 3, dusk' })
    setSceneMeta(db, scene, { ...emptySceneMeta(), timeline: 'Day 2, morning' })
    const named = `${text()}\nTomas, Pell, Ansel, and Brann waited.`

    const { refs, truncated, timeline } = continuityRefs(db, scene, named)
    expect(truncated).toBe(true)
    expect(timeline).toBeNull()
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.every((ref) => ref.kind === 'sheet')).toBe(true)
    // 33 sheet fields were filled; the last ones did not fit.
    expect(refs.length).toBeLessThan(33)
  })

  it('has nothing for a node outside the manuscript', () => {
    expect(continuityRefs(db, folder, text())).toEqual({
      refs: [],
      truncated: false,
      timeline: null
    })
  })
})

describe('localCandidates and candidateContext (F-13.4)', () => {
  const fact = (over: Partial<ObservedFact> = {}): ObservedFact => ({
    id: 'f1',
    entityId: 'mara',
    nodeId: 'scene',
    attribute: 'age',
    value: 'twenty-nine',
    quote: QUOTE,
    hidden: false,
    createdAt: '2026-10-02T10:00:00.000Z',
    ...over
  })
  const ref = (over: Partial<ContinuityRef> = {}): ContinuityRef => ({
    kind: 'sheet',
    entityId: 'mara',
    entityName: 'Mara',
    entityKind: 'character',
    attribute: 'age',
    label: 'Age',
    value: '34',
    nodeId: null,
    quote: null,
    ...over
  })

  it('pairs a fact with every reference about the same entity and attribute that says something else', () => {
    const sheet = ref()
    const other = ref({ kind: 'fact', value: 'thirty', nodeId: 'n2', quote: 'She was thirty.' })
    expect(localCandidates([fact()], [sheet, other])).toEqual([
      { quote: QUOTE, ref: sheet },
      { quote: QUOTE, ref: other }
    ])
  })

  it('finds no candidate in the same statement, another attribute, another entity, a hidden fact, or the timeline', () => {
    expect(localCandidates([fact()], [ref({ value: 'Twenty-nine.' })])).toEqual([])
    expect(localCandidates([fact()], [ref({ attribute: 'gender' })])).toEqual([])
    expect(localCandidates([fact()], [ref({ entityId: 'tomas' })])).toEqual([])
    expect(localCandidates([fact({ hidden: true })], [ref()])).toEqual([])
    expect(
      localCandidates(
        [fact()],
        [ref({ kind: 'timeline', entityId: null, attribute: null, value: 'Day 3' })]
      )
    ).toEqual([])
  })

  it('keeps only the paragraphs holding a candidate’s passage, each once, and only those candidates’ references', () => {
    const sheet = ref()
    const eyes = ref({ attribute: 'appearance', label: 'Appearance', value: 'Grey eyes' })
    const unused = ref({ attribute: 'gender', label: 'Gender', value: 'woman' })
    const sceneText = [OPENING, AGE_LINE, CLOSING].join('\n')
    expect(
      candidateContext(
        sceneText,
        [
          { quote: 'She did not turn.', ref: eyes },
          { quote: QUOTE, ref: sheet },
          { quote: 'she had stopped counting', ref: sheet },
          { quote: 'a passage the scene no longer holds', ref: unused }
        ],
        [sheet, eyes, unused]
      )
    ).toEqual({ text: `${AGE_LINE}\n${CLOSING}`, refs: [sheet, eyes] })
    expect(candidateContext(sceneText, [], [sheet])).toEqual({ text: '', refs: [] })
  })
})

describe('parseContinuityAnswer (F-13.4)', () => {
  const sceneText = [OPENING, AGE_LINE, CLOSING].join('\n')
  const sheet: ContinuityRef = {
    kind: 'sheet',
    entityId: 'mara',
    entityName: 'Mara',
    entityKind: 'character',
    attribute: 'age',
    label: 'Age',
    value: '34',
    nodeId: null,
    quote: null
  }
  const eyes: ContinuityRef = { ...sheet, attribute: 'appearance', label: 'Appearance' }
  const none = { nodeId: 'scene', dismissed: new Set<string>() }
  const parse = (findings: unknown, skip = none): ReturnType<typeof parseContinuityAnswer> =>
    parseContinuityAnswer(JSON.stringify({ findings }), sceneText, [sheet, eyes], skip)

  it('refuses an answer that is not JSON or not { findings: [...] } as a PROVIDER failure', () => {
    for (const text of ['not json', '[]', '{"findings":"none"}', '{"notes":[]}']) {
      expect(() => parseContinuityAnswer(text, sceneText, [sheet], none)).toThrowError(
        'The model did not answer in the expected format.'
      )
    }
  })

  it('keeps a finding with both citations, the reference resolved by its number', () => {
    expect(parse([found(), found({ ref: '2', quote: 'She did not turn.', fix: null })])).toEqual({
      findings: [
        { ref: sheet, quote: QUOTE, why: WHY, fix: FIX },
        { ref: eyes, quote: 'She did not turn.', why: WHY, fix: null }
      ],
      dropped: 0
    })
  })

  it('drops and counts a finding without two citations: a number that was not sent, a quote not in the text', () => {
    expect(
      parse([
        found({ ref: 3 }),
        found({ ref: 0 }),
        found({ ref: 1.5 }),
        found({ ref: 'the sheet' }),
        found({ quote: 'Mara was thirty that winter' }),
        found()
      ])
    ).toEqual({ findings: [{ ref: sheet, quote: QUOTE, why: WHY, fix: FIX }], dropped: 5 })
  })

  it('drops and counts a finding against a reference dismissed for this scene', () => {
    const dismissed = new Set([continuityDedupeKey('scene', sheet)])
    expect(parse([found(), found({ ref: 2 })], { nodeId: 'scene', dismissed })).toEqual({
      findings: [{ ref: eyes, quote: QUOTE, why: WHY, fix: FIX }],
      dropped: 1
    })
    // The same key under another scene dismisses nothing here.
    expect(parse([found()], { nodeId: 'other', dismissed }).findings).toHaveLength(1)
  })

  it('skips a malformed finding, trims and caps the strings, and reads a blank or unchanged fix as none', () => {
    const long = sceneText.slice(0, CONTINUITY_QUOTE_MAX + 20)
    const parsed = parse([
      'nonsense',
      { ref: 1, quote: QUOTE },
      found({ quote: '   ' }),
      found({ why: '' }),
      found({ quote: long, why: `  ${'w'.repeat(CONTINUITY_WHY_MAX + 10)}`, fix: '   ' }),
      found({ ref: 2, fix: ` ${QUOTE} ` }),
      found({ quote: 'She did not turn.', fix: 'f'.repeat(CONTINUITY_FIX_MAX + 10) })
    ])
    expect(parsed.dropped).toBe(0)
    expect(parsed.findings).toEqual([
      {
        ref: sheet,
        quote: long.slice(0, CONTINUITY_QUOTE_MAX).trim(),
        why: 'w'.repeat(CONTINUITY_WHY_MAX),
        fix: null
      },
      { ref: eyes, quote: QUOTE, why: WHY, fix: null },
      { ref: sheet, quote: 'She did not turn.', why: WHY, fix: 'f'.repeat(CONTINUITY_FIX_MAX) }
    ])
  })

  it('collapses a repeat of the same reference and passage and caps the list', () => {
    expect(
      parse([found(), found({ quote: `  ${QUOTE.toUpperCase()}` }), found()]).findings
    ).toHaveLength(1)
    const words = sceneText.split(' ')
    const many = words.slice(0, CONTINUITY_MAX_FINDINGS + 3).map((quote) => found({ quote }))
    const unique = new Set(words.slice(0, CONTINUITY_MAX_FINDINGS + 3)).size
    expect(parse(many).findings).toHaveLength(Math.min(unique, CONTINUITY_MAX_FINDINGS))
  })
})

describe('runContinuity, on demand (F-13.4)', () => {
  it('sends the whole scene and every reference to the strong tier as JSON and answers the scored findings', async () => {
    answers([found(), found({ quote: 'The lighthouse blinked twice.' }), found({ ref: 9 })])
    const run = await runContinuity(db, deps, { nodeId: scene })
    expect(run).toEqual({
      findings: [
        { ref: ageRef(), quote: QUOTE, why: WHY, fix: FIX, flagged: false, violation: null }
      ],
      truncated: false,
      dropped: 2,
      references: 1,
      usage: { inputTokens: 700, outputTokens: 90 },
      costUsd: priceFor('gpt-5.4', 700, 90).costUsd,
      cached: false,
      model: 'gpt-5.4',
      promptVersion: 'continuity.v1',
      requested: true,
      fullText: [OPENING, AGE_LINE, CLOSING].join('\n')
    })
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'strong', json: true, maxTokens: 800 })
    expect(
      sent().system.startsWith('You are the continuity feature inside a novel-writing app.')
    ).toBe(true)
    expect(sent().user).toBe(
      'References:\n[1] Mara (character), sheet, Age: 34\n\n' +
        `Scene text:\n"""\n${OPENING}\n${AGE_LINE}\n${CLOSING}\n"""\n\nList the contradictions.`
    )
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'continuity',
      tier: 'strong',
      promptVersion: 'continuity.v1',
      cached: false
    })
    // Nothing is stored and nothing is in the manuscript until the handler stores the run.
    expect(listOpenFindings(db)).toEqual([])
  })

  it('refuses with DISABLED below Ask or with the toggle off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Consistency check needs the AI dial at Ask or higher (it is at Off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 3, features: { ...on.features, continuity: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Consistency check is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('refuses an unknown node, a folder, a document outside the manuscript, and a scene under the minimum', async () => {
    expect((await failure('nope')).code).toBe('NOT_FOUND')
    expect((await failure(folder)).code).toBe('VALIDATION')
    const matter = listNodes(db).find(
      (row) => row.kind === 'document' && !manuscriptDocuments(db).some((d) => d.id === row.id)
    )
    if (matter !== undefined) {
      saveDocument(db, matter.id, doc(OPENING, AGE_LINE, CLOSING))
      expect(await failure(matter.id)).toEqual({
        code: 'VALIDATION',
        message: 'Only a scene in the manuscript can be checked'
      })
    }
    saveDocument(db, scene, doc('x'.repeat(CONTINUITY_TEXT_MIN - 1)))
    const short = await failure()
    expect(short.code).toBe('VALIDATION')
    expect(short.message).toContain(`${CONTINUITY_TEXT_MIN} characters`)
    expect(complete).not.toHaveBeenCalled()
  })

  it('makes no request and costs nothing when the story bible has nothing about the scene', async () => {
    updateEntity(db, mara, { fields: { age: '' } })
    const run = await runContinuity(db, deps, { nodeId: scene })
    expect(run).toMatchObject({
      findings: [],
      references: 0,
      requested: false,
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: ''
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('carries this scene’s timeline when the previous scene’s is a reference', async () => {
    setSceneMeta(db, earlier, { ...emptySceneMeta(), timeline: 'Day 3, dusk' })
    setSceneMeta(db, scene, { ...emptySceneMeta(), timeline: 'Day 2, morning' })
    answers([])
    await runContinuity(db, deps, { nodeId: scene })
    expect(sent().user).toContain('[2] Previous scene, Timeline: Day 3, dusk\n\n')
    expect(sent().user).toContain("This scene's timeline: Day 2, morning\n\n")
  })

  it('head-truncates a long scene to fit the input budget and reports it as truncated', async () => {
    saveDocument(db, scene, doc(`${AGE_LINE} ${'word '.repeat(CONTINUITY_SCENE_CHAR_BUDGET / 4)}`))
    answers([found()])
    const run = await runContinuity(db, deps, { nodeId: scene })
    expect(run.truncated).toBe(true)
    expect(run.findings).toHaveLength(1)
    expect(sent().user.length).toBeLessThan(CONTINUITY_SCENE_CHAR_BUDGET + 500)
  })

  it('answers the same check from the local cache, and never a fast-tier answer for the strong tier', async () => {
    logAge()
    answers([found()], [found()])
    await background()
    await runContinuity(db, deps, { nodeId: scene })
    // The background run sent one paragraph on the fast tier; the author's check is its own request.
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls.map(([request]) => request.tier)).toEqual(['fast', 'strong'])
    const again = await runContinuity(db, deps, { nodeId: scene })
    expect(again.cached).toBe(true)
    expect(again.findings).toHaveLength(1)
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('flags a fix that uses a banned phrase by name (F-14.7), with the rules in the voice block sent', async () => {
    setAuthorRules(db, { rules: '', bannedPhrases: ['delve'] })
    bumpVoiceVersion()
    answers([found({ fix: 'Mara was thirty-four, and did not delve into it' })])
    const run = await runContinuity(db, deps, { nodeId: scene })
    expect(run.findings[0]).toMatchObject({ flagged: true })
    expect(run.findings[0]?.violation).toContain('delve')
    // AI rule 2: the fix is prose, so the author's rules ride in the system turn's voice block.
    expect(sent().system).toContain('delve')
    expect(sent().user).not.toContain('delve')
  })

  it('surfaces an unreadable answer as a PROVIDER failure: the author asked and should know', async () => {
    complete.mockResolvedValueOnce({
      text: 'I found nothing.',
      model: 'gpt-fake',
      usage: { inputTokens: 700, outputTokens: 5 }
    })
    expect(await failure()).toEqual({
      code: 'PROVIDER',
      message: 'The model did not answer in the expected format.'
    })
  })
})

describe('runBackgroundContinuity (F-13.4)', () => {
  it('asks nothing when no fact of the scene differs from the story bible', async () => {
    // No facts at all, then a fact that agrees with the sheet.
    expect(await background()).toMatchObject({ findings: [], requested: false, references: 0 })
    replaceSceneFacts(db, scene, [{ entityId: mara, attribute: 'age', value: '34.', quote: QUOTE }])
    expect(await background()).toMatchObject({ findings: [], requested: false })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('sends only the paragraph holding the candidate and the reference it differs from, on the fast tier', async () => {
    logAge()
    updateEntity(db, mara, { fields: { appearance: 'Grey eyes' } })
    setSceneMeta(db, earlier, { ...emptySceneMeta(), timeline: 'Day 3, dusk' })
    setSceneMeta(db, scene, { ...emptySceneMeta(), timeline: 'Day 2, morning' })
    answers([found()])
    const run = await background()
    expect(run).toMatchObject({
      findings: [
        { ref: ageRef(), quote: QUOTE, why: WHY, fix: FIX, flagged: false, violation: null }
      ],
      references: 1,
      requested: true,
      truncated: false,
      fullText: [OPENING, AGE_LINE, CLOSING].join('\n')
    })
    expect(complete.mock.calls[0]![0]).toMatchObject({ tier: 'fast', json: true, maxTokens: 800 })
    expect(sent().user).toBe(
      'References:\n[1] Mara (character), sheet, Age: 34\n\n' +
        `Scene text:\n"""\n${AGE_LINE}\n"""\n\nList the contradictions.`
    )
    expect(ledger[0]).toMatchObject({ feature: 'continuity', tier: 'fast' })
  })

  it('finds a candidate in what another scene states when the sheet is silent', async () => {
    updateEntity(db, mara, { fields: { age: '' } })
    replaceSceneFacts(db, earlier, [
      { entityId: mara, attribute: 'age', value: 'thirty-four', quote: 'She was thirty-four.' }
    ])
    logAge()
    answers([found()])
    const run = await background()
    expect(run?.findings[0]?.ref).toMatchObject({
      kind: 'fact',
      value: 'thirty-four',
      nodeId: earlier,
      quote: 'She was thirty-four.'
    })
    expect(sent().user).toContain(
      '[1] Mara (character), another scene, Age: thirty-four; passage: "She was thirty-four."'
    )
  })

  it('does not ask again while the candidate paragraphs and references are what they were', async () => {
    logAge()
    answers([found()])
    expect(await background()).not.toBeNull()
    // Typing elsewhere in the scene changes nothing the check saw.
    saveDocument(db, scene, doc(`${OPENING} The fog came in.`, AGE_LINE, CLOSING))
    expect(await background()).toBeNull()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(ledger).toHaveLength(1)
    // An edit to the paragraph itself is a new context.
    saveDocument(db, scene, doc(OPENING, `${AGE_LINE} So she said.`, CLOSING))
    answers([found()])
    expect(await background()).not.toBeNull()
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('is silent when the dial or the toggle forbids it, and for a node outside the manuscript', async () => {
    logAge()
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await background()).toBeNull()
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 3, features: { ...on.features, continuity: false } })
    expect(await background()).toBeNull()
    setAiSettings(db, { ...on, dial: 1 })
    expect(await runBackgroundContinuity(db, deps, { nodeId: folder, memo })).toBeNull()
    expect(complete).not.toHaveBeenCalled()
  })

  it('swallows an answer it cannot read, keeps its cost in the ledger, and does not ask again', async () => {
    logAge()
    complete.mockResolvedValueOnce({
      text: 'Sure! Here are the contradictions:',
      model: 'gpt-fake',
      usage: { inputTokens: 300, outputTokens: 8 }
    })
    expect(await background()).toBeNull()
    expect(ledger).toHaveLength(1)
    expect(await background()).toBeNull()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('lets a provider failure through, so the job retries, and remembers nothing', async () => {
    logAge()
    complete.mockRejectedValueOnce(new AiRateLimitError('Slow down.'))
    await expect(background()).rejects.toBeInstanceOf(AiRateLimitError)
    expect(memo.size).toBe(0)
    answers([found()])
    expect((await background())?.findings).toHaveLength(1)
  })

  it('never asks about a reference the author dismissed for the scene', async () => {
    logAge()
    answers([found()])
    const run = await background()
    if (run === null) throw new Error('expected a run')
    const [finding] = storeContinuityRun(db, scene, 'background', run, NOW).findings
    settleContinuityFinding(db, finding?.id ?? '', 'dismissed')
    memo.clear()
    expect(await background()).toMatchObject({ findings: [], requested: false })
    expect(complete).toHaveBeenCalledTimes(1)
    // Nor does Check consistency: the sheet's age is the only reference, and it is dismissed.
    expect(await runContinuity(db, deps, { nodeId: scene })).toMatchObject({ requested: false })
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

describe('storeContinuityRun and settleContinuityFinding (F-13.4)', () => {
  const fullText = [OPENING, AGE_LINE, CLOSING].join('\n')
  const run = (quotes: string[], over: Partial<ContinuityRun> = {}): ContinuityRun => ({
    findings: quotes.map((quote) => ({
      ref: ageRef(),
      quote,
      why: WHY,
      fix: quote === QUOTE ? FIX : null,
      flagged: false,
      violation: null
    })),
    truncated: false,
    dropped: 0,
    references: 1,
    usage: { inputTokens: 700, outputTokens: 90 },
    costUsd: 0.002,
    cached: false,
    model: 'gpt-fake',
    promptVersion: 'continuity.v1',
    requested: true,
    fullText,
    ...over
  })
  const quotes = (): [string, string][] =>
    openFindingsForNode(db, scene).map((finding) => [finding.origin, finding.quote])

  it('stores the findings as open rows under one pending proposal holding them as JSON', () => {
    const stored = storeContinuityRun(db, scene, 'request', run([QUOTE, 'She did not turn.']), NOW)
    expect(stored.changed).toBe(true)
    expect(stored.findings).toHaveLength(2)
    expect(stored.findings.every((f) => f.proposalId === stored.proposalId)).toBe(true)
    expect(stored.findings[0]).toMatchObject({
      nodeId: scene,
      ref: ageRef(),
      quote: QUOTE,
      fix: FIX,
      status: 'open',
      origin: 'request',
      createdAt: NOW.toISOString()
    })
    const proposal = getProposal(db, stored.proposalId ?? '')
    expect(proposal).toMatchObject({
      feature: 'continuity',
      nodeId: scene,
      promptVersion: 'continuity.v1',
      model: 'gpt-fake',
      promptTokens: 700,
      completionTokens: 90,
      costUsd: 0.002,
      status: 'pending',
      flagged: false,
      violation: null
    })
    expect(JSON.parse(proposal?.content ?? '')).toEqual(run([QUOTE, 'She did not turn.']).findings)
  })

  it('flags the proposal when any fix failed the fidelity check', () => {
    const flagged = run([QUOTE])
    flagged.findings[0] = { ...flagged.findings[0]!, flagged: true, violation: 'Uses "delve".' }
    const stored = storeContinuityRun(db, scene, 'request', flagged, NOW)
    expect(getProposal(db, stored.proposalId ?? '')).toMatchObject({
      flagged: true,
      violation: 'Uses "delve".'
    })
  })

  it('records no proposal and reports no change for a run that found nothing over a clean scene', () => {
    expect(storeContinuityRun(db, scene, 'request', run([]), NOW)).toEqual({
      findings: [],
      proposalId: null,
      changed: false
    })
  })

  it('Check consistency replaces every open finding of the scene and settles the proposal it emptied', () => {
    const first = storeContinuityRun(db, scene, 'background', run([QUOTE]), NOW)
    const second = storeContinuityRun(db, scene, 'request', run(['She did not turn.']), NOW)
    expect(quotes()).toEqual([['request', 'She did not turn.']])
    expect(second.changed).toBe(true)
    expect(getProposal(db, first.proposalId ?? '')?.status).toBe('regenerated')
    expect(getProposal(db, second.proposalId ?? '')?.status).toBe('pending')
    // A clean re-check clears the scene.
    expect(storeContinuityRun(db, scene, 'request', run([]), NOW)).toMatchObject({
      findings: [],
      changed: true
    })
  })

  it('a background run replaces only what background runs left, and never repeats what the author’s check found', () => {
    storeContinuityRun(db, scene, 'request', run([QUOTE, 'She did not turn.']), NOW)
    storeContinuityRun(db, scene, 'background', run(['a voice said behind her']), NOW)
    expect(quotes()).toEqual([
      ['request', QUOTE],
      ['request', 'She did not turn.'],
      ['background', 'a voice said behind her']
    ])
    const again = storeContinuityRun(db, scene, 'background', run([QUOTE, 'the bell']), NOW)
    expect(quotes()).toEqual([
      ['request', QUOTE],
      ['request', 'She did not turn.'],
      ['background', 'the bell']
    ])
    expect(again.findings).toHaveLength(3)
    expect(JSON.parse(getProposal(db, again.proposalId ?? '')?.content ?? '')).toHaveLength(1)
  })

  it('a background run removes a finding whose passage is no longer in the scene', () => {
    storeContinuityRun(db, scene, 'request', run([QUOTE, 'She did not turn.']), NOW)
    const edited = [OPENING, CLOSING].join('\n')
    const stored = storeContinuityRun(db, scene, 'background', run([], { fullText: edited }), NOW)
    expect(quotes()).toEqual([['request', 'She did not turn.']])
    expect(stored).toMatchObject({ proposalId: null, changed: true })
  })

  it('leaves dismissed and applied findings alone whatever runs afterwards', () => {
    const stored = storeContinuityRun(db, scene, 'request', run([QUOTE, 'She did not turn.']), NOW)
    const [age, turn] = stored.findings
    settleContinuityFinding(db, age?.id ?? '', 'applied')
    settleContinuityFinding(db, turn?.id ?? '', 'dismissed')
    storeContinuityRun(db, scene, 'request', run([]), NOW)
    storeContinuityRun(db, scene, 'background', run([]), NOW)
    expect(dismissedKeys(db, scene).size).toBe(1)
    // A settled finding is never settled again: the tombstone stays a tombstone.
    expect(() => settleContinuityFinding(db, turn?.id ?? '', 'applied')).toThrow(
      /^Finding not found/
    )
    expect(() => settleContinuityFinding(db, age?.id ?? '', 'dismissed')).toThrow(
      /^Finding not found/
    )
    expect(dismissedKeys(db, scene).size).toBe(1)
  })

  it('settles the proposal with its last open finding: accepted, part, or rejected', () => {
    const settleAll = (statuses: ('applied' | 'dismissed')[]): string | undefined => {
      const stored = storeContinuityRun(
        db,
        scene,
        'request',
        run(statuses.map((_, at) => ['the bell', 'the rope', 'the post'][at] ?? '')),
        NOW
      )
      const results = stored.findings.map((finding, at) =>
        settleContinuityFinding(db, finding.id, statuses[at] ?? 'dismissed')
      )
      // Only the last settlement settles the proposal.
      expect(results.slice(0, -1).every((result) => result.proposal === null)).toBe(true)
      expect(results.at(-1)?.proposal).toBe(getProposal(db, stored.proposalId ?? '')?.status)
      return getProposal(db, stored.proposalId ?? '')?.status
    }
    expect(settleAll(['applied', 'applied'])).toBe('accepted')
    expect(settleAll(['applied', 'dismissed', 'dismissed'])).toBe('acceptedPart')
    expect(settleAll(['dismissed'])).toBe('rejected')
  })

  it('settles a proposal as accepted in part when a re-check replaces what was left of it', () => {
    const stored = storeContinuityRun(db, scene, 'request', run(['the bell', 'the rope']), NOW)
    settleContinuityFinding(db, stored.findings[0]?.id ?? '', 'applied')
    storeContinuityRun(db, scene, 'request', run([]), NOW)
    expect(getProposal(db, stored.proposalId ?? '')?.status).toBe('acceptedPart')
  })

  it('refuses to settle an unknown finding with NOT_FOUND', () => {
    expect(() => settleContinuityFinding(db, 'missing', 'dismissed')).toThrowError(/not found/i)
  })
})
