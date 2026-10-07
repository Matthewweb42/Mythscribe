import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEV_AI_MAX, DEV_LOG_MAX, type DevAiRequest, type DevLogEntry } from '@shared/devtools'
import { AppStateStore } from '../appState/appStateStore'
import { AiCancelledError, AiRateLimitError } from '../ai/providers/types'
import { DevToolsService } from './devToolsService'

let tmp: string
let clock: number
let logs: DevLogEntry[]
let rows: DevAiRequest[]
let changes: boolean[]
let service: DevToolsService

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-devtools-'))
  clock = Date.parse('2026-10-07T10:00:00Z')
  logs = []
  rows = []
  changes = []
  service = new DevToolsService({
    appState: new AppStateStore(path.join(tmp, 'app-state.json')),
    onChange: (state) => changes.push(state.enabled),
    onLog: (entry) => logs.push(entry),
    onRequest: (row) => rows.push(row),
    openChromium: () => {},
    now: () => clock
  })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const START = {
  feature: 'chat' as const,
  tier: 'strong' as const,
  promptVersion: 'chat.v5',
  requestId: 'c-1',
  streamed: true,
  messages: [{ role: 'user' as const, content: 'Where is Mara?' }]
}

describe('DevToolsService', () => {
  it('persists the switch, pushes the change, and records nothing while off', () => {
    service.record('error', 'main', 'ignored', null)
    expect(service.observer.start(START)).toBeDefined()
    expect(service.snapshot()).toEqual({ enabled: false, log: [], requests: [] })
    expect(logs).toEqual([])

    expect(service.setEnabled(true)).toEqual({ enabled: true })
    expect(changes).toEqual([true])
    expect(new AppStateStore(path.join(tmp, 'app-state.json')).get().devTools).toBe(true)
  })

  it('times a streamed request: wait, first token, total, tokens, and the held text', () => {
    service.setEnabled(true)
    const trace = service.observer.start(START)
    trace.prepared({ provider: 'openrouter', model: 'm/x', tier: 'strong', maxTokens: 900 })
    clock += 40
    trace.sent()
    clock += 2_000
    trace.firstToken()
    clock += 8_000
    trace.done({
      text: 'In the mill.',
      usage: { inputTokens: 1_000, outputTokens: 30, cachedInputTokens: 800, reasoningTokens: 10 },
      costUsd: 0.0012,
      cached: false,
      finishReason: 'stop'
    })
    const [row] = service.snapshot().requests
    expect(row).toMatchObject({
      feature: 'chat',
      requestId: 'c-1',
      provider: 'openrouter',
      model: 'm/x',
      status: 'ok',
      waitMs: 40,
      firstTokenMs: 2_040,
      totalMs: 10_040,
      inputTokens: 1_000,
      outputTokens: 30,
      cachedTokens: 800,
      reasoningTokens: 10,
      costUsd: 0.0012,
      finishReason: 'stop',
      answerChars: 12,
      hasText: true
    })
    expect(rows.at(-1)).toEqual(row)
    expect(service.text(row!.id)).toEqual({
      messages: [{ role: 'user', content: 'Where is Mara?' }],
      response: 'In the mill.'
    })
  })

  it('marks a cancel as cancelled without logging it, and a failure as failed with an ai log entry', () => {
    service.setEnabled(true)
    service.observer.start(START).failed(new AiCancelledError('Stopped.'))
    service.observer.start(START).failed(new AiRateLimitError('Slow down.'))
    const [cancelled, failed] = service.snapshot().requests
    expect(cancelled).toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' })
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'RATE_LIMIT',
      errorMessage: 'Slow down.'
    })
    expect(service.snapshot().log.map((e) => e.message)).toEqual([
      'chat failed: RATE_LIMIT: Slow down.'
    ])
  })

  it('caps both buffers, dropping the oldest (and its text)', () => {
    service.setEnabled(true)
    for (let i = 0; i < DEV_LOG_MAX + 5; i++) service.record('warn', 'main', `w${i}`, null)
    const log = service.snapshot().log
    expect(log).toHaveLength(DEV_LOG_MAX)
    expect(log[0]!.message).toBe('w5')

    const first = service.observer.start(START)
    first.done({
      text: 'x',
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
      cached: false,
      finishReason: null
    })
    const firstId = service.snapshot().requests[0]!.id
    for (let i = 0; i < DEV_AI_MAX; i++) service.ghostSkip('idle')
    expect(service.snapshot().requests).toHaveLength(DEV_AI_MAX)
    expect(service.text(firstId)).toBeNull()
  })

  it('redacts keys and bearer tokens from every entry', () => {
    service.setEnabled(true)
    service.record(
      'error',
      'main',
      'bad key sk-abcdefgh12345678',
      'Authorization: Bearer abcdefghijkl'
    )
    expect(service.snapshot().log[0]).toMatchObject({
      message: 'bad key [redacted]',
      details: 'Authorization: [redacted]'
    })
  })

  it('wraps console.error and console.warn: the original still prints, the log gets the line while on', () => {
    const target = { error: vi.fn(), warn: vi.fn() }
    const originalError = target.error
    const unhook = service.hookConsole(target)
    target.warn('quiet while off')
    service.setEnabled(true)
    const err = new Error('disk full')
    target.error('Could not save', err)
    target.error('[ipc] tree:list failed', err)
    expect(originalError).toHaveBeenCalledTimes(2)
    expect(service.snapshot().log.map((e) => [e.level, e.message])).toEqual([
      ['error', 'Could not save Error: disk full']
    ])
    expect(service.snapshot().log[0]!.details).toContain('disk full')
    unhook()
    expect(target.error).toBe(originalError)
  })

  it('records an IPC failure as a warning, INTERNAL as an error with the stack', () => {
    service.setEnabled(true)
    service.ipcFailure('tree:rename', { code: 'NOT_FOUND', message: 'No node' })
    service.ipcFailure('tree:list', { code: 'INTERNAL', message: 'boom' }, new Error('boom'))
    const [notFound, internal] = service.snapshot().log
    expect(notFound).toMatchObject({
      level: 'warn',
      source: 'ipc',
      message: 'tree:rename failed: NOT_FOUND: No node'
    })
    expect(internal).toMatchObject({ level: 'error', source: 'ipc' })
    expect(internal!.details).toContain('Error: boom')
  })

  it('drops everything when turned off', () => {
    service.setEnabled(true)
    service.record('warn', 'main', 'x', null)
    service.ghostSkip('pending')
    service.setEnabled(false)
    service.setEnabled(true)
    expect(service.snapshot()).toEqual({ enabled: true, log: [], requests: [] })
  })
})
