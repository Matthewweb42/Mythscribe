import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateTokens, inputBudget, priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import {
  CRITIQUE_FIX_MAX,
  CRITIQUE_MAX_NOTES,
  CRITIQUE_QUOTE_MAX,
  CRITIQUE_SCENE_CHAR_BUDGET,
  CRITIQUE_TEXT_MIN,
  CRITIQUE_WHY_MAX
} from '@shared/critique'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { manuscriptDocuments } from '../voice/profile'
import { AppError } from '../ipc/errors'
import { setAiSettings, setAuthorRules } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import { fitSceneToBudget, parseCritiqueAnswer, runCritique, type CritiqueInput } from './critique'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { cancelInflight, inflightCount, resetInflight } from './inflight'
import {
  AiCancelledError,
  AiProviderError,
  AiRateLimitError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'
import { EMPTY_SCENE_BRIEF, emptySceneMeta } from '@shared/sceneMeta'

const NOW = new Date(2026, 8, 15, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scene: string
/** The next manuscript document in reading order: its brief rides along with the scene's (F-14.3). */
let nextScene: string
let folder: string
let dailyCapUsd: number

/** The scene under review: over `CRITIQUE_TEXT_MIN`, third person, past tense, `said` only. */
const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
  '"You came alone," a voice said behind her. She did not turn. "You said to."'
const QUOTE = 'The rope hung slack in the water'
const WHY = 'The image lands, but the sentence runs on past its beat.'
const FIX = 'The rope hung slack in the water.'
/** Five present markers and five first-person pronouns: trips the tense rule first. */
const OFF_VOICE =
  'I am lost and I know we are done, and it is late, and my hands are cold, and I am tired.'

/** Nouns only, over the minimum: no tense, no person, too few words for a rule, so no voice block. */
const NEUTRAL =
  'Rope, lantern, bell, water, post, ferry, landing, clapper, plank, rail, fog, oar, rope, ' +
  'lantern, bell, water, post, ferry, landing, clapper, plank, rail, fog, oar, rope, lantern, ' +
  'bell, water, post, ferry.'

/** One paragraph of third-person past narration with four dialogue tags; six make a strong profile. */
const VOICE_PARAGRAPH =
  'Mara turned from the window and looked at the ridge, where the storm had settled for the ' +
  'night. "We should go," she said. "Not yet," Tomas replied. He knew she was tired, and he was ' +
  'tired too. They walked to the door and she pulled it open. "The river is rising," she said. ' +
  '"Then we wait," he said.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

interface ModelNote {
  kind?: unknown
  category?: unknown
  quote?: unknown
  why?: unknown
  fix?: unknown
}

/** The next answer, as the JSON the prompt asks for. */
function answers(...notes: ModelNote[][]): void {
  for (const set of notes) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify({ notes: set }),
      model: 'gpt-5.4',
      usage: { inputTokens: 900, outputTokens: 120 }
    })
  }
}

const issue = (over: ModelNote = {}): ModelNote => ({
  kind: 'issue',
  category: 'pacing',
  quote: QUOTE,
  why: WHY,
  fix: null,
  ...over
})

const critique = (over: Partial<CritiqueInput> = {}): ReturnType<typeof runCritique> =>
  runCritique(db, deps, { nodeId: scene, ...over })

async function failure(
  over: Partial<CritiqueInput> = {}
): Promise<{ code: string; message: string }> {
  try {
    await critique(over)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

/** The messages of the last request, as the provider saw them. */
const sent = (call = 0): { system: string; user: string } => ({
  system: complete.mock.calls[call]?.[0].messages[0]?.content ?? '',
  user: complete.mock.calls[call]?.[0].messages[1]?.content ?? ''
})

/** A manuscript strong enough for the tense and person rules. */
const strongProfile = (): void => {
  saveDocument(db, scene, doc(`${SCENE} ${Array(6).fill(VOICE_PARAGRAPH).join(' ')}`))
}

/** Settles like the adapter once its `signal` aborts: rejects with CANCELLED. */
const untilCancelled = (request: CompletionRequest): Promise<never> =>
  new Promise((_, reject) => {
    request.signal?.addEventListener(
      'abort',
      () => reject(new AiCancelledError('The request was stopped.')),
      { once: true }
    )
  })

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-critique-'))
  session = createProject(projectFolderFor(tmp, 'Critique'), 'Critique', 'novel')
  db = session.connection.orm
  const documents = manuscriptDocuments(db)
  scene = documents[0]?.id ?? ''
  nextScene = documents[1]?.id ?? ''
  folder = listNodes(db).find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  if (!scene || !nextScene || !folder) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(SCENE))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answers([issue()])
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
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('runCritique (F-14.8)', () => {
  it('sends the scene as JSON to the strong tier under critique.v3 and answers the cited notes', async () => {
    const result = await critique()
    expect(result).toEqual({
      notes: [
        {
          kind: 'issue',
          category: 'pacing',
          quote: QUOTE,
          why: WHY,
          fix: null,
          flagged: false,
          violation: null
        }
      ],
      truncated: false,
      dropped: 0,
      usage: { inputTokens: 900, outputTokens: 120 },
      costUsd: priceFor('gpt-5.4', 900, 120).costUsd,
      cached: false,
      model: 'gpt-5.4',
      promptVersion: 'critique.v3'
    })
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'strong', json: true, maxTokens: 1_500 })
    expect('temperature' in request).toBe(false)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'critique',
      tier: 'strong',
      promptVersion: 'critique.v3',
      cached: false
    })
    expect(ledger[0]!.contextHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses with DISABLED below Ask or with the feature off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: "Editor's notes needs the AI dial at Ask or higher (it is at Off)."
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 3, features: { ...on.features, critique: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: "Editor's notes is turned off for this project."
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('refuses an unknown node with NOT_FOUND, a folder with VALIDATION, and a scene under the minimum with VALIDATION', async () => {
    expect((await failure({ nodeId: 'nope' })).code).toBe('NOT_FOUND')
    expect((await failure({ nodeId: folder })).code).toBe('VALIDATION')
    saveDocument(db, scene, doc('x'.repeat(CRITIQUE_TEXT_MIN - 1)))
    const short = await failure()
    expect(short.code).toBe('VALIDATION')
    expect(short.message).toContain(`${CRITIQUE_TEXT_MIN} characters`)
    expect(complete).not.toHaveBeenCalled()
  })

  it('head-truncates a long scene to the character budget and reports it as truncated', async () => {
    const long = `${SCENE} `.repeat(400)
    saveDocument(db, scene, doc(long))
    answers([issue()])
    const result = await critique()
    expect(result.truncated).toBe(true)
    expect(sent().user).toContain(`${long.slice(0, CRITIQUE_SCENE_CHAR_BUDGET)}…`)
    const scenePart = sent().user.split('Scene text:\n"""\n')[1]?.split('\n"""')[0] ?? ''
    expect(scenePart).toHaveLength(CRITIQUE_SCENE_CHAR_BUDGET + 1)
  })

  it('carries the scene brief (F-14.3) as the intent, the neighbours included, only when one is written', async () => {
    saveNotes(db, scene, doc('The notes are no longer the brief.'))
    await critique()
    expect(sent().user).toBe(`Scene text:\n"""\n${SCENE}\n"""\n\nGive your editor's notes.`)
    setSceneMeta(db, scene, {
      ...emptySceneMeta(),
      brief: { ...EMPTY_SCENE_BRIEF, goal: 'Mara wants the ledger back.' }
    })
    setSceneMeta(db, nextScene, {
      ...emptySceneMeta(),
      brief: { ...EMPTY_SCENE_BRIEF, goal: 'Tomas counts what the mill owes.' }
    })
    answers([issue()])
    await critique()
    const user = sent(1).user
    expect(user).toContain(
      `Scene brief (the author's intent):\n"""\nScene brief:\n- Goal: Mara wants the ledger ` +
        `back.\nNext scene's goal: Tomas counts what the mill owes.\n"""`
    )
    expect(user).toContain('Include one "intent" note')
    expect(user).not.toContain('The notes are no longer the brief.')
  })

  it('sends the honesty line the project is set to, plus the voice block and the scene line', async () => {
    strongProfile()
    setSceneMeta(db, scene, {
      location: 'Ferry landing',
      pov: 'Mara',
      timeline: '',
      brief: EMPTY_SCENE_BRIEF
    })
    const settings = defaultAiSettings()
    setAiSettings(db, { ...settings, dial: 1, critique: { honesty: 'brutal' } })
    await critique()
    const system = sent().system
    expect(system.startsWith('You are the editor feature inside a novel-writing app.')).toBe(true)
    expect(system).toContain('Be brutal:')
    expect(system).not.toContain('Be specific and direct:')
    expect(system).toContain("Match the author's voice:")
    expect(system).toContain('Scene: location Ferry landing, POV Mara, timeline —.')
  })

  it('answers the same scene from the cache, and misses it when the text, the honesty, or the voice version change', async () => {
    await critique()
    await critique()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(ledger[1]?.cached).toBe(true)
    const settings = defaultAiSettings()
    setAiSettings(db, { ...settings, dial: 1, critique: { honesty: 'encouraging' } })
    answers([issue()])
    await critique()
    expect(complete).toHaveBeenCalledTimes(2)
    bumpVoiceVersion()
    answers([issue()])
    await critique()
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('lets a budget refusal and a provider error propagate, logging nothing', async () => {
    dailyCapUsd = 0
    expect((await failure()).code).toBe('BUDGET')
    dailyCapUsd = 2
    complete.mockReset()
    complete.mockRejectedValueOnce(new AiRateLimitError('Slow down.'))
    expect((await failure()).code).toBe('RATE_LIMIT')
    expect(ledger).toHaveLength(0)
  })

  it('hands the requestId to the provider as its signal, and a cancel rejects with CANCELLED (F-5.10)', async () => {
    complete.mockReset()
    complete.mockImplementationOnce(untilCancelled)
    const pending = critique({ requestId: 'cq-1' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(complete.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(cancelInflight('cq-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toHaveLength(0)
    expect(inflightCount()).toBe(0)
  })
})

describe('runCritique citations and parsing (F-14.8)', () => {
  it('drops every note whose quote is not in the scene sent, praise included, and counts them', async () => {
    complete.mockReset()
    answers([
      issue(),
      {
        kind: 'praise',
        category: 'clarity',
        quote: 'The dragon circled the keep.',
        why: 'Vivid.',
        fix: null
      },
      {
        kind: 'praise',
        category: 'clarity',
        quote: 'She set the lantern down on the post',
        why: 'Quiet and concrete.',
        fix: null
      }
    ])
    const result = await critique()
    expect(result.notes.map((note) => note.quote)).toEqual([
      QUOTE,
      'She set the lantern down on the post'
    ])
    expect(result.dropped).toBe(1)
  })

  it('answers PROVIDER when the model does not reply in the expected shape', async () => {
    complete.mockReset()
    complete.mockResolvedValueOnce({
      text: 'Here are my notes!',
      model: 'gpt-5.4',
      usage: { inputTokens: 900, outputTokens: 5 }
    })
    expect((await failure()).code).toBe('PROVIDER')
    complete.mockResolvedValueOnce({
      text: '{"verdict":"good"}',
      model: 'gpt-5.4',
      usage: { inputTokens: 900, outputTokens: 5 }
    })
    expect((await failure({ note: 'again' })).code).toBe('PROVIDER')
  })

  it('flags a fix that breaks the voice (F-14.7) and leaves a fresh project unflagged', async () => {
    strongProfile()
    complete.mockReset()
    answers([issue({ fix: OFF_VOICE })])
    const flagged = await critique()
    expect(flagged.notes[0]).toMatchObject({
      flagged: true,
      violation: 'switches to present tense'
    })
  })

  it('flags a fix that uses a banned phrase by name, even on a thin profile (F-14.2)', async () => {
    saveDocument(db, scene, doc(NEUTRAL))
    setAuthorRules(db, { rules: '', bannedPhrases: ['delve'] })
    bumpVoiceVersion()
    complete.mockReset()
    answers([
      {
        kind: 'issue',
        category: 'clarity',
        quote: NEUTRAL.slice(0, 40),
        why: WHY,
        fix: 'Rope, lantern, bell: she did not delve into the water.'
      }
    ])
    const result = await critique()
    expect(sent().system).toContain('Never use these phrases: delve.')
    expect(result.notes[0]).toMatchObject({
      flagged: true,
      violation: 'uses the phrase “delve”, which the author has banned'
    })
  })

  it('scores nothing for a project with neither rules nor exemplars: no voice block went out', async () => {
    // Nouns only: no resolvable tense or person and too few words for a rule, so the profile
    // is empty and `voiceBlock` sends nothing — the same gate the rewrite and ghost text use.
    saveDocument(db, scene, doc(NEUTRAL))
    complete.mockReset()
    answers([
      { kind: 'issue', category: 'clarity', quote: NEUTRAL.slice(0, 40), why: WHY, fix: OFF_VOICE }
    ])
    const result = await critique()
    expect(sent().system).not.toContain("Match the author's voice:")
    expect(result.notes[0]).toMatchObject({ fix: OFF_VOICE, flagged: false, violation: null })
  })
})

describe('runCritique regenerate (F-14.5)', () => {
  it('sends critiqueRegen.v3 with the note clause and misses the cache on the note and the predecessor', async () => {
    await critique()
    expect(complete).toHaveBeenCalledTimes(1)
    const note = 'Less about pacing, more about the dialogue.'
    answers([issue()])
    const again = await critique({ note, regeneratedFrom: 'p-1' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(sent(1).system).toContain(`The writer asked for different notes and said: "${note}".`)
    expect(again.promptVersion).toBe('critiqueRegen.v3')
    expect(ledger.map((row) => row.promptVersion)).toEqual(['critique.v3', 'critiqueRegen.v3'])
    // A predecessor with no note is its own request; a blank note with no predecessor is not one at all.
    answers([issue()])
    await critique({ regeneratedFrom: 'p-2' })
    expect(complete).toHaveBeenCalledTimes(3)
    const plain = await critique({ note: '   ' })
    expect(complete).toHaveBeenCalledTimes(3)
    expect(plain.promptVersion).toBe('critique.v3')
  })
})

describe('parseCritiqueAnswer (F-14.8)', () => {
  const parse = (notes: ModelNote[]): ReturnType<typeof parseCritiqueAnswer> =>
    parseCritiqueAnswer(JSON.stringify({ notes }), SCENE)

  it('drops a note with an unknown kind, an unknown category, or a blank quote or reason, without counting it', () => {
    const result = parse([
      issue({ kind: 'nitpick' }),
      issue({ category: 'vibes' }),
      issue({ quote: '   ' }),
      issue({ why: '' }),
      issue({ quote: 42 }),
      issue()
    ])
    expect(result.notes).toHaveLength(1)
    expect(result.dropped).toBe(0)
  })

  it('trims and caps the strings and matches the quote through the shared normalization', () => {
    const curly = 'The rope hung slack in the\n  water'
    const result = parse([
      issue({
        quote: `  ${curly}  `,
        why: `${'w'.repeat(CRITIQUE_WHY_MAX + 20)}`,
        fix: 'f'.repeat(CRITIQUE_FIX_MAX + 20)
      })
    ])
    expect(result.notes[0]?.quote).toBe(curly)
    expect(result.notes[0]?.why).toHaveLength(CRITIQUE_WHY_MAX)
    expect(result.notes[0]?.fix).toHaveLength(CRITIQUE_FIX_MAX)
    expect(parse([issue({ quote: 'x'.repeat(CRITIQUE_QUOTE_MAX + 10) })]).dropped).toBe(1)
  })

  it('reads a blank fix, a fix that only repeats the quote, and a fix on praise as no fix', () => {
    expect(parse([issue({ fix: '  ' })]).notes[0]?.fix).toBeNull()
    expect(parse([{ ...issue({ fix: FIX }), kind: 'praise' }]).notes[0]?.fix).toBeNull()
    expect(parse([issue({ fix: QUOTE })]).notes[0]?.fix).toBeNull()
    expect(parse([issue({ fix: `  ${QUOTE}\n` })]).notes[0]?.fix).toBeNull()
    expect(parse([issue({ fix: FIX })]).notes[0]?.fix).toBe(FIX)
  })

  it('keeps the first note per quote and caps the list', () => {
    expect(parse([issue(), issue({ why: 'Again.' })]).notes).toHaveLength(1)
    const many = Array.from({ length: CRITIQUE_MAX_NOTES + 3 }, (_, i) =>
      issue({ quote: SCENE.slice(i, 60 + i) })
    )
    expect(parse(many).notes).toHaveLength(CRITIQUE_MAX_NOTES)
  })

  it('refuses an answer that is not JSON or not { notes: [...] } at all', () => {
    expect(() => parseCritiqueAnswer('nope', SCENE)).toThrowError(/expected format/)
    expect(() => parseCritiqueAnswer('{"verdict":"good"}', SCENE)).toThrowError(/expected format/)
  })
})

describe('fitSceneToBudget (F-14.8, token rule 8)', () => {
  const messages = (sceneText: string): { role: 'user'; content: string }[] => [
    { role: 'user', content: sceneText }
  ]

  it('sends the whole scene untruncated when it fits', () => {
    expect(fitSceneToBudget(SCENE, inputBudget('critique'), messages)).toEqual({
      sceneText: SCENE,
      truncated: false
    })
  })

  it('cuts to the character budget first, then shrinks until the prompt fits the token budget', () => {
    const long = 'x'.repeat(CRITIQUE_SCENE_CHAR_BUDGET * 2)
    const fit = fitSceneToBudget(long, 1_000, messages)
    expect(fit.truncated).toBe(true)
    expect(estimateTokens(fit.sceneText)).toBeLessThanOrEqual(1_000)
    expect(fit.sceneText.endsWith('…')).toBe(true)
  })

  it('stops at the minimum rather than cutting the scene away entirely', () => {
    const fit = fitSceneToBudget('x'.repeat(10_000), 1, messages)
    expect(fit.sceneText).toHaveLength(CRITIQUE_TEXT_MIN + 1)
    expect(fit.truncated).toBe(true)
  })
})
