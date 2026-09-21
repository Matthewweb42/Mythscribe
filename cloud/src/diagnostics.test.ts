import { beforeEach, describe, expect, it } from 'vitest'
import {
  CloudApiError,
  DIAGNOSTICS_BODY_MAX,
  type DiagnosticsBody
} from '../../src/shared/cloudApi'
import { type CrashReport, DIAGNOSTIC_COUNT_MAX } from '../../src/shared/diagnostics'
import type { AiDeps } from './ai'
import { crashFingerprint } from './diagnostics'
import type { Mailer } from './email'
import { handleRequest } from './index'
import { type MemoryStore, memoryStore } from './store'

const ORIGIN = 'https://api.mythscribe.app'
const START = new Date('2026-09-21T10:00:00.000Z')
const MINUTE_MS = 60_000

const silentMailer: Mailer = { send: () => Promise.resolve() }

let store: MemoryStore
let deps: AiDeps
let clock: number

beforeEach(() => {
  clock = START.getTime()
  store = memoryStore()
  deps = {
    store,
    mailer: silentMailer,
    now: () => new Date(clock),
    random: () => 'not-used',
    revealLink: false,
    packs: [],
    webhookSecret: null,
    upstream: null
  }
})

function report(overrides: Partial<DiagnosticsBody> = {}): DiagnosticsBody {
  return {
    appVersion: '1.4.0',
    platform: 'win32',
    arch: 'x64',
    electron: '38.1.0',
    counts: [],
    crashes: [],
    ...overrides
  }
}

function crash(overrides: Partial<CrashReport> = {}): CrashReport {
  return {
    kind: 'main',
    name: 'TypeError',
    message: 'Cannot read properties of undefined (reading <text>)',
    stack: ['out/main/index.js:12:3', 'out/main/db/projectStore.js:88:9', '<external>'],
    appVersion: '1.4.0',
    platform: 'win32',
    arch: 'x64',
    electron: '38.1.0',
    ...overrides
  }
}

/** Anything at all as a body: the invalid cases send text the schema would never produce. */
function send(body: unknown, headers?: HeadersInit): Promise<Response> {
  return handleRequest(
    new Request(`${ORIGIN}/diagnostics`, {
      method: 'POST',
      ...(headers ? { headers } : {}),
      body: typeof body === 'string' ? body : JSON.stringify(body)
    }),
    deps
  )
}

async function expectAccepted(body: unknown): Promise<void> {
  const response = await send(body)
  expect(response.status).toBe(204)
  expect(await response.text()).toBe('')
}

async function errorOf(response: Response): Promise<CloudApiError> {
  return CloudApiError.parse(await response.json())
}

describe('POST /diagnostics', () => {
  it('folds a report into the daily totals and answers 204 with no body', async () => {
    // No Authorization header anywhere in this file: the route is anonymous by design.
    await expectAccepted(
      report({
        counts: [
          { day: '2026-09-20', counter: 'app.launch', n: 3 },
          { day: '2026-09-20', counter: 'ai.request.ghostText', n: 12 }
        ]
      })
    )

    expect(store.diagnosticCounts()).toEqual([
      {
        day: '2026-09-20',
        appVersion: '1.4.0',
        platform: 'win32',
        counter: 'app.launch',
        total: 3
      },
      {
        day: '2026-09-20',
        appVersion: '1.4.0',
        platform: 'win32',
        counter: 'ai.request.ghostText',
        total: 12
      }
    ])
  })

  it('adds later reports to the same total', async () => {
    const counts = [{ day: '2026-09-20', counter: 'app.launch' as const, n: 2 }]
    await expectAccepted(report({ counts }))
    await expectAccepted(report({ counts }))

    expect(store.diagnosticCounts()).toEqual([
      { day: '2026-09-20', appVersion: '1.4.0', platform: 'win32', counter: 'app.launch', total: 4 }
    ])
  })

  it('keeps days, builds, and platforms apart', async () => {
    await expectAccepted(report({ counts: [{ day: '2026-09-20', counter: 'app.launch', n: 1 }] }))
    await expectAccepted(report({ counts: [{ day: '2026-09-21', counter: 'app.launch', n: 1 }] }))
    await expectAccepted(
      report({ appVersion: '1.5.0', counts: [{ day: '2026-09-20', counter: 'app.launch', n: 1 }] })
    )
    await expectAccepted(
      report({ platform: 'darwin', counts: [{ day: '2026-09-20', counter: 'app.launch', n: 1 }] })
    )

    expect(store.diagnosticCounts()).toHaveLength(4)
    expect(store.diagnosticCounts().every((row) => row.total === 1)).toBe(true)
  })

  it('stores nothing for an empty report', async () => {
    await expectAccepted(report())

    expect(store.diagnosticCounts()).toEqual([])
    expect(store.diagnosticCrashes()).toEqual([])
  })

  it('ignores a bearer token rather than refusing one', async () => {
    const response = await send(report(), { Authorization: 'Bearer not-a-session' })

    expect(response.status).toBe(204)
  })

  it('refuses a counter that is not in the shared enum, and stores nothing', async () => {
    const response = await send({
      ...report(),
      counts: [{ day: '2026-09-20', counter: 'manuscript.text', n: 1 }]
    })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('BAD_REQUEST')
    expect(store.diagnosticCounts()).toEqual([])
  })

  it('refuses a day that is not a calendar day', async () => {
    const response = await send({
      ...report(),
      counts: [{ day: 'C:/Users/Author/Novel', counter: 'app.launch', n: 1 }]
    })

    expect(response.status).toBe(400)
    expect(store.diagnosticCounts()).toEqual([])
  })

  it('refuses a body that is not JSON', async () => {
    const response = await send('not json at all')

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('could not read')
  })

  it('refuses a body over the size cap before it is validated', async () => {
    const padding = 'x'.repeat(DIAGNOSTICS_BODY_MAX)
    const response = await send({ ...report(), padding })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('too large')
  })

  it('refuses a body that claims a length over the cap', async () => {
    const response = await send(report(), {
      'Content-Length': String(DIAGNOSTICS_BODY_MAX + 1)
    })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('too large')
  })

  it('clamps one counter to the per-report cap', async () => {
    await expectAccepted(
      report({ counts: [{ day: '2026-09-20', counter: 'app.launch', n: 5_000_000 }] })
    )

    expect(store.diagnosticCounts()[0]?.total).toBe(DIAGNOSTIC_COUNT_MAX)
  })

  it('sums repeated rows inside one report before clamping them', async () => {
    await expectAccepted(
      report({
        counts: [
          { day: '2026-09-20', counter: 'app.launch', n: 4 },
          { day: '2026-09-20', counter: 'app.launch', n: 6 },
          { day: '2026-09-20', counter: 'proposal.accept', n: DIAGNOSTIC_COUNT_MAX },
          { day: '2026-09-20', counter: 'proposal.accept', n: DIAGNOSTIC_COUNT_MAX }
        ]
      })
    )

    expect(store.diagnosticCounts()).toEqual([
      {
        day: '2026-09-20',
        appVersion: '1.4.0',
        platform: 'win32',
        counter: 'app.launch',
        total: 10
      },
      {
        day: '2026-09-20',
        appVersion: '1.4.0',
        platform: 'win32',
        counter: 'proposal.accept',
        total: DIAGNOSTIC_COUNT_MAX
      }
    ])
  })

  it('refuses more count rows than one report may carry', async () => {
    const counts = Array.from({ length: 201 }, () => ({
      day: '2026-09-20',
      counter: 'app.launch',
      n: 1
    }))
    const response = await send({ ...report(), counts })

    expect(response.status).toBe(400)
    expect(store.diagnosticCounts()).toEqual([])
  })
})

describe('POST /diagnostics crashes', () => {
  it('stores one crash as a group of one, stamped with the Worker clock', async () => {
    await expectAccepted(report({ crashes: [crash()] }))

    expect(store.diagnosticCrashes()).toEqual([
      {
        fingerprint: await crashFingerprint(crash()),
        kind: 'main',
        name: 'TypeError',
        message: 'Cannot read properties of undefined (reading <text>)',
        stack: 'out/main/index.js:12:3\nout/main/db/projectStore.js:88:9\n<external>',
        appVersion: '1.4.0',
        platform: 'win32',
        arch: 'x64',
        count: 1,
        firstSeen: START.getTime(),
        lastSeen: START.getTime()
      }
    ])
  })

  it('counts the same fault again and moves only the last sighting', async () => {
    await expectAccepted(report({ crashes: [crash()] }))
    clock = START.getTime() + 90 * MINUTE_MS
    // A second install reporting the same fault, with its own scrubbed wording of the message.
    await expectAccepted(
      report({ crashes: [crash({ message: 'Cannot read <text> of undefined' })] })
    )

    const groups = store.diagnosticCrashes()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.count).toBe(2)
    expect(groups[0]?.firstSeen).toBe(START.getTime())
    expect(groups[0]?.lastSeen).toBe(START.getTime() + 90 * MINUTE_MS)
    // The group keeps the first message it was stored with.
    expect(groups[0]?.message).toBe('Cannot read properties of undefined (reading <text>)')
  })

  it('separates a different error, a different top frame, and a different build', async () => {
    await expectAccepted(
      report({
        crashes: [
          crash(),
          crash({ name: 'RangeError' }),
          crash({ stack: ['out/renderer/index.js:4:1'] })
        ]
      })
    )
    await expectAccepted(report({ appVersion: '1.5.0', crashes: [crash({ appVersion: '1.5.0' })] }))

    expect(store.diagnosticCrashes()).toHaveLength(4)
    expect(store.diagnosticCrashes().every((group) => group.count === 1)).toBe(true)
  })

  it('groups two stacks that differ only below the fingerprint depth', async () => {
    const top = ['a.js:1:1', 'b.js:2:1', 'c.js:3:1', 'd.js:4:1', 'e.js:5:1']
    await expectAccepted(report({ crashes: [crash({ stack: [...top, 'f.js:6:1'] })] }))
    await expectAccepted(report({ crashes: [crash({ stack: [...top, 'z.js:9:1'] })] }))

    expect(store.diagnosticCrashes()).toHaveLength(1)
    expect(store.diagnosticCrashes()[0]?.count).toBe(2)
  })

  it('refuses a crash carrying more frames than the app may send', async () => {
    const stack = Array.from({ length: 21 }, (_, index) => `out/main/index.js:${index}:1`)
    const response = await send({ ...report(), crashes: [{ ...crash(), stack }] })

    expect(response.status).toBe(400)
    expect(store.diagnosticCrashes()).toEqual([])
  })

  it('refuses a crash kind the app cannot produce', async () => {
    const response = await send({ ...report(), crashes: [{ ...crash(), kind: 'minidump' }] })

    expect(response.status).toBe(400)
    expect(store.diagnosticCrashes()).toEqual([])
  })

  it('refuses more crashes than one report may carry', async () => {
    const crashes = Array.from({ length: 11 }, (_, index) => crash({ name: `TypeError${index}` }))
    const response = await send({ ...report(), crashes })

    expect(response.status).toBe(400)
    expect(store.diagnosticCrashes()).toEqual([])
  })
})

describe('the diagnostics route itself', () => {
  it('is POST only', async () => {
    const response = await handleRequest(
      new Request(`${ORIGIN}/diagnostics`, { method: 'GET' }),
      deps
    )

    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('NOT_FOUND')
  })
})
