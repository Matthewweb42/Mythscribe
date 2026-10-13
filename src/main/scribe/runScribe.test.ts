import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateTokens, priceFor } from '@shared/ai'
import {
  AGENT_COST_CAP_USD,
  AGENT_CUT_OFF_MESSAGE,
  AGENT_RETRY_MAX_TOKENS,
  type AgentStep
} from '@shared/agent'
import { defaultAiSettings } from '@shared/aiSettings'
import { emptyCardFields } from '@shared/memory/claims'
import { normName } from '@shared/memory/names'
import type { StoryRecordSummary } from '@shared/memory/records'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { directionMessage } from '@shared/quickActions'
import { SCRIBE_REASONING_TOKENS, type Navigation } from '@shared/scribe'
import { parseCitedAnswer } from '@shared/scribeAnswer'
import { claim, card, reading, searchMiss } from '../db/schema'
import { activeDraftId } from '../draft/draftStore'
import { defaultAiUsageState, dayOf } from '../ai/dailyCap'
import { resetInflight } from '../ai/inflight'
import {
  AGENT_V9_EDIT_TOOLS,
  AGENT_V9_SENTINEL,
  AGENT_V9_WIDENED_HEADING,
  agentV9UnsupportedTurn,
  buildAgentPromptV9,
  UNSUPPORTED_REASONS
} from '../ai/prompts/agent.v9'
import { CITE_SENTINEL } from '../ai/prompts/cite.v1'
import { saveDocument } from '../document/documentStore'
import {
  AiCancelledError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import { loadAgentProject } from '../ai/agentTools'
import type { UsageEntry } from '../ai/usageStore'
import { cardAnchorOf, seedClaims } from '../memory/reading/claimFixture'
import { upsertCard } from '../memory/reading/cardStore'
import { savePage } from '../memory/recordStore'
import { setAiSettings } from '../project/settingsStore'
import { resetVoiceProfileCache } from '../voice/versionCache'
import type { EvidenceItem } from './evidence'
import {
  CHANGE_READY,
  CHECKING_QUOTES,
  fitScribePrompt,
  PIN_NO_RECORD,
  PIN_NOT_ASKED,
  PIN_NOT_NAMED,
  PIN_SAID,
  PIN_TOPIC,
  pinRecordOf,
  PLAN_NO_EDIT,
  PLAN_NO_PIN,
  ShownStream,
  readScribeReply,
  runScribe,
  scribeTurnOf,
  type ScribeInput
} from './runScribe'
import {
  closeScribeBook,
  doc,
  indexBook,
  SCRIBE_NOW,
  scribeBook,
  type ScribeBook
} from './scribeFixture'

/**
 * Ms Scribe's answer call (F-16.25, F-16.26; plan P3 §2.6): one `agent.v9` request carrying E0
 * and the evidence, its citations checked in code, the Self-Route and its search misses, edits and
 * sheet lines, on the scribe test book with a fake provider.
 */

type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let book: ScribeBook
/** The answer calls (`agent.v9`, streamed). */
let complete: ReturnType<typeof vi.fn<Complete>>
/** The quote checks (`cite.v1`), answered apart so the answer calls keep their order. */
let cite: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let steps: AgentStep[]

const said = (value: unknown, finishReason?: string): CompletionResult => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
  model: 'gpt-5.4',
  usage: { inputTokens: 600, outputTokens: 60 },
  ...(finishReason === undefined ? {} : { finishReason })
})

function replies(...values: unknown[]): void {
  for (const value of values) complete.mockResolvedValueOnce(said(value))
}

/** The checker's reply: verdicts by sentence number, and the scope. */
const verdicts = (v: string[], scope = 'none'): CompletionResult =>
  said({ v: v.map((ok, i) => ({ i: i + 1, ok })), scope })

const citeUser = (call: number): string => cite.mock.calls[call]?.[0].messages.at(-1)?.content ?? ''

const request = (call: number): CompletionRequest => {
  const value = complete.mock.calls[call]?.[0]
  if (!value) throw new Error(`no request ${call}`)
  return value
}

const lastUser = (call: number): string =>
  request(call)
    .messages.filter((message) => message.role === 'user')
    .at(-1)?.content ?? ''

const run = (over: Partial<ScribeInput> = {}): ReturnType<typeof runScribe> =>
  runScribe(
    book.db,
    deps,
    {
      nodeId: book.one,
      message: 'What did Orrin hear?',
      history: [],
      access: 'read',
      focus: { beforeCaret: '', selection: '' },
      navigation: null,
      ...over
    },
    (step) => steps.push(step),
    {},
    () => SCRIBE_NOW
  )

const counts = (): number[] =>
  [claim, card, reading].map((table) => book.db.select().from(table).all().length)

beforeEach(() => {
  resetInflight()
  resetVoiceProfileCache()
  book = scribeBook()
  indexBook(book.db, {
    scenes: [book.one, book.two, book.three],
    records: [book.mara, book.orrin, book.tomas, book.quay]
  })
  setAiSettings(book.db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  complete.mockResolvedValue(said({ answer: 'Done.', found: true, edits: [] }))
  cite = vi.fn<Complete>()
  cite.mockResolvedValue(said({ v: [], scope: 'none' }))
  ledger = []
  steps = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete: (req) =>
      req.messages[0]?.content.startsWith(CITE_SENTINEL) === true ? cite(req) : complete(req),
    stream: async function* (req) {
      const reply = await complete(req)
      const cut = Math.floor(reply.text.length / 2)
      yield { delta: reply.text.slice(0, cut) }
      yield {
        delta: reply.text.slice(cut),
        usage: reply.usage,
        ...(reply.finishReason === undefined ? {} : { finishReason: reply.finishReason })
      }
    },
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: { get: () => undefined, put: () => undefined },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(SCRIBE_NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => SCRIBE_NOW,
    price: priceFor
  }
})
afterEach(() => closeScribeBook(book))

describe('runScribe (F-16.25): the one answer call', () => {
  it('sends one agent.v9 request with E0 whole and Step 0’s evidence, reasoning off, 700 out', async () => {
    replies({
      answer: 'Orrin overheard Tomas. [E0 "Orrin overheard Tomas from the yard"]',
      found: true
    })
    const before = counts()
    const result = await run()
    expect(complete).toHaveBeenCalledTimes(1)
    const sent = request(0)
    expect(sent.messages[0]?.role).toBe('system')
    expect(sent.messages[0]?.content.startsWith(AGENT_V9_SENTINEL)).toBe(true)
    // A read run (Plan) has no edit list; the roster lists the names, never the secret.
    expect(sent.messages[0]?.content).not.toContain(AGENT_V9_EDIT_TOOLS)
    const roster = (sent.messages[0]?.content ?? '').split('Records (names and nicknames):\n')[1]
    expect(roster?.split('\n').sort()).toEqual(['Mara', 'Orrin', 'Tomas', 'the Quay'])
    expect(sent.messages[0]?.content).not.toContain('the sold map')
    const user = lastUser(0)
    expect(user).toContain('E0 [happened, the open scene 1.1] Scene')
    expect(user).toContain('¶0 Mara watched the quay with her grey eyes.')
    expect(user).toContain('¶2 Orrin overheard Tomas from the yard.')
    expect(user.endsWith('Question: What did Orrin hear?')).toBe(true)
    // No tool protocol: one call, no lookups.
    expect(user).not.toContain('"tool"')
    expect(sent.reasoning).toBe('off')
    expect(sent.maxTokens).toBe(700)
    // One answer call, then one quote check of the cited sentence.
    expect(ledger.map((entry) => entry.promptVersion)).toEqual(['agent.v9', 'cite.v1'])
    expect(cite).toHaveBeenCalledTimes(1)
    expect(steps).toEqual([{ tool: 'check', label: CHECKING_QUOTES }])
    // The kept citation's quote is in its item as sent.
    expect(result.answer).toBe('Orrin overheard Tomas.[1]')
    expect(result.scribe.citations).toEqual([
      {
        n: 1,
        evidence: 'E0',
        label: 'happened',
        ref: '1.1 ¶2',
        title: 'Scene 1',
        open: { kind: 'scene', id: book.one, para: 2 },
        quote: 'Orrin overheard Tomas from the yard',
        checked: 'quote'
      }
    ])
    expect(result.scribe).toMatchObject({ turn: 'answer', notFound: false, widened: null })
    expect(result.promptVersion).toBe('agent.v9')
    expect(result.query).toBeNull()
    // Rule 6: the chat never writes claims, cards or readings.
    expect(counts()).toEqual(before)
  })

  it('keeps a quote its item holds; drops a quote it does not and a map; marks naming sentences not checked', async () => {
    const anchor = cardAnchorOf(book.db, book.two)
    upsertCard(
      book.db,
      {
        nodeId: book.two,
        draftId: activeDraftId(book.db),
        readingId: null,
        line: 'Mara waits at the harbour.',
        gist: 'Short hair; the map is gone.',
        fields: emptyCardFields(),
        present: [],
        mood: null,
        theme: null,
        anchor,
        seen: anchor
      },
      SCRIBE_NOW
    )
    const navigation: Navigation = {
      turn: 'answer',
      evidence: [
        { kind: 'passage', source: 'scene', ownerId: book.two, para: 1 },
        { kind: 'card', nodeId: book.two }
      ],
      scope: null,
      terms: ['map'],
      hits: [{ nodeId: book.two, para: 1 }]
    }
    replies({
      answer:
        'Mara suspected it. [E1 "Mara suspected the map was gone"] ' +
        'She waited at the harbour. [E2 "Mara waits at the harbour"] ' +
        'Tomas was paid well. [E1 "Tomas was paid in gold"] ' +
        'You could show it sooner.',
      found: true
    })
    const result = await run({
      nodeId: book.three,
      message: 'Did Mara know the map was gone?',
      navigation
    })
    const user = lastUser(0)
    expect(user).toContain('E1 [happened, 1.2 ¶1] Two\nMara suspected the map was gone.')
    expect(user).toContain('E2 [map, not citable, 1.2] Two')
    expect(result.scribe.citations.map((c) => [c.evidence, c.quote, c.ref])).toEqual([
      ['E1', 'Mara suspected the map was gone', '1.2 ¶1']
    ])
    expect(result.answer).toBe(
      'Mara suspected it.[1] She waited at the harbour. Tomas was paid well. You could show it sooner.'
    )
    const spans = result.scribe.notChecked.map(([from, to]) => result.answer.slice(from, to))
    // The map's sentence and the bad quote's lose their citations and name nobody but a pronoun
    // and Tomas: only the sentence naming Tomas is marked; advice needs none.
    expect(spans).toEqual(['Tomas was paid well.'])
    expect(result.dropped).toBe(2)
    // The invariants hear every citation: none of them a card.
    expect(
      checkMemoryInvariants({
        claims: [],
        sceneHashes: new Map(),
        aliases: [],
        citations: result.scribe.citations.map((citation) => ({
          answerId: 'turn',
          target: citation.label === 'map' ? 'card' : 'passage',
          ref: citation.ref
        }))
      })
    ).toEqual([])
  })

  it('marks a found answer’s first sentence not checked when it keeps no citation', async () => {
    replies({ answer: 'He heard about the sale. Nothing more.', found: true })
    const result = await run()
    const spans = result.scribe.notChecked.map(([from, to]) => result.answer.slice(from, to))
    expect(spans).toEqual(['He heard about the sale.'])
  })

  it('never marks advice or a question back to the author as the main claim (P3-D13)', async () => {
    replies(
      { answer: 'You could open on the storm. Orrin waits at the yard.', found: true },
      { answer: 'Do you mean the yard? It is unclear.', found: true }
    )
    const advice = await run({ message: 'How should the scene open?' })
    const spans = advice.scribe.notChecked.map(([from, to]) => advice.answer.slice(from, to))
    expect(spans).toEqual(['Orrin waits at the yard.'])
    const asked = await run({ message: 'Where was it?' })
    expect(asked.scribe.notChecked).toEqual([])
  })

  it('refuses a quote under three words, the fact line above a claim, and a paragraph number', async () => {
    const [claimId] = seedClaims(
      book.db,
      book.one,
      [{ recordId: book.mara, slot: 'eyes', value: 'grey', quote: 'her grey eyes', para: 0 }],
      SCRIBE_NOW
    )
    replies({
      answer:
        'She watched the quay. [E1 "Mara watched the quay with her grey eyes"] ' +
        'Mara has grey eyes. [E1 "Mara · eyes: grey"] ' +
        'They are grey. [E1 "Mara"]',
      found: true
    })
    const result = await run({
      nodeId: book.three,
      message: 'What colour are Mara’s eyes?',
      navigation: {
        turn: 'answer',
        evidence: [{ kind: 'claim', claimId: claimId ?? '' }],
        scope: null,
        terms: [],
        hits: []
      }
    })
    // The app's own fact line is not the book, and one word proves nothing.
    expect(lastUser(0)).toContain('E1 [happened, 1.1 ¶0] Scene 1\nMara · eyes: grey\n')
    expect(result.scribe.citations.map((c) => [c.evidence, c.quote, c.ref])).toEqual([
      ['E1', 'Mara watched the quay with her grey eyes', '1.1 ¶0']
    ])
    expect(result.answer).toBe('She watched the quay.[1] Mara has grey eyes. They are grey.')
    const spans = result.scribe.notChecked.map(([from, to]) => result.answer.slice(from, to))
    expect(spans).toEqual(['Mara has grey eyes.'])
    expect(result.dropped).toBe(2)
  })

  it('asks once more with the larger cap after a cut-off reply, and says so when cut twice', async () => {
    complete.mockResolvedValueOnce(said('{"answer":"Orrin ov', 'length'))
    replies({
      answer: 'Orrin heard Tomas. [E0 "Orrin overheard Tomas from the yard"]',
      found: true
    })
    const ok = await run({ requestId: 'r-1' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(request(1).maxTokens).toBe(AGENT_RETRY_MAX_TOKENS)
    expect(ok.answer).toBe('Orrin heard Tomas.[1]')

    complete.mockReset()
    complete.mockResolvedValue(said('{"answer":"Orrin ov', 'length'))
    const cut = await run({ requestId: 'r-2' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(cut.answer).toBe(`${AGENT_CUT_OFF_MESSAGE} (Request r-2:step0:retry)`)
  })

  it('streams the answer with the citation markup held back', () => {
    const shown: string[] = []
    let resets = 0
    const stream = new ShownStream(
      (delta) => shown.push(delta),
      () => {
        resets += 1
        shown.length = 0
      }
    )
    for (const piece of ['Orrin heard ', 'it. [E0 "Orrin', ' overheard"] He ', 'left.']) {
      stream.feed(piece)
    }
    expect(shown.join('')).toBe('Orrin heard it. He left.')
    expect(resets).toBe(0)
  })

  it('reads a need, an answer, and a tool call as unreadable', () => {
    expect(readScribeReply('{"need":"chapter 9"}', 'stop')).toEqual({
      kind: 'need',
      need: 'chapter 9'
    })
    expect(readScribeReply('{"answer":"Yes.","found":true}', 'stop')).toEqual({
      kind: 'answer',
      answer: 'Yes.',
      found: true,
      edits: []
    })
    expect(readScribeReply('{"tool":"search","args":{}}', 'stop')).toEqual({
      kind: 'broken',
      reason: 'unreadable'
    })
  })

  it('takes the turn from the navigation, a Write this, an edit request, else an answer', () => {
    const cues = { change: false, sheetWrite: false }
    const base = { navigation: null, access: 'write' as const, message: 'Who is Orrin?' }
    expect(scribeTurnOf(base, cues)).toBe('answer')
    expect(scribeTurnOf({ ...base, access: 'read' }, { change: true, sheetWrite: false })).toBe(
      'answer'
    )
    expect(scribeTurnOf(base, { change: true, sheetWrite: false })).toBe('edit')
    expect(scribeTurnOf(base, { change: false, sheetWrite: true })).toBe('edit')
    expect(
      scribeTurnOf(
        { ...base, message: directionMessage({ title: 'The quay', text: 'She waits.' }) },
        cues
      )
    ).toBe('draft')
    expect(
      scribeTurnOf(
        {
          ...base,
          navigation: { turn: 'lookup', evidence: [], scope: null, terms: [], hits: [] }
        },
        cues
      )
    ).toBe('lookup')
  })

  it('an edit turn goes out with reasoning low, a larger cap, the voice block and ids on E0', async () => {
    replies({
      answer: 'A beat where Orrin keeps quiet.',
      found: true,
      edits: [{ edit: 'insert', id: 'n0', after: '', brief: 'Orrin says nothing.', words: 80 }]
    })
    await run({
      access: 'write',
      message: 'Add a beat where Orrin keeps quiet.',
      focus: { beforeCaret: 'Mara watched the quay with her grey eyes.', selection: '' }
    })
    const sent = request(0)
    expect(sent.reasoning).toBe('low')
    expect(sent.maxTokens).toBe(1_500 + SCRIBE_REASONING_TOKENS)
    expect(sent.messages[0]?.content).toContain(AGENT_V9_EDIT_TOOLS)
    const user = lastUser(0)
    expect(user).toMatch(/E0 \[happened, the open scene 1\.1, id n\d+ in n\d+\] Scene/)
    expect(user).toContain("The author's caret is in ¶0.")
    // The voice block leads the user turn on an edit turn only.
    expect(user.indexOf('E0 [')).toBeGreaterThan(0)
  })
})

describe('runScribe: Self-Route and search misses (P3-D15)', () => {
  it('widens once to the scene asked for and logs a miss outside the turn’s hits only', async () => {
    replies(
      { need: '1.2' },
      {
        answer:
          'She waited at the harbour. [W1 "Mara waited at the harbour"] ' +
          'She suspected it was gone. [W1 "Mara suspected the map was gone"] ' +
          'It was gone. [W1 "¶1 Mara suspected the map"]',
        found: true
      }
    )
    const result = await run({
      nodeId: book.three,
      message: 'Who waited at the harbour?',
      requestId: 'r-w',
      navigation: {
        turn: 'answer',
        evidence: [],
        scope: null,
        terms: ['waited', 'harbour'],
        hits: [{ nodeId: book.two, para: 0 }]
      }
    })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(steps).toEqual([
      { tool: 'read', label: 'Reading 1.2…' },
      { tool: 'check', label: CHECKING_QUOTES }
    ])
    const widened = lastUser(1)
    expect(widened).toContain(`${AGENT_V9_WIDENED_HEADING}, 1.2:`)
    expect(widened).toContain('W1 [happened, 1.2 ¶0–1] Two\n¶0 Mara waited at the harbour')
    expect(result.scribe.widened).toEqual({ ref: '1.2' })
    expect(result.scribe.citations.map((c) => c.ref)).toEqual(['1.2 ¶0', '1.2 ¶1'])
    // ¶0 was among the hits; ¶1 the search missed. A quote with the `¶1` prefix is no quote.
    expect(result.scribe.misses).toBe(1)
    expect(result.dropped).toBe(1)
    const misses = book.db.select().from(searchMiss).all()
    expect(misses.map((row) => [row.nodeId, row.para, row.quote])).toEqual([
      [book.two, 1, 'Mara suspected the map was gone']
    ])
    expect(ledger.map((entry) => entry.promptVersion)).toEqual(['agent.v9', 'agent.v9', 'cite.v1'])
  })

  it('answers Not found with the scope after a second need, and without asking for a need that names nothing', async () => {
    replies({ need: 'chapter 1' }, { need: 'chapter 2' })
    const twice = await run({ message: 'When does Mara first suspect Tomas?' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(twice.scribe.notFound).toBe(true)
    expect(
      twice.answer.startsWith('Not found in the manuscript (I looked in the open scene 1.1')
    ).toBe(true)

    complete.mockReset()
    replies({ need: 'chapter 40' })
    const nothing = await run({ message: 'What happens in chapter 40?' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(nothing.scribe.notFound).toBe(true)
    expect(book.db.select().from(searchMiss).all()).toEqual([])
  })

  it('makes no second call when the need names only the open scene', async () => {
    replies({ need: '1.1' })
    const result = await run({ message: 'What did Orrin hear?', requestId: 'r-open' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(steps).toEqual([])
    expect(result.scribe).toMatchObject({ notFound: true, widened: null })
  })

  it('reads a scene over the widen budget in part, around the turn’s hit, rather than skipping it', async () => {
    const long = Array.from({ length: 120 }, (_, i) =>
      `Line ${i}: Mara walked the harbour wall and counted the ships at anchor.`.repeat(4)
    )
    saveDocument(book.db, book.two, doc(...long))
    replies(
      { need: '1.2' },
      { answer: 'She counted ships. [W1 "Line 60: Mara walked the harbour wall"]', found: true }
    )
    const result = await run({
      nodeId: book.three,
      message: 'What did Mara count?',
      navigation: {
        turn: 'answer',
        evidence: [],
        scope: null,
        terms: ['count'],
        hits: [{ nodeId: book.two, para: 60 }]
      }
    })
    expect(complete).toHaveBeenCalledTimes(2)
    const widened = lastUser(1)
    expect(widened).toMatch(/W1 \[happened, 1\.2 ¶\d+–\d+\] Two\n/)
    expect(widened).toContain('¶60 Line 60:')
    expect(widened).not.toContain('¶0 Line 0:')
    expect(result.scribe.citations.map((c) => c.ref)).toEqual(['1.2 ¶60'])
  })

  it('a found:false answer says Not found with what it looked in', async () => {
    replies({ answer: 'The evidence does not say.', found: false })
    const result = await run({ message: 'What did Orrin eat?' })
    expect(result.scribe.notFound).toBe(true)
    expect(result.answer).toMatch(/^Not found in the manuscript \(I looked in the open scene 1\.1/)
  })
})

/** The id an item was sent under, from its tag in the user turn ("E3 [happened, 1.2 ¶1]"). */
const sentId = (user: string, ref: string): string => {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`(E\\d+) \\[[^\\]]*, ${escaped}\\]`, 'u').exec(user)
  if (match?.[1] === undefined) throw new Error(`no item at ${ref} in:\n${user}`)
  return match[1]
}

/** An answer's first sentence as the parser splits it. */
const splitFirst = (answer: string): string | undefined =>
  parseCitedAnswer(answer).sentences[0]?.text

describe('runScribe: the quote check, the scope and the one retry (P3 slice 3)', () => {
  const FIRST = 'When does Mara first suspect the map was gone?'

  it('follows a cited answer with exactly one cite.v1 request on the fast tier; yes is quote and sentence checked, partly quote only; costs summed', async () => {
    replies({
      answer:
        'Orrin overheard Tomas. [E0 "Orrin overheard Tomas from the yard"] ' +
        'Tomas sold it to a stranger. [E0 "Tomas sold the map to a stranger"]',
      found: true
    })
    cite.mockResolvedValueOnce(verdicts(['yes', 'partly']))
    const result = await run({ requestId: 'r-c' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(cite).toHaveBeenCalledTimes(1)
    const check = cite.mock.calls[0]?.[0]
    expect(check?.tier).toBe('fast')
    // Reasoning off: a direct OpenAI key is asked for its lowest effort (P3-D21).
    expect(check?.lowestEffort).toBe(true)
    // Two sentences, no scope item: 20 + 10 × 2.
    expect(check?.maxTokens).toBe(40)
    expect(check?.messages[0]?.content.startsWith(CITE_SENTINEL)).toBe(true)
    const user = citeUser(0)
    expect(user.startsWith('Question: What did Orrin hear?')).toBe(true)
    // Each quote in its sentence with one either side, across the scene's paragraphs.
    expect(user).toContain(
      '1. Orrin overheard Tomas.\nE0 [happened, the open scene 1.1 ¶2] “Orrin overheard Tomas from the yard” in: ' +
        'Tomas sold the map to a stranger. Orrin overheard Tomas from the yard.'
    )
    expect(user).toContain(
      '2. Tomas sold it to a stranger.\nE0 [happened, the open scene 1.1 ¶1] “Tomas sold the map to a stranger” in: ' +
        'Mara watched the quay with her grey eyes. Tomas sold the map to a stranger. Orrin overheard Tomas from the yard.'
    )
    expect(user).not.toContain('Scope:')
    expect(result.scribe.citations.map((c) => [c.n, c.checked])).toEqual([
      [1, 'cite'],
      [2, 'quote']
    ])
    expect(result.scribe).toMatchObject({ retried: false, notFound: false, unsupported: [] })
    expect(steps).toEqual([{ tool: 'check', label: CHECKING_QUOTES }])
    // The turn's cost is both calls'.
    expect(ledger.map((entry) => [entry.promptVersion, entry.feature, entry.model])).toEqual([
      ['agent.v9', 'agent', 'gpt-5.4'],
      ['cite.v1', 'cite', 'gpt-5.4-mini']
    ])
    expect(result.usage).toEqual({ inputTokens: 1_200, outputTokens: 120 })
    expect(result.costUsd).toBeCloseTo(
      ledger.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0),
      10
    )
    expect(result.costUsd).toBeGreaterThan(ledger[0]?.costUsd ?? 0)
    // The answer's own model names the turn.
    expect(result.model).toBe('gpt-5.4')
  })

  it('makes no cite call when nothing was cited, nor with its switch off', async () => {
    replies({ answer: 'You could open on the storm.', found: true })
    const advice = await run({ message: 'How should the scene open?' })
    expect(cite).not.toHaveBeenCalled()
    expect(steps).toEqual([])
    expect(advice.answer).toBe('You could open on the storm.')

    setAiSettings(book.db, {
      ...defaultAiSettings(),
      dial: 1,
      features: { ...defaultAiSettings().features, cite: false }
    })
    replies({
      answer: 'Orrin overheard Tomas. [E0 "Orrin overheard Tomas from the yard"]',
      found: true
    })
    const off = await run()
    expect(cite).not.toHaveBeenCalled()
    expect(off.scribe.citations.map((c) => c.checked)).toEqual(['quote'])
  })

  it('drops the citations of a sentence found unsupported and marks it, keeping the rest', async () => {
    replies({
      answer:
        'Orrin overheard Tomas. [E0 "Orrin overheard Tomas from the yard"] ' +
        'Orrin sold the map. [E0 "Tomas sold the map to a stranger"]',
      found: true
    })
    cite.mockResolvedValueOnce(verdicts(['yes', 'no']))
    const result = await run()
    expect(result.answer).toBe('Orrin overheard Tomas.[1] Orrin sold the map.')
    expect(result.scribe.citations.map((c) => c.quote)).toEqual([
      'Orrin overheard Tomas from the yard'
    ])
    const spans = result.scribe.unsupported.map(([from, to]) => result.answer.slice(from, to))
    expect(spans).toEqual(['Orrin sold the map.'])
    expect(result.scribe.retried).toBe(false)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('asks once more when the main claim is unsupported, and keeps the second answer when it holds', async () => {
    replies(
      { answer: 'Orrin sold the map. [E0 "Tomas sold the map to a stranger"]', found: true },
      { answer: 'Tomas sold the map. [E0 "Tomas sold the map to a stranger"]', found: true }
    )
    cite.mockResolvedValueOnce(verdicts(['no'])).mockResolvedValueOnce(verdicts(['yes']))
    const resets: number[] = []
    const result = await runScribe(
      book.db,
      deps,
      {
        nodeId: book.one,
        message: 'Who sold the map?',
        history: [],
        access: 'read',
        focus: { beforeCaret: '', selection: '' },
        navigation: null,
        requestId: 'r-retry'
      },
      (step) => steps.push(step),
      { reset: () => resets.push(1) },
      () => SCRIBE_NOW
    )
    expect(complete).toHaveBeenCalledTimes(2)
    expect(cite).toHaveBeenCalledTimes(2)
    // The retry is the same prompt with the first sentence quoted back and why.
    const retry = request(1).messages
    expect(retry.slice(0, -1)).toEqual(request(0).messages)
    expect(retry.at(-1)).toEqual({
      role: 'user',
      content: agentV9UnsupportedTurn('Orrin sold the map.', 'quotesDoNotSay')
    })
    expect(resets.length).toBeGreaterThanOrEqual(1)
    expect(result.answer).toBe('Tomas sold the map.[1]')
    expect(result.scribe).toMatchObject({ retried: true, notFound: false })
    expect(result.scribe.citations.map((c) => c.checked)).toEqual(['cite'])
    expect(steps).toEqual([
      { tool: 'check', label: CHECKING_QUOTES },
      { tool: 'check', label: CHECKING_QUOTES }
    ])
    expect(ledger.map((entry) => entry.promptVersion)).toEqual([
      'agent.v9',
      'cite.v1',
      'agent.v9',
      'cite.v1'
    ])
    expect(result.usage.inputTokens).toBe(2_400)
  })

  it('a main claim with no citation is asked again without a check; still unsupported, it reads Not found with the open scene, the cited scenes and the search', async () => {
    replies(
      { answer: 'Orrin sold the map.', found: true },
      { answer: 'Orrin sold the map. [E0 "Tomas sold the map to a stranger"]', found: true }
    )
    cite.mockResolvedValueOnce(verdicts(['no']))
    const result = await run({ message: 'Who sold the map?' })
    expect(complete).toHaveBeenCalledTimes(2)
    // The first answer cited nothing: no check, straight to the retry; the second is checked.
    expect(cite).toHaveBeenCalledTimes(1)
    expect(request(1).messages.at(-1)?.content).toBe(
      agentV9UnsupportedTurn('Orrin sold the map.', 'noCitation')
    )
    expect(result.answer).toMatch(/^Not found in the manuscript \(I looked in the open scene 1\.1/u)
    expect(result.scribe).toMatchObject({ notFound: true, retried: true, citations: [] })

    // An ordinal question at 1.3: the line names the open scene, the scene cited and the search.
    complete.mockReset()
    cite.mockReset()
    replies({ answer: 'x', found: true })
    await run({ nodeId: book.three, message: FIRST })
    const at = sentId(lastUser(0), '1.2 ¶1')
    complete.mockReset()
    cite.mockReset()
    const claim = {
      answer: `Mara first suspects it in 1.2, searching every scene up to 1.3. [${at} "Mara suspected the map was gone"]`,
      found: true
    }
    replies(claim, claim)
    cite.mockResolvedValue(verdicts(['no'], 'ok'))
    const ordinal = await run({ nodeId: book.three, message: FIRST })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(cite).toHaveBeenCalledTimes(2)
    expect(ordinal.answer).toMatch(
      /^Not found in the manuscript \(I looked in the open scene 1\.3, scenes? 1\.2(?:,| and)[^)]*and searched every scene up to 1\.3 for /u
    )
    expect(ordinal.scribe).toMatchObject({ notFound: true, retried: true })
  })

  it('sends the scope item of a first answer with the earlier passages the search found, and asks again when one shows it earlier', async () => {
    replies({ answer: 'x', found: true })
    await run({ nodeId: book.three, message: FIRST })
    const at = sentId(lastUser(0), '1.2 ¶1')
    complete.mockReset()
    replies(
      {
        answer:
          'Mara first suspects it in 1.3, searching every scene up to 1.3. [E0 "Mara learned the map was sold"]',
        found: true
      },
      {
        answer: `Mara first suspects it in 1.2, searching every scene up to 1.3. [${at} "Mara suspected the map was gone"]`,
        found: true
      }
    )
    cite
      .mockResolvedValueOnce(verdicts(['yes'], 'earlier'))
      .mockResolvedValueOnce(verdicts(['yes'], 'ok'))
    const result = await run({ nodeId: book.three, message: FIRST })
    const scope = citeUser(0)
    expect(scope).toContain('Scope: searched every scene up to 1.3 for ')
    expect(scope).toContain('It cites 1.3.\nPassages the search found before 1.3:\n')
    expect(scope).toContain('- 1.2 ¶1: Mara suspected the map was gone.')
    expect(scope.indexOf('- 1.1 ¶')).toBeLessThan(scope.indexOf('- 1.2 ¶1'))
    // 20 + 10 for the sentence + 20 for the scope.
    expect(cite.mock.calls[0]?.[0].maxTokens).toBe(50)
    expect(request(1).messages.at(-1)?.content).toBe(
      agentV9UnsupportedTurn(
        'Mara first suspects it in 1.3, searching every scene up to 1.3.',
        'earlier'
      )
    )
    expect(result.scribe.citations.map((c) => [c.ref, c.checked])).toEqual([['1.2 ¶1', 'cite']])
    expect(result.scribe).toMatchObject({ retried: true, notFound: false })
    expect(result.scribe.scope).toMatch(/^Searched every scene up to 1\.3 for /u)
  })

  it('asks again when a first answer does not say what was searched; an answer that found nothing stands on its scope', async () => {
    replies({ answer: 'x', found: true })
    await run({ nodeId: book.three, message: FIRST })
    const at = sentId(lastUser(0), '1.2 ¶1')
    complete.mockReset()
    replies(
      {
        answer: `Mara first suspects it in 1.2. [${at} "Mara suspected the map was gone"]`,
        found: true
      },
      {
        answer: `Mara first suspects it in 1.2, searching every scene up to 1.3. [${at} "Mara suspected the map was gone"]`,
        found: true
      }
    )
    const asked = await run({ nodeId: book.three, message: FIRST })
    expect(request(1).messages.at(-1)?.content).toBe(
      agentV9UnsupportedTurn('Mara first suspects it in 1.2.', 'noScope')
    )
    // Only the second answer was checked.
    expect(cite).toHaveBeenCalledTimes(1)
    expect(asked.scribe.retried).toBe(true)

    // An answer that found nothing and cites nothing is still checked on its scope (design rule
    // 5): every passage the search found, the earliest first, and no sentence.
    complete.mockReset()
    cite.mockReset()
    cite.mockResolvedValue(verdicts([], 'ok'))
    const absence =
      'I found no scene where Mara first suspects it (searched every scene up to 1.3).'
    replies({ answer: absence, found: true })
    const none = await run({ nodeId: book.three, message: FIRST })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(cite).toHaveBeenCalledTimes(1)
    const check = citeUser(0)
    expect(check).toMatch(/^Question: [^\n]+\nNow: 1\.3\n\nScope: searched every scene up to 1\.3/u)
    expect(check).toContain('Passages the search found:\n- 1.1 ¶')
    expect(check).toContain('- 1.2 ¶1: Mara suspected the map was gone.')
    expect(check).not.toMatch(/^1\. /mu)
    expect(cite.mock.calls[0]?.[0].maxTokens).toBe(40)
    expect(none.scribe).toMatchObject({ retried: false, notFound: false })
    expect(none.answer).toBe(absence)

    // When a passage the search found shows it, the answer is asked again, then reads Not found.
    complete.mockReset()
    cite.mockReset()
    cite.mockResolvedValue(verdicts([], 'earlier'))
    replies({ answer: absence, found: true }, { answer: absence, found: true })
    const shown = await run({ nodeId: book.three, message: FIRST })
    expect(request(1).messages.at(-1)?.content).toBe(
      agentV9UnsupportedTurn(absence, 'notFoundShown')
    )
    expect(shown.scribe).toMatchObject({ retried: true, notFound: true })
  })

  it('widens a navigation that searched less than every earlier scene before the answer is sent', async () => {
    const narrow: Navigation = {
      turn: 'answer',
      evidence: [],
      scope: { from: '1.3', to: '1.3', allEarlier: false, wholeBook: false, terms: ['suspect'] },
      terms: ['suspect'],
      hits: []
    }
    replies({ answer: 'I found nothing (searched).', found: false })
    await run({ nodeId: book.three, message: FIRST, navigation: narrow })
    const user = lastUser(0)
    expect(user).toMatch(/\nSearched every scene up to 1\.3 for [^\n]+\.\n\nQuestion: /u)
    expect(user).toContain('[happened, 1.2 ¶1]')
    expect(steps[0]).toMatchObject({ tool: 'search' })
    expect(steps[0]?.label).toMatch(/^Searching every scene up to 1\.3 for /u)

    // A navigation that covered every earlier scene is sent as it is.
    complete.mockReset()
    steps.length = 0
    replies({ answer: 'I found nothing (searched).', found: false })
    await run({
      nodeId: book.three,
      message: FIRST,
      navigation: {
        ...narrow,
        scope: { from: '1.1', to: '1.3', allEarlier: true, wholeBook: false, terms: ['suspect'] }
      }
    })
    expect(lastUser(0)).toContain('Searched every scene up to 1.3 for suspect.')
    expect(lastUser(0)).not.toContain('[happened, 1.2 ¶1]')
    expect(steps).toEqual([])
  })

  it('never costs the author the answer: a failed check leaves the citations quote-checked', async () => {
    replies({
      answer: 'Orrin overheard Tomas. [E0 "Orrin overheard Tomas from the yard"]',
      found: true
    })
    cite.mockRejectedValueOnce(new Error('boom'))
    const result = await run()
    expect(result.answer).toBe('Orrin overheard Tomas.[1]')
    expect(result.scribe.citations.map((c) => c.checked)).toEqual(['quote'])
    expect(result.scribe.retried).toBe(false)
  })

  it('writes no claim, card or reading on any of these paths (rule 6)', async () => {
    const before = counts()
    replies(
      { answer: 'Orrin sold the map.', found: true },
      { answer: 'Orrin sold the map.', found: true }
    )
    await run({ message: 'Who sold the map?' })
    expect(counts()).toEqual(before)
  })
})

describe('runScribe: which answers the main-claim rule holds (P3 slice 3 review)', () => {
  const spans = (result: {
    answer: string
    scribe: { notChecked: [number, number][] }
  }): string[] => result.scribe.notChecked.map(([from, to]) => result.answer.slice(from, to))

  it('keeps an uncited opinion, what-if or brainstorm answer, marked not checked, with one call', async () => {
    const cases: { access: 'read' | 'write'; message: string; answer: string }[] = [
      {
        access: 'read',
        message: 'Is Mara likeable in this scene?',
        answer: 'Mara comes across as guarded but sympathetic here.'
      },
      {
        access: 'write',
        message: 'What if Mara never found the map?',
        answer:
          'If Mara never found the map, Orrin would have no reason to follow Tomas to the quay.'
      },
      {
        access: 'write',
        message: 'How could Mara get off the ship?',
        answer:
          'Mara could slip out through the cellar while Tomas distracts the guard. Or she could bribe Orrin.'
      }
    ]
    for (const each of cases) {
      complete.mockReset()
      replies({ answer: each.answer, found: true })
      const result = await run({ access: each.access, message: each.message })
      expect(complete).toHaveBeenCalledTimes(1)
      expect(result.answer).toBe(each.answer)
      expect(result.scribe).toMatchObject({ retried: false, notFound: false })
      expect(spans(result)[0]).toBe(splitFirst(each.answer))
    }
    // A hedged sentence in a factual answer is not retried either; a plain uncited claim is.
    complete.mockReset()
    replies({ answer: 'Orrin might have sold it.', found: true })
    expect((await run({ message: 'Who sold the map?' })).scribe.retried).toBe(false)
    complete.mockReset()
    replies({ answer: 'Orrin sold it.', found: true }, { answer: 'Orrin sold it.', found: true })
    expect((await run({ message: 'Who sold the map?' })).scribe).toMatchObject({
      retried: true,
      notFound: true
    })
  })

  it('checks a Plan request for a sheet line or a change as a change turn: its words kept, one call', async () => {
    replies({
      answer: 'That line belongs on Mara\'s Pinned page: "Hates the sea".',
      found: true,
      edits: [{ edit: 'pin', name: 'Mara', text: 'Hates the sea', place: 'pinned' }]
    })
    const pin = await run({ message: 'Add to Mara’s sheet that she hates the sea.' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(pin.answer).toBe(
      `That line belongs on Mara's Pinned page: "Hates the sea".\n\n${PLAN_NO_PIN}`
    )
    expect(pin.scribe).toMatchObject({ retried: false, notFound: false })

    complete.mockReset()
    replies({
      answer: "Mara's second line repeats her first, so I would cut it.",
      found: true,
      edits: [{ edit: 'text', id: 'n1', find: 'Mara watched', replace: '' }]
    })
    const edit = await run({ message: 'Tighten Mara’s dialogue in this scene.' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(edit.answer).toBe(
      `Mara's second line repeats her first, so I would cut it.\n\n${PLAN_NO_EDIT}`
    )
    expect(edit.scribe).toMatchObject({ retried: false, notFound: false })
  })

  it('reads the claim after a bare "Yes." as the main claim: checked, retried when the check says no', async () => {
    replies({
      answer: 'Yes. Orrin overheard Tomas. [E0 "Orrin overheard Tomas from the yard"]',
      found: true
    })
    cite.mockResolvedValueOnce(verdicts(['yes']))
    const held = await run({ message: 'Did Orrin hear Tomas?' })
    expect(held.answer).toBe('Yes. Orrin overheard Tomas.[1]')
    expect(held.scribe.notChecked).toEqual([])
    expect(held.scribe).toMatchObject({ retried: false, notFound: false })

    complete.mockReset()
    cite.mockReset()
    const sold = {
      answer: 'Yes. Orrin sold the map. [E0 "Tomas sold the map to a stranger"]',
      found: true
    }
    replies(sold, sold)
    cite.mockResolvedValue(verdicts(['no']))
    const result = await run({ message: 'Did Orrin sell the map?' })
    expect(request(1).messages.at(-1)?.content).toBe(
      agentV9UnsupportedTurn('Yes. Orrin sold the map.', 'quotesDoNotSay')
    )
    expect(result.scribe).toMatchObject({ retried: true, notFound: true })
  })

  it('never lets "does not know" stand as a fact: asked again, then Not found; a scoped absence stands', async () => {
    const knows = 'Does Tomas know about the sold map?'
    const answers = [
      'No. Tomas does not know about the map.',
      'Orrin does not know that Tomas sold the map. [E0 "Tomas sold the map to a stranger"]',
      'Tomas never learns about the map.',
      'No.'
    ]
    for (const answer of answers) {
      complete.mockReset()
      cite.mockReset()
      cite.mockResolvedValue(verdicts(['yes']))
      replies({ answer, found: true }, { answer, found: true })
      const result = await run({ message: knows })
      expect(complete).toHaveBeenCalledTimes(2)
      expect(request(1).messages.at(-1)?.content).toContain(UNSUPPORTED_REASONS.absence)
      expect(result.scribe).toMatchObject({ retried: true, notFound: true })
    }
    // Later in an answer, the sentence is marked unsupported (its citation dropped), no retry.
    complete.mockReset()
    cite.mockReset()
    cite.mockResolvedValue(verdicts(['yes', 'yes']))
    replies({
      answer:
        'Orrin overheard Tomas. [E0 "Orrin overheard Tomas from the yard"] ' +
        'Mara does not know about the map. [E0 "Tomas sold the map to a stranger"]',
      found: true
    })
    const later = await run({ message: 'What did Orrin hear?' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(later.answer).toBe('Orrin overheard Tomas.[1] Mara does not know about the map.')
    expect(later.scribe.unsupported.map(([from, to]) => later.answer.slice(from, to))).toEqual([
      'Mara does not know about the map.'
    ])

    complete.mockReset()
    cite.mockReset()
    cite.mockResolvedValue(verdicts([], 'ok'))
    const scoped = 'No. I found no scene where Tomas learns of the sale (searched 1.1).'
    replies({ answer: scoped, found: true })
    const stands = await run({ message: knows })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(stands.answer).toBe(scoped)
  })

  it('a retry that fails ends Not found, never the turn; a cancel still stops it', async () => {
    replies({ answer: 'Orrin sold the map.', found: true })
    complete.mockRejectedValueOnce(new Error('429 rate limited'))
    const notes: string[] = []
    const result = await runScribe(
      book.db,
      deps,
      {
        nodeId: book.one,
        message: 'Who sold the map?',
        history: [],
        access: 'read',
        focus: { beforeCaret: '', selection: '' },
        navigation: null,
        requestId: 'r-fail'
      },
      (each) => steps.push(each),
      { note: (id, text) => notes.push(`${id}: ${text}`) },
      () => SCRIBE_NOW
    )
    expect(complete).toHaveBeenCalledTimes(2)
    expect(result.answer).toMatch(/^Not found in the manuscript \(I looked in the open scene 1\.1/u)
    expect(result.scribe).toMatchObject({ retried: true, notFound: true })
    expect(notes.some((note) => note.startsWith('r-fail:step1: The retry failed (429'))).toBe(true)

    complete.mockReset()
    replies({ answer: 'Orrin sold the map.', found: true })
    complete.mockRejectedValueOnce(new AiCancelledError('The request was stopped.'))
    await expect(run({ message: 'Who sold the map?' })).rejects.toBeInstanceOf(AiCancelledError)
  })

  it('a retry cut off twice, or asking for a chapter, ends Not found with both calls counted', async () => {
    replies({ answer: 'Orrin sold the map.', found: true })
    complete.mockResolvedValueOnce(said('{"answer":"Orrin s', 'length'))
    complete.mockResolvedValueOnce(said('{"answer":"Orrin s', 'length'))
    const cut = await run({ message: 'Who sold the map?' })
    expect(complete).toHaveBeenCalledTimes(3)
    expect(cut.scribe).toMatchObject({ retried: true, notFound: true })
    expect(cut.usage.inputTokens).toBe(1_800)

    complete.mockReset()
    replies({ answer: 'Orrin sold the map.', found: true }, { need: 'chapter 1' })
    const need = await run({ message: 'Who sold the map?' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(need.answer).toMatch(/^Not found in the manuscript/u)
    expect(need.scribe).toMatchObject({ retried: true, notFound: true })
    expect(need.usage.inputTokens).toBe(1_200)
  })

  it('over the cost cap: no quote check and no retry; an unsupported main claim reads Not found', async () => {
    const dear = (value: unknown): CompletionResult => ({
      ...said(value),
      usage: { inputTokens: 2_000_000, outputTokens: 60 }
    })
    complete.mockResolvedValueOnce(
      dear({
        answer: 'Orrin overheard Tomas. [E0 "Orrin overheard Tomas from the yard"]',
        found: true
      })
    )
    const cited = await run()
    expect(cited.costUsd).toBeGreaterThan(AGENT_COST_CAP_USD)
    expect(cite).not.toHaveBeenCalled()
    expect(cited.answer).toBe('Orrin overheard Tomas.[1]')
    expect(cited.scribe.citations.map((c) => c.checked)).toEqual(['quote'])

    complete.mockReset()
    complete.mockResolvedValueOnce(dear({ answer: 'Orrin sold the map.', found: true }))
    const uncited = await run({ message: 'Who sold the map?' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(uncited.scribe).toMatchObject({ retried: false, notFound: true })
  })

  it('lists the earlier paragraphs of the cited passage’s own scene in the scope item', async () => {
    const navigation: Navigation = {
      turn: 'answer',
      evidence: [{ kind: 'passage', source: 'scene', ownerId: book.two, para: 1 }],
      scope: { from: '1.1', to: '1.3', allEarlier: true, wholeBook: false, terms: ['map'] },
      terms: ['map'],
      hits: [
        { nodeId: book.two, para: 0 },
        { nodeId: book.two, para: 1 },
        { nodeId: book.one, para: 1 }
      ]
    }
    replies({
      answer:
        'Mara first suspects it in 1.2, searching every scene up to 1.3. [E1 "Mara suspected the map was gone"]',
      found: true
    })
    cite.mockResolvedValueOnce(verdicts(['yes'], 'ok'))
    await run({
      nodeId: book.three,
      message: 'When does Mara first suspect the map was gone?',
      navigation
    })
    const check = citeUser(0)
    expect(check).toContain('Passages the search found before 1.2:')
    expect(check).toContain('- 1.1 ¶1:')
    expect(check).toContain('- 1.2 ¶0:')
    expect(check).not.toContain('- 1.2 ¶1:')
  })
})

describe('runScribe: edits and sheet lines (F-16.26, P3-D16)', () => {
  it('turns pins into sheet lines and says why one cannot be offered', async () => {
    savePage(book.db, book.mara, 'pinned', doc('Hates the sea'), SCRIBE_NOW)
    const message =
      'Add these to the sheets: Orrin keeps a knife, Tomas maybe has a twin, the Quay smells of ' +
      'tar, Mara hates the sea, the Bell is cracked, the sold map went twice.'
    replies({
      answer: 'Done.',
      found: true,
      edits: [
        { edit: 'pin', name: 'Orrin', text: 'Keeps a knife in his boot', place: 'pinned' },
        { edit: 'pin', name: 'Tomas', text: 'Maybe he has a twin', place: 'ideas' },
        { edit: 'pin', name: 'the Quay', text: 'Smells of tar', place: 'ask' },
        { edit: 'pin', name: 'Bell', text: 'Cracked', place: 'pinned' },
        { edit: 'pin', name: 'the sold map', text: 'Sold twice', place: 'pinned' },
        { edit: 'pin', name: 'Mara', text: 'Hates the sea', place: 'pinned' },
        { edit: 'tag', id: 'n1', tag: 'quay', add: true }
      ]
    })
    const before = counts()
    const result = await run({ access: 'write', requestId: 'r-pin', message })
    expect(result.changes.map((change) => change.edit)).toEqual([
      {
        kind: 'sheetLine',
        recordId: book.orrin,
        name: 'Orrin',
        place: 'pinned',
        text: 'Keeps a knife in his boot',
        turn: 'r-pin'
      },
      {
        kind: 'sheetLine',
        recordId: book.tomas,
        name: 'Tomas',
        place: 'ideas',
        text: 'Maybe he has a twin',
        turn: 'r-pin'
      },
      {
        kind: 'sheetLine',
        recordId: book.quay,
        name: 'the Quay',
        place: null,
        text: 'Smells of tar',
        turn: 'r-pin'
      }
    ])
    expect(result.answer).toBe(
      `Done.\n\n${PIN_NO_RECORD('Bell')} ${PIN_TOPIC('the sold map')} ${PIN_SAID('Mara', 'pinned')}`
    )
    // The pins not offered and the tag edit v2 never offers.
    expect(result.dropped).toBe(4)
    // Offered, never written: the renderer writes a line when it lands.
    expect(counts()).toEqual(before)
  })

  it('offers a sheet line only when the message asks for one, on a record it names, by its whole name', async () => {
    const pin = (name: string): Record<string, string> => ({
      edit: 'pin',
      name,
      text: 'Limps on the left',
      place: 'pinned'
    })
    // A plain question: a pin in the reply is never offered (decision 3: only an explicit ask).
    replies({ answer: 'He heard the sale.', found: true, edits: [pin('Orrin')] })
    const plain = await run({ access: 'write', message: 'What did Orrin hear?' })
    expect(plain.changes).toEqual([])
    expect(plain.answer).toBe(`He heard the sale.\n\n${PIN_NOT_ASKED}`)
    // Asked for Orrin's sheet: a pin on Tomas is not offered.
    replies({ answer: 'Done.', found: true, edits: [pin('Orrin'), pin('Tomas')] })
    const other = await run({ access: 'write', message: 'Add to Orrin’s sheet that he limps.' })
    expect(other.changes.map((change) => change.edit)).toEqual([
      expect.objectContaining({ kind: 'sheetLine', recordId: book.orrin })
    ])
    expect(other.answer).toBe(`Done.\n\n${PIN_NOT_NAMED('Tomas')}`)
    // A part of a name is no record's name: "Rin" is not Orrin, "Tom" not Tomas.
    replies({ answer: 'Done.', found: true, edits: [pin('Rin'), pin('Tom')] })
    const part = await run({ access: 'write', message: 'Add to the sheets that they limp.' })
    expect(part.changes).toEqual([])
    expect(part.answer).toBe(`Done.\n\n${PIN_NO_RECORD('Rin')} ${PIN_NO_RECORD('Tom')}`)
  })

  it('keeps an edit turn’s own words when it sets found false, and says it has a change when it has none', async () => {
    const id = loadAgentProject(book.db, book.one, 'v2').refOf.get(book.one)
    const insert = { edit: 'insert', id, after: '', brief: 'Orrin says nothing.', words: 80 }
    replies(
      { answer: 'I added a quiet beat.', found: false, edits: [insert] },
      { answer: '', found: false, edits: [insert] }
    )
    const message = 'Add a beat where Orrin keeps quiet.'
    const worded = await run({ access: 'write', message })
    expect(worded.scribe.notFound).toBe(false)
    expect(worded.answer).toBe('I added a quiet beat.')
    expect(worded.scribe.notChecked).toEqual([])
    expect(worded.changes).toHaveLength(1)
    const bare = await run({ access: 'write', message })
    expect(bare.answer).toBe(CHANGE_READY)
  })

  it('drops every edit on a read run (Plan) and says Plan writes nothing', async () => {
    replies({
      answer: "I would add that to Mara's sheet.",
      found: true,
      edits: [{ edit: 'pin', name: 'Mara', text: 'Hates the sea', place: 'pinned' }]
    })
    const result = await run({ message: 'Add to Mara’s sheet that she hates the sea.' })
    expect(result.changes).toEqual([])
    expect(result.dropped).toBe(1)
    expect(result.answer).toBe(`I would add that to Mara's sheet.\n\n${PLAN_NO_PIN}`)
    expect(request(0).messages[0]?.content).not.toContain(AGENT_V9_EDIT_TOOLS)
  })
})

describe('pinRecordOf (identity rules)', () => {
  const record = (
    id: string,
    names: { text: string; isMain: boolean; caseRule?: 'auto' | 'exact' }[]
  ): StoryRecordSummary => ({
    id,
    categoryId: 'character',
    kind: 'character',
    name: names.find((each) => each.isMain)?.text ?? '',
    image: null,
    origin: 'author',
    aliases: names.map((each, i) => ({
      id: `${id}-${i}`,
      recordId: id,
      text: each.text,
      norm: normName(each.text),
      isMain: each.isMain,
      caseRule: each.caseRule ?? 'auto',
      origin: 'author',
      shared: true,
      created: '2026-10-13T00:00:00.000Z'
    })),
    created: '2026-10-13T00:00:00.000Z',
    modified: '2026-10-13T00:00:00.000Z'
  })
  const records = [
    record('joanna', [
      { text: 'Joanna Harrow', isMain: true },
      { text: 'Jo', isMain: false }
    ]),
    record('will', [{ text: 'Will', isMain: true, caseRule: 'exact' }]),
    record('harrow', [
      { text: 'Mr. Harrow', isMain: true },
      { text: 'Harrow', isMain: false }
    ]),
    record('father', [{ text: 'Harrow', isMain: true }])
  ]

  it('takes a whole name or nickname only, in its exact case where the name asks for it', () => {
    expect(pinRecordOf(records, 'Jo')).toMatchObject({ id: 'joanna' })
    expect(pinRecordOf(records, 'joanna harrow')).toMatchObject({ id: 'joanna' })
    expect(pinRecordOf(records, 'Ann')).toBeUndefined()
    expect(pinRecordOf(records, 'Joanna')).toBeUndefined()
    expect(pinRecordOf(records, 'Will')).toMatchObject({ id: 'will' })
    expect(pinRecordOf(records, 'will')).toBeUndefined()
  })

  it('a name two records hold is the one whose own name it is, else no one’s', () => {
    expect(pinRecordOf(records, 'Harrow')).toMatchObject({ id: 'father' })
    const shared = [
      record('harrow', [
        { text: 'Mr. Harrow', isMain: true },
        { text: 'Harrow', isMain: false }
      ]),
      record('aunt', [
        { text: 'Aunt Harrow', isMain: true },
        { text: 'Harrow', isMain: false }
      ])
    ]
    expect(pinRecordOf(shared, 'Harrow')).toBe('ambiguous')
  })
})

describe('fitScribePrompt (token rule 8)', () => {
  const item = (id: string, words: number): EvidenceItem => ({
    id,
    key: { kind: 'outline' },
    label: 'happened',
    ref: '1.1 ¶0',
    title: id,
    text: `${id} ${'word '.repeat(words)}`.trim(),
    quotable: [],
    citable: true,
    open: null,
    doc: null
  })
  const base = {
    access: 'write' as const,
    turn: 'edit' as const,
    roster: ['Mara'],
    scene: `E0 [happened, the open scene 1.1] Scene\n¶0 ${'quay '.repeat(400)}`,
    searched: null,
    question: 'Tighten the quay paragraph.'
  }
  const fit = (budget: number): ReturnType<typeof fitScribePrompt> =>
    fitScribePrompt({
      base,
      evidence: [item('E1', 200), item('E2', 200), item('E3', 200)],
      evidenceBudget: 3_000,
      history: [
        { role: 'user', content: `Old ${'turn '.repeat(100)}` },
        { role: 'assistant', content: `Newer ${'turn '.repeat(100)}` }
      ],
      widened: { what: '1.2', items: [item('W1', 200), item('W2', 200)] },
      voice: { full: `Voice ${'rule '.repeat(200)}`, bare: 'Voice' },
      budget
    })

  it('keeps the retries within the cap, whatever the fit trimmed', () => {
    const size = (built: { messages: { content: string }[] }): number =>
      estimateTokens(built.messages.map((message) => message.content).join('\n'))
    const whole = size(fit(24_000).built)
    for (let budget = whole + 40; budget > whole - 2_000; budget -= 7) {
      const fitted = fit(budget)
      if (fitted.sent.length === 0 && fitted.input.history.length === 0) continue
      expect(size(buildAgentPromptV9({ ...fitted.input, retry: true }))).toBeLessThanOrEqual(budget)
      // The main-claim retry (P3-D14), and its own cut-off retry, fit too.
      const unsupported = { sentence: 'Orrin '.repeat(80), reason: 'noScope' as const }
      expect(
        size(buildAgentPromptV9({ ...fitted.input, unsupported, retry: true }))
      ).toBeLessThanOrEqual(budget)
      expect(size(fitted.built)).toBeLessThanOrEqual(budget)
    }
  })

  it('sends everything that fits its own budgets', () => {
    const whole = fit(24_000)
    expect(whole.sent.map((each) => each.id)).toEqual(['E1', 'E2', 'E3', 'W1', 'W2'])
    expect(whole.input.history).toHaveLength(2)
    expect(whole.dropped).toBe(0)
  })

  it('drops the farthest evidence first, then the oldest history, then the widened scenes, then the exemplars; never E0 or the question', () => {
    const whole = fit(24_000)
    const size = (built: { messages: { content: string }[] }): number =>
      estimateTokens(built.messages.map((message) => message.content).join('\n'))
    const one = fit(size(whole.built) - 10)
    expect(one.sent.map((each) => each.id)).toEqual(['E1', 'E2', 'W1', 'W2'])
    expect(one.input.history).toHaveLength(2)
    const tight = fit(1)
    expect(tight.sent).toEqual([])
    expect(tight.input.history).toEqual([])
    expect(tight.input.voice).toBe('Voice')
    expect(tight.dropped).toBe(5)
    const user = tight.built.messages.at(-1)?.content ?? ''
    expect(user).toContain(base.scene)
    expect(user.endsWith(`Question: ${base.question}`)).toBe(true)
  })
})
