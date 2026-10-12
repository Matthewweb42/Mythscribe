import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import type {
  ClaimView,
  MemoryStatus,
  SceneMemory,
  SheetMemory,
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
    ...over
  }
}

export function memoryStatusFixture(over: Partial<MemoryStatus> = {}): MemoryStatus {
  return { lastRead: null, paused: null, todayUsd: 0, cloud: null, rebuild: null, ...over }
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
