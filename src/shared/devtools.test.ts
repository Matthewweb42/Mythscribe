import { describe, expect, it } from 'vitest'
import {
  formatDiagnosticsReport,
  redactSecrets,
  redactSettings,
  requestSummaryLine,
  type DevAiRequest
} from './devtools'

const ROW: DevAiRequest = {
  id: 1,
  requestId: 'g-1',
  feature: 'ghostText',
  provider: 'openrouter',
  model: 'deepseek/x',
  tier: 'fast',
  promptVersion: 'ghostText.v4',
  streamed: false,
  status: 'ok',
  startedAt: '2026-10-07T10:00:00.000Z',
  waitMs: 3,
  firstTokenMs: null,
  totalMs: 12_400,
  maxTokens: 40,
  inputTokens: 900,
  outputTokens: 40,
  cachedTokens: null,
  reasoningTokens: 40,
  costUsd: 0.0001,
  finishReason: 'length',
  answerChars: 0,
  errorCode: null,
  errorMessage: null,
  note: 'No suggestion',
  hasText: true
}

describe('developer tools report', () => {
  it('redacts keys, bearer tokens, and JWTs in text', () => {
    expect(redactSecrets('key sk-or-v1-abcdef123456 ok')).toBe('key [redacted] ok')
    expect(redactSecrets('Bearer abc.def-ghi_jkl')).toBe('[redacted]')
    expect(redactSecrets('t eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl')).toBe('t [redacted]')
  })

  it('drops secret-looking settings fields by name and keeps the rest', () => {
    expect(
      redactSettings({
        models: { fast: 'a' },
        supporter: { token: 'x', accent: 'gold' },
        apiKey: 'k'
      })
    ).toEqual({ models: { fast: 'a' }, supporter: { accent: 'gold' } })
  })

  it('summarizes a request without its text, with timings, tokens, and the note', () => {
    const line = requestSummaryLine(ROW)
    expect(line).toContain('ghostText | ok | openrouter/deepseek/x')
    expect(line).toContain('total 12400 ms')
    expect(line).toContain('tokens 900 in / 40 out (40 reasoning) / max 40')
    expect(line).toContain('finish length')
    expect(line).toContain('note: No suggestion')
  })

  it('builds the plain-text report with versions, AI setup, settings, errors, and requests', () => {
    const report = formatDiagnosticsReport({
      generatedAt: '2026-10-07T10:00:00.000Z',
      app: {
        version: '0.9.0',
        platform: 'win32',
        arch: 'arm64',
        electron: '38',
        node: '22',
        chrome: '140'
      },
      ai: {
        source: 'ownKey',
        ownKeyProvider: 'openrouter',
        keySaved: true,
        encryption: 'os',
        models: {}
      },
      settings: { app: { secretThing: 'x', dailyCapUsd: 1 }, project: null },
      log: [
        {
          id: 1,
          at: '2026-10-07T10:00:00.000Z',
          level: 'error',
          source: 'ai',
          message: 'failed with sk-abcdefghijk',
          details: 'line one'
        }
      ],
      requests: [ROW]
    })
    expect(report).toContain('Version: 0.9.0')
    expect(report).toContain('Platform: win32 (arm64)')
    expect(report).toContain('Own-key provider: openrouter')
    expect(report).toContain('"dailyCapUsd": 1')
    expect(report).not.toContain('secretThing')
    expect(report).toContain('ERROR [ai] failed with [redacted]')
    expect(report).toContain('    line one')
    expect(report).toContain('## Recent AI requests (1, no prompt or answer text)')
  })
})
