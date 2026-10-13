import { priceFor, type AiProviderId } from '@shared/ai'
import { defaultAiRouting, autoTable } from '@shared/aiRouting'
import { READER_SENTINEL } from '../../ai/prompts/reader.v2'
import { VERIFY_SENTINEL, VERIFY_UNNAMED_MARK } from '../../ai/prompts/verify.v2'
import type { CachedResponse } from '../../ai/cacheStore'
import { dayOf, defaultAiUsageState } from '../../ai/dailyCap'
import type { AiRequestDeps } from '../../ai/request'
import type { CompletionRequest, Provider } from '../../ai/providers/types'
import type { UsageEntry } from '../../ai/usageStore'

/**
 * Test support for the reading pipeline (F-16.17): request deps over a fake provider, with an
 * in-memory ledger and cache, and helpers that read the reader's and the checker's prompts the way
 * the e2e's fake provider does. Tests and the eval harness only; nothing in the app imports it.
 */

export interface FakeAnswer {
  text: string
  finishReason?: string
  usage?: { inputTokens: number; outputTokens: number }
}

export interface FakeAi {
  deps: AiRequestDeps
  /** Every request that reached the provider (cache hits never do). */
  requests: CompletionRequest[]
  ledger: UsageEntry[]
}

/** Whether a request is the reader's or the checker's, by its sentinel. */
export function requestKind(
  request: Pick<CompletionRequest, 'messages'>
): 'reader' | 'verify' | null {
  const system = request.messages[0]?.content ?? ''
  if (system.startsWith(READER_SENTINEL)) return 'reader'
  if (system.startsWith(VERIFY_SENTINEL)) return 'verify'
  return null
}

/** The numbered paragraphs a reader request sent (`¶3 text`), by number. */
export function sentParagraphs(request: Pick<CompletionRequest, 'messages'>): Map<number, string> {
  const user = request.messages.at(-1)?.content ?? ''
  const body = user.slice(user.indexOf('Paragraphs:\n') + 'Paragraphs:\n'.length)
  const found = new Map<number, string>()
  for (const line of body.split('\n')) {
    const match = /^¶(\d+) (.*)$/.exec(line)
    if (match !== null) found.set(Number(match[1]), match[2] ?? '')
  }
  return found
}

/** The roster lines of a reader request (`r12 Mara Vell (Mara) · character`), name → short id. */
export function rosterIds(request: Pick<CompletionRequest, 'messages'>): Map<string, string> {
  const system = request.messages[0]?.content ?? ''
  const ids = new Map<string, string>()
  for (const line of system.split('\n')) {
    const match = /^(r\d+) (.+?)(?: \(.*\))? · [a-z]+$/.exec(line)
    const [, short, name] = match ?? []
    if (short !== undefined && name !== undefined) ids.set(name, short)
  }
  return ids
}

/** One item of a checker request: its number, the short ids of "Who", its fact and its text. */
export interface SentCheck {
  i: number
  /**
   * What it checks (`verify.v2`'s kinds): a fact (`claim`), a knows line, a thread step, a new
   * topic's reveal, a same-as pair, a presence or a card field (`card`).
   */
  kind: 'claim' | 'knows' | 'step' | 'reveals' | 'same' | 'present' | 'card'
  who: string[]
  /** The ids of "Who" marked as named nowhere in reach (`VERIFY_UNNAMED_MARK`). */
  unnamed: string[]
  /** The names of "Who", in the same order. */
  names: string[]
  /** A knows item's source candidates (short ids). */
  from: string[]
  /** The names of "From", in the same order. */
  fromNames: string[]
  /** A knows item's secret, a step's thread, a reveals or same item's topics, as sent. */
  topic: string
  /** The fact line's label ("Fact", "On the page", "Card POV"), or "Reveals" / "Same". */
  label: string
  fact: string
  text: string
}

/** The entries of a "Who" or "From" line: each one's short id and name. */
function entriesOf(line: string): { id: string; name: string }[] {
  return line
    .split(' | ')
    .map((entry) =>
      /^([rn]\d+) (.+?)(?: \(.*\))? · [a-z ]+?(?: · not named here)?$|^([rn]\d+) (.+)$/.exec(entry)
    )
    .flatMap((match) =>
      match === null ? [] : [{ id: match[1] ?? match[3] ?? '', name: match[2] ?? match[4] ?? '' }]
    )
}

/** The items of a checker request (`verify.v1` or `verify.v2`). */
export function sentChecks(request: Pick<CompletionRequest, 'messages'>): SentCheck[] {
  const user = request.messages.at(-1)?.content ?? ''
  return user
    .split('\n\n')
    .map((block) => block.replace(/^Items:\n/, ''))
    .flatMap((block): SentCheck[] => {
      const lines = block.split('\n')
      const head = /^(\d+)\. (Who|Thread|Reveals|Same): (.*)$/.exec(lines[0] ?? '')
      if (head === null) return []
      const i = Number(head[1])
      const rest = new Map<string, string>()
      let label = ''
      for (const line of lines.slice(1)) {
        const field = /^([^:]+): (.*)$/.exec(line)
        if (field === null) continue
        const key = field[1] ?? ''
        rest.set(key, field[2] ?? '')
        if (key !== 'From' && key !== 'Secret' && key !== 'Text') label = key
      }
      const text = rest.get('Text') ?? ''
      const head2 = head[3] ?? ''
      if (head[2] === 'Reveals' || head[2] === 'Same') {
        return [
          {
            i,
            kind: head[2] === 'Reveals' ? 'reveals' : 'same',
            who: [],
            unnamed: [],
            names: [],
            from: [],
            fromNames: [],
            topic: head2,
            label: head[2],
            fact: '',
            text
          }
        ]
      }
      if (head[2] === 'Thread') {
        return [
          {
            i,
            kind: 'step',
            who: [],
            unnamed: [],
            names: [],
            from: [],
            fromNames: [],
            topic: head2,
            label,
            fact: rest.get(label) ?? '',
            text
          }
        ]
      }
      const entries = entriesOf(head2)
      const unnamed = head2
        .split(' | ')
        .filter((entry) => entry.endsWith(VERIFY_UNNAMED_MARK))
        .map((entry) => entry.split(' ')[0] ?? '')
      const kind = rest.has('Secret')
        ? 'knows'
        : label === 'Fact'
          ? 'claim'
          : label === 'On the page'
            ? 'present'
            : 'card'
      const from = entriesOf(rest.get('From') ?? '')
      return [
        {
          i,
          kind,
          who: entries.map((entry) => entry.id),
          unnamed,
          names: entries.map((entry) => entry.name),
          from: from.map((entry) => entry.id),
          fromNames: from.map((entry) => entry.name),
          topic: rest.get('Secret') ?? '',
          label,
          fact: rest.get(label) ?? '',
          text
        }
      ]
    })
}

/** The topics roster of a reader request (`s3 the sold map · secret`): label → short id. */
export function topicIds(request: Pick<CompletionRequest, 'messages'>): Map<string, string> {
  const system = request.messages[0]?.content ?? ''
  const ids = new Map<string, string>()
  for (const line of system.split('\n')) {
    const match = /^([st]\d+) (.+) · (?:secret|thread)$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) ids.set(match[2], match[1])
  }
  return ids
}

/**
 * Request deps over a fake provider answering with `answer`, an in-memory ledger and cache, no
 * daily cap to speak of, and the Auto routing (so reasoning goes off as in the app).
 */
export function fakeAi(
  answer: (request: CompletionRequest) => FakeAnswer | Promise<FakeAnswer>,
  options: { providerId?: AiProviderId; now?: Date } = {}
): FakeAi {
  const now = options.now ?? new Date(Date.UTC(2026, 9, 12, 12, 0, 0))
  const requests: CompletionRequest[] = []
  const ledger: UsageEntry[] = []
  const cache = new Map<string, CachedResponse>()
  const provider: Provider = {
    id: options.providerId ?? 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete: async (request) => {
      requests.push(request)
      const reply = await answer(request)
      return {
        text: reply.text,
        model: 'gpt-5.4-mini',
        usage: reply.usage ?? { inputTokens: 1_000, outputTokens: 100 },
        ...(reply.finishReason === undefined ? {} : { finishReason: reply.finishReason })
      }
    },
    // The reader never streams: an empty stream.
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined })
      })
    }),
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  const deps: AiRequestDeps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: {
      get: (key) => cache.get(key),
      put: (entry) => void cache.set(entry.key, { text: entry.text, usage: entry.usage })
    },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), dailyCapUsd: 500, spentDate: dayOf(now) }),
      spend: () => undefined
    },
    session: { spend: () => undefined },
    now: () => now,
    price: priceFor,
    routing: () => ({ routing: defaultAiRouting(), table: autoTable(null) })
  }
  return { deps, requests, ledger }
}
