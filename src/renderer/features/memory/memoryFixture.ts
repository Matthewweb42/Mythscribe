import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { FindingSideView, FindingView } from '@shared/memory/findings'
import { CHECK_NOT_COVERED } from '@shared/memory/views'
import type {
  AgeView,
  CheckEstimate,
  CheckReport,
  FindingsView,
  LooseEnd,
  LooseEndsView,
  ClaimView,
  ElapsedHintView,
  KnowsCellView,
  KnowsGrid,
  MemoryStatus,
  SceneMemory,
  SecretView,
  SheetMemory,
  ThreadMemoryView,
  ThreadsMemory,
  ThreadStepView,
  TimelineMemory,
  TimelineRow,
  TopicQuoteView,
  TypedComparisonView
} from '@shared/memory/views'
import { setIpcClient } from '@renderer/lib/ipc'

/**
 * Test fixtures for story memory v2's reading in the renderer (F-16.18): a scene's memory, a
 * sheet, a line and the footer's status, the way main's channels answer them.
 */

const none: TypedComparisonView = { outcome: 'none', typed: null, text: null, quote: null }

export function sceneMemoryFixture(nodeId: string, over: Partial<SceneMemory> = {}): SceneMemory {
  return {
    nodeId,
    ref: '1.1',
    card: null,
    here: [],
    mentioned: [],
    trueNow: [],
    typed: { pov: none, place: none, time: none, year: none },
    lastRead: null,
    unread: 0,
    paused: null,
    claims: [],
    secrets: { touched: [], tension: [], more: 0, checkedUpTo: null },
    underlines: [],
    ...over
  }
}

export function claimViewFixture(id: string, over: Partial<ClaimView> = {}): ClaimView {
  return {
    id,
    recordId: 'r-mara',
    slot: 'eyes',
    label: 'Eyes',
    value: 'grey',
    voice: 'narration',
    mode: 'now',
    speakerId: null,
    objectId: null,
    how: null,
    fromId: null,
    state: 'live',
    proof: 'literal',
    nodeId: 'sc-1',
    ref: '1.1',
    para: 0,
    quote: "Mara's eyes were grey",
    ...over
  }
}

export function sheetMemoryFixture(recordId: string, over: Partial<SheetMemory> = {}): SheetMemory {
  return {
    recordId,
    asOf: null,
    asOfRef: null,
    fixed: [],
    lasting: [],
    transient: [],
    accumulating: [],
    others: [],
    later: 0,
    knows: null,
    threads: null,
    age: null,
    topic: null,
    ...over
  }
}

/** F-16.22: a knower's line about a secret, as main's views carry it (a claim by default). */
export function knowsCellFixture(
  knowerId: string,
  over: Partial<KnowsCellView> = {}
): KnowsCellView {
  return {
    knowerId,
    secretId: 's-map',
    how: 'overheard',
    fromId: null,
    source: 'claim',
    line: 'counts',
    claimId: `k-${knowerId}`,
    nodeId: 'sc-1',
    ref: '1.1',
    para: 1,
    voice: 'narration',
    mode: 'now',
    speakerId: null,
    stale: false,
    later: false,
    ...over
  }
}

/** F-16.22: a secret's reveal. */
export function topicQuoteFixture(id: string, over: Partial<TopicQuoteView> = {}): TopicQuoteView {
  return {
    topicQuoteId: id,
    role: 'defining',
    label: 'the sold map',
    quote: 'Tomas sold the map',
    nodeId: 'sc-1',
    ref: '1.1',
    para: 1,
    stale: false,
    reading: { model: 'flash', costUsd: 0.001, created: '2026-10-13T10:00:00.000Z' },
    ...over
  }
}

/** F-16.22: a secret as of a scene, revealed in 1.1 and known by then. */
export function secretViewFixture(
  recordId: string,
  label: string,
  over: Partial<SecretView> = {}
): SecretView {
  return {
    recordId,
    label,
    origin: 'ai',
    readersSince: { nodeId: 'sc-1', ref: '1.1', stale: false },
    known: true,
    knownStale: false,
    defining: topicQuoteFixture(`tq-${recordId}`, { label }),
    merged: [],
    cells: [],
    others: [],
    knewBefore: [],
    touchedIn: ['sc-1'],
    ...over
  }
}

/** F-16.22: the Book's grid. */
export function knowsGridFixture(over: Partial<KnowsGrid> = {}): KnowsGrid {
  return {
    asOf: null,
    asOfRef: null,
    checkedUpTo: null,
    columns: [],
    rows: [],
    later: 0,
    ...over
  }
}

/** F-16.23: a thread step (an opening in 1.1 that counts, by default). */
export function threadStepFixture(
  claimId: string,
  over: Partial<ThreadStepView> = {}
): ThreadStepView {
  return {
    claimId,
    step: 'opens',
    value: 'swears to find the heir',
    nodeId: 'sc-1',
    ref: '1.1',
    para: 0,
    voice: 'narration',
    mode: 'now',
    counted: true,
    stale: false,
    ...over
  }
}

/** F-16.23: a thread as of a scene, opened in 1.1 and open by then. */
export function threadViewFixture(
  recordId: string,
  label: string,
  over: Partial<ThreadMemoryView> = {}
): ThreadMemoryView {
  return {
    recordId,
    label,
    origin: 'ai',
    status: 'open',
    opened: { nodeId: 'sc-1', ref: '1.1' },
    last: { nodeId: 'sc-1', ref: '1.1' },
    resolved: null,
    steps: [threadStepFixture(`st-${recordId}`)],
    later: 0,
    defining: topicQuoteFixture(`tq-${recordId}`, { label, quote: 'Mara swore to find the heir' }),
    merged: [],
    ...over
  }
}

/** F-16.23: the Book's Threads. */
export function threadsMemoryFixture(over: Partial<ThreadsMemory> = {}): ThreadsMemory {
  return { asOf: null, asOfRef: null, checkedUpTo: null, threads: [], ...over }
}

/** F-16.23: an age computed from a birth year in 1.1 and the year typed in 1.1. */
export function computedAgeFixture(age = 19): AgeView {
  return {
    kind: 'computed',
    age,
    born: { year: 1811 - age, source: 'text', claimId: 'c-born', nodeId: 'sc-1', ref: '1.1' },
    year: { kind: 'typed', value: 1811, from: { nodeId: 'sc-1', ref: '1.1' } }
  }
}

/** F-16.23: a Timeline row (1.1, typed 1811, no ages). */
export function timelineRowFixture(nodeId: string, over: Partial<TimelineRow> = {}): TimelineRow {
  return {
    nodeId,
    ref: '1.1',
    title: 'The stair',
    year: { kind: 'typed', value: 1811, from: { nodeId, ref: '1.1' } },
    flashback: false,
    elapsed: null,
    time: '',
    ages: [],
    sources: [],
    ...over
  }
}

/** F-16.23: an elapsed hint the card quoted, standing on the text (its words as the book has them). */
export function elapsedHintFixture(
  nodeId: string,
  over: Partial<ElapsedHintView> = {}
): ElapsedHintView {
  return {
    text: 'Three winters later',
    quote: 'Three winters later, Mara found the heir',
    para: 0,
    nodeId,
    ref: '1.3',
    breaks: true,
    ...over
  }
}

/** F-16.23: the Timeline. */
export function timelineFixture(over: Partial<TimelineMemory> = {}): TimelineMemory {
  return { recordId: null, rows: [], ...over }
}

/** F-16.27: a book side of a finding: Mara's eyes in a scene, narration now. */
export function findingSideFixture(
  value: string,
  ref: string,
  nodeId: string,
  over: Partial<FindingSideView> = {}
): FindingSideView {
  return {
    kind: 'claim',
    ref,
    nodeId,
    para: 0,
    quote: `Mara's eyes were ${value}`,
    value,
    voice: 'narration',
    mode: 'now',
    label: ref,
    open: { kind: 'scene', id: nodeId, para: 0 },
    ...over
  }
}

/** F-16.27: an open C1 finding: Mara Vell's eyes grey in 1.1 (sc-1), brown in 1.2 (sc-2). */
export function findingViewFixture(id: string, over: Partial<FindingView> = {}): FindingView {
  return {
    id,
    rule: 'C1',
    variant: null,
    recordId: 'r-mara',
    name: 'Mara Vell',
    slot: 'eyes',
    slotLabel: 'Eyes',
    a: findingSideFixture('grey', '1.1', 'sc-1'),
    b: findingSideFixture('brown', '1.2', 'sc-2'),
    state: 'open',
    verdictAb: 'c',
    verdictBa: 'c',
    confirmed: false,
    why: 'grey eyes against brown',
    costUsd: 0.0002,
    year: null,
    actions: { right: { a: true, b: true }, updateNote: false, notFlashback: null },
    ...over
  }
}

/**
 * F-16.29: a C6 note conflict: Orrin's Pinned page says born 1790; the book says 1792 in 1.1
 * (sc-1), narration now, so *Update my note* is offered.
 */
export function noteFindingFixture(id: string, over: Partial<FindingView> = {}): FindingView {
  return findingViewFixture(id, {
    rule: 'C6',
    recordId: 'r-orrin',
    name: 'Orrin',
    slot: 'born',
    slotLabel: 'Born',
    a: findingSideFixture('1792', '1.1', 'sc-1', { quote: 'Orrin was born in 1792' }),
    b: {
      kind: 'note',
      ref: 'Orrin',
      nodeId: null,
      para: 0,
      quote: 'Born: 1790',
      value: '1790',
      voice: null,
      mode: null,
      label: 'Orrin’s Pinned page',
      open: { kind: 'record', id: 'r-orrin', para: 0 }
    },
    actions: { right: { a: false, b: false }, updateNote: true, notFlashback: null },
    ...over
  })
}

/** F-16.27: what `memory:findings` answers (the check on, nothing waiting). */
export function findingsViewFixture(over: Partial<FindingsView> = {}): FindingsView {
  return {
    on: true,
    open: [],
    unclear: [],
    counts: { unjudged: 0, held: 0, hidden: 0, open: 0, unclear: 0, fine: 0 },
    waiting: 0,
    judging: false,
    scene: null,
    ...over
  }
}

/** F-16.29: a planned card left before the furthest drafted scene. */
export function looseEndFixture(over: Partial<LooseEnd> = {}): LooseEnd {
  return {
    kind: 'planned',
    id: 'sc-plan',
    name: 'The duel at dawn',
    lastRef: null,
    lastNodeId: null,
    horizonRef: '1.2',
    checkedUpTo: { nodeId: 'sc-2', ref: '1.2' },
    ask: "Which drafted scene covers the plan 'The duel at dawn'?",
    ...over
  }
}

/** F-16.29: Needs a look's Loose ends. */
export function looseEndsFixture(over: Partial<LooseEndsView> = {}): LooseEndsView {
  return {
    items: [],
    more: 0,
    furthest: { nodeId: 'sc-2', ref: '1.2' },
    checkedUpTo: { nodeId: 'sc-2', ref: '1.2' },
    ...over
  }
}

/** F-16.30: a check's price: two confirmations due, no new pairs, on an own key. */
export function checkEstimateFixture(over: Partial<CheckEstimate> = {}): CheckEstimate {
  return {
    free: false,
    pairs: 2,
    uncached: 0,
    fastCalls: 0,
    confirms: { about: 2, most: 2 },
    aboutUsd: 0.0004,
    mostUsd: 0.0006,
    priced: true,
    hidden: 0,
    unreadScenes: [],
    cloud: false,
    fastModel: 'deepseek-v4-flash',
    strongModel: 'deepseek-v4-pro',
    ...over
  }
}

/** F-16.30: a check's report: one finding confirmed, nothing hidden. */
export function checkReportFixture(over: Partial<CheckReport> = {}): CheckReport {
  return {
    at: '2026-10-14T10:00:00.000Z',
    draftId: 'd-1',
    costUsd: 0.0005,
    stopped: false,
    found: [findingViewFixture('f-1', { confirmed: true })],
    unclear: [],
    cleared: [],
    confirmed: 1,
    checked: {
      pairs: 2,
      byRule: { C1: 1, C2: 0, C3: 0, C4: 0, C5: 0, C6: 1, C7: 0 },
      scenes: 2,
      notes: 1
    },
    notChecked: { fixed: [...CHECK_NOT_COVERED], unreadScenes: [], pastConfirm: 0, unjudged: 0 },
    hidden: [],
    secretsNobodyLearns: [],
    ...over
  }
}

export function memoryStatusFixture(over: Partial<MemoryStatus> = {}): MemoryStatus {
  return {
    lastRead: null,
    paused: null,
    todayUsd: 0,
    cloud: null,
    rebuild: null,
    check: null,
    ...over
  }
}

/** A fake main for the reading's tests: each channel's handler, every call kept, events sent on demand. */
export interface FakeMain {
  calls: [Channel, unknown][]
  sent: (channel: Channel) => unknown[]
  emit: <E extends EventName>(event: E, payload: EventPayload<E>) => void
}

export function installFakeMain(
  handlers: Partial<Record<Channel, (input: unknown) => unknown>>
): FakeMain {
  const calls: [Channel, unknown][] = []
  const listeners = new Map<EventName, ((payload: unknown) => void)[]>()
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const handler = handlers[channel]
      if (handler === undefined) throw new Error(`unexpected ${channel}`)
      return (await handler(input)) as Output<C>
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      const list = listeners.get(event) ?? []
      const wrapped = listener as (payload: unknown) => void
      listeners.set(event, [...list, wrapped])
      return () => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((each) => each !== wrapped)
        )
      }
    }
  })
  return {
    calls,
    sent: (channel) => calls.filter(([each]) => each === channel).map(([, input]) => input),
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    }
  }
}
