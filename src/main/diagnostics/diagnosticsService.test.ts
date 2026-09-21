import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiagnosticsBody } from '@shared/cloudApi'
import {
  DIAGNOSTICS_FLUSH_DELAY_MS,
  DIAGNOSTIC_QUEUE_MAX,
  type DiagnosticsState
} from '@shared/diagnostics'
import { AppStateStore } from '../appState/appStateStore'
import type { Schedule } from '../schedule'
import { DiagnosticsService, type DiagnosticsSend } from './diagnosticsService'

const environment = {
  appVersion: '0.3.0',
  platform: 'linux',
  arch: 'arm64',
  electron: '44.3.0'
}

/** Local noon, so `dayOf` (a local calendar day) never lands on the day before or after. */
const day = (iso: string): number => new Date(`${iso}T12:00:00`).getTime()

let tmp: string
let appState: AppStateStore
let changes: DiagnosticsState[]
let sent: DiagnosticsBody[]
let send: DiagnosticsSend | null
let now: number
/** The armed timers, run by the test rather than by a clock. */
let timers: { run: () => void; ms: number }[]

const schedule: Schedule = (run, ms) => {
  const timer = { run, ms }
  timers.push(timer)
  return () => {
    timers = timers.filter((other) => other !== timer)
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-diagnostics-'))
  appState = new AppStateStore(path.join(tmp, 'app-state.json'))
  changes = []
  sent = []
  send = null
  now = day('2026-09-21')
  timers = []
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const build = (): DiagnosticsService =>
  new DiagnosticsService({
    appState,
    environment,
    appRoots: ['/app'],
    onChange: (state) => changes.push(state),
    send,
    now: () => now,
    schedule
  })

const accepting: DiagnosticsSend = (body) => {
  sent.push(body)
  return Promise.resolve()
}

const pendingOf = (service: DiagnosticsService): DiagnosticsBody =>
  JSON.parse(service.state().pending) as DiagnosticsBody

describe('DiagnosticsService (F-15.8)', () => {
  it('is off on a fresh install and records nothing while it is off', () => {
    const service = build()
    expect(service.state()).toEqual({
      enabled: false,
      pending: JSON.stringify({ ...environment, counts: [], crashes: [] }, null, 2),
      lastSentDay: null
    })
    service.count('app.launch')
    service.reportError('main', new Error('boom'))
    expect(appState.get().diagnostics).toEqual({
      enabled: false,
      counts: {},
      queue: [],
      lastSentDay: null
    })
    expect(changes).toEqual([])
  })

  it('records counts per day once it is switched on, and says so once', () => {
    const service = build()
    expect(service.setEnabled(true).enabled).toBe(true)
    expect(changes).toHaveLength(1)
    service.count('app.launch')
    service.count('project.open')
    service.count('project.open')
    expect(appState.get().diagnostics.counts).toEqual({
      '2026-09-21': { 'app.launch': 1, 'project.open': 2 }
    })
    // Counting is not an event: it happens on every AI request, and the tab reads the state.
    expect(changes).toHaveLength(1)
    // Switching it on again changes nothing.
    expect(service.setEnabled(true).enabled).toBe(true)
    expect(changes).toHaveLength(1)
  })

  it('keeps the counts of another machine day apart', () => {
    const service = build()
    service.setEnabled(true)
    service.count('app.launch')
    now = day('2026-09-22')
    service.count('app.launch')
    expect(appState.get().diagnostics.counts).toEqual({
      '2026-09-21': { 'app.launch': 1 },
      '2026-09-22': { 'app.launch': 1 }
    })
  })

  it('queues a crash with the message and the stack scrubbed, and stops at the cap', () => {
    const service = build()
    service.setEnabled(true)
    const error = new Error('Could not parse "She turned from the window." at /home/u/novel/x.db')
    error.stack = [
      'Error: nope',
      '    at save (/app/out/main/index.js:12:3)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)'
    ].join('\n')
    service.reportError('main', error)
    expect(appState.get().diagnostics.queue).toEqual([
      {
        ...environment,
        kind: 'main',
        name: 'Error',
        message: 'Could not parse <text> at <path>',
        stack: ['out/main/index.js:12:3', '<external>']
      }
    ])
    for (let i = 0; i < DIAGNOSTIC_QUEUE_MAX + 5; i += 1) service.reportError('renderer', error)
    expect(appState.get().diagnostics.queue).toHaveLength(DIAGNOSTIC_QUEUE_MAX)
    // The first crash, usually the cause, is the one that survives a full queue.
    expect(appState.get().diagnostics.queue[0]?.kind).toBe('main')
  })

  it('reads an error that crossed IPC, and anything else as its text', () => {
    const service = build()
    service.setEnabled(true)
    service.reportError('renderer', {
      name: 'TypeError',
      message: "x is not a function at '/home/u/x.js'",
      stack: '    at run (/app/out/renderer/main.js:3:1)'
    })
    service.reportError('processGone', 'crashed')
    const queue = appState.get().diagnostics.queue
    expect(queue[0]).toMatchObject({
      kind: 'renderer',
      name: 'TypeError',
      message: 'x is not a function at <text>',
      stack: ['out/renderer/main.js:3:1']
    })
    expect(queue[1]).toMatchObject({ kind: 'processGone', name: 'Error', message: 'crashed' })
  })

  it('throws away everything recorded when it is switched off', () => {
    const service = build()
    service.setEnabled(true)
    service.count('app.launch')
    service.reportError('main', new Error('boom'))
    const state = service.setEnabled(false)
    expect(state.enabled).toBe(false)
    expect(appState.get().diagnostics).toEqual({
      enabled: false,
      counts: {},
      queue: [],
      lastSentDay: null
    })
    expect(JSON.parse(state.pending)).toEqual({ ...environment, counts: [], crashes: [] })
  })

  it('shows the completed days and the queued crashes as what would be sent', () => {
    const service = build()
    service.setEnabled(true)
    service.count('app.launch')
    service.count('ai.request.ghostText')
    // Today is still being counted, so nothing of it would be sent yet.
    expect(pendingOf(service).counts).toEqual([])
    now = day('2026-09-23')
    expect(pendingOf(service)).toEqual({
      ...environment,
      counts: [
        { day: '2026-09-21', counter: 'app.launch', n: 1 },
        { day: '2026-09-21', counter: 'ai.request.ghostText', n: 1 }
      ],
      crashes: []
    })
  })

  it('sends nothing when it is off, when there is no sender, and when nothing is due', async () => {
    const service = build()
    service.setEnabled(true)
    service.count('app.launch')
    now = day('2026-09-23')
    await service.flush()
    expect(sent).toEqual([])

    send = accepting
    const sending = build()
    sending.setEnabled(false)
    sending.count('app.launch')
    await sending.flush()
    expect(sent).toEqual([])
  })

  it('sends the completed days, drops what was sent, and keeps today', async () => {
    send = accepting
    const service = build()
    service.setEnabled(true)
    service.count('app.launch')
    now = day('2026-09-22')
    service.count('project.open')
    service.reportError('main', new Error('boom'))
    changes = []
    await service.flush()
    expect(sent).toEqual([
      {
        ...environment,
        counts: [{ day: '2026-09-21', counter: 'app.launch', n: 1 }],
        crashes: [expect.objectContaining({ kind: 'main', message: 'boom' })]
      }
    ])
    expect(appState.get().diagnostics.counts).toEqual({ '2026-09-22': { 'project.open': 1 } })
    expect(appState.get().diagnostics.queue).toEqual([])
    expect(appState.get().diagnostics.lastSentDay).toBe('2026-09-21')
    expect(changes).toHaveLength(1)
    expect(changes[0]?.lastSentDay).toBe('2026-09-21')
  })

  it('keeps everything and stays quiet when the send fails', async () => {
    send = () => Promise.reject(new Error('offline'))
    const service = build()
    service.setEnabled(true)
    service.count('app.launch')
    service.reportError('main', new Error('boom'))
    now = day('2026-09-22')
    changes = []
    await expect(service.flush()).resolves.toBeUndefined()
    expect(appState.get().diagnostics.counts).toEqual({ '2026-09-21': { 'app.launch': 1 } })
    expect(appState.get().diagnostics.queue).toHaveLength(1)
    expect(appState.get().diagnostics.lastSentDay).toBeNull()
    expect(changes).toEqual([])
  })

  it('arms the first flush on start and drops the timer when it is disposed', () => {
    send = accepting
    const service = build()
    service.setEnabled(true)
    service.start()
    expect(timers.map((timer) => timer.ms)).toEqual([DIAGNOSTICS_FLUSH_DELAY_MS])
    service.dispose()
    expect(timers).toEqual([])
    // A disposed service says nothing more, whatever happens after it.
    changes = []
    service.setEnabled(false)
    expect(changes).toEqual([])
  })

  it('does not write a state file at all while it is off', () => {
    const file = path.join(tmp, 'untouched', 'app-state.json')
    const store = new AppStateStore(file)
    const service = new DiagnosticsService({
      appState: store,
      environment,
      onChange: () => {},
      now: () => now,
      schedule
    })
    service.count('app.launch')
    service.reportError('main', new Error('boom'))
    expect(fs.existsSync(file)).toBe(false)
    expect(service.state().enabled).toBe(false)
  })
})
