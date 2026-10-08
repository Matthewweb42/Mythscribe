import { z } from 'zod'
import type { Chord } from './shortcuts'

/**
 * Developer tools (decided by the author 2026-10-07, `plans/plan-devtools.md`): an app-wide
 * switch in Settings › Advanced, off on every install. While it is on, main keeps a live log of
 * errors and warnings and an inspector row per AI request, both in memory only, in capped ring
 * buffers; the developer panel shows them, opens Chromium's DevTools, and copies a plain-text
 * diagnostics report. While it is off nothing is recorded. Nothing here is ever written to disk
 * or sent anywhere, and a prompt or an answer is only held in memory, shown when the author asks.
 */

/** The live log keeps this many entries; the oldest leaves first. */
export const DEV_LOG_MAX = 500
/** The AI inspector keeps this many requests; the oldest leaves first (its text with it). */
export const DEV_AI_MAX = 200
/** How much of one request's prompt plus answer is held for "Show text". */
export const DEV_TEXT_MAX = 200_000
/** The longest message and details a log entry carries (the renderer's channel refuses longer). */
export const DEV_LOG_MESSAGE_MAX = 2_000
export const DEV_LOG_DETAILS_MAX = 8_000
/** How many of the newest entries and requests the copied diagnostics report lists. */
export const DEV_REPORT_ROWS = 50

/** Ctrl+Shift+D (Cmd+Shift+D on macOS) opens the panel while the switch is on. */
export const DEVTOOLS_CHORD: Chord = { key: 'd', ctrl: true, shift: true }

export const DevLogLevel = z.enum(['error', 'warn'])
export type DevLogLevel = z.infer<typeof DevLogLevel>

/** Where an entry came from: the main process, the window, a failed IPC call, or an AI request. */
export const DevLogSource = z.enum(['main', 'renderer', 'ipc', 'ai'])
export type DevLogSource = z.infer<typeof DevLogSource>

export const DevLogEntry = z.object({
  id: z.number().int(),
  at: z.string(),
  level: DevLogLevel,
  source: DevLogSource,
  message: z.string(),
  /** The stack, the channel and code, or whatever else explains it; null when there is none. */
  details: z.string().nullable()
})
export type DevLogEntry = z.infer<typeof DevLogEntry>

/**
 * Why ghost text (VibeWrite) did not send a request on an idle tick (the F-5.14 trigger
 * discipline plus the editor's own checks), in the order the controller asks.
 */
export const GHOST_SKIP_REASONS = [
  'off',
  'backoff',
  'pending',
  'visible',
  'idle',
  'newChars',
  'dailyCap',
  'unfocused',
  'selection',
  'emptyBefore'
] as const
export const GhostSkipReason = z.enum(GHOST_SKIP_REASONS)
export type GhostSkipReason = z.infer<typeof GhostSkipReason>

export const GHOST_SKIP_LABEL: Record<GhostSkipReason, string> = {
  off: 'VibeWrite is off, or the AI dial or its toggle does not allow ghost text',
  backoff: 'Backing off for 30 s after a failed request',
  pending: 'A request is already on the wire',
  visible: 'A suggestion is showing',
  idle: 'Not idle long enough',
  newChars: 'Too few new characters since the last request',
  dailyCap: 'The per-day ghost-text request cap is reached',
  unfocused: 'The editor does not have the focus',
  selection: 'Text is selected',
  emptyBefore: 'Nothing before the caret'
}

export const DevAiStatus = z.enum(['running', 'ok', 'cached', 'failed', 'cancelled', 'skipped'])
export type DevAiStatus = z.infer<typeof DevAiStatus>

/**
 * One AI request as the inspector shows it: one call through the request path (a fidelity
 * regenerate and each agent step are rows of their own, under the caller's request id), or a
 * ghost-text tick that sent nothing (`skipped`, with the reason in `note`). Timings are
 * milliseconds from the moment the request path took it: `waitMs` until the provider was called
 * (the pre-checks and the cache lookup), `firstTokenMs` until the first streamed piece (null for
 * a request that does not stream), `totalMs` until it settled.
 */
export const DevAiRequest = z.object({
  id: z.number().int(),
  requestId: z.string().nullable(),
  feature: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tier: z.string().nullable(),
  promptVersion: z.string().nullable(),
  streamed: z.boolean(),
  status: DevAiStatus,
  startedAt: z.string(),
  waitMs: z.number().nullable(),
  firstTokenMs: z.number().nullable(),
  totalMs: z.number().nullable(),
  maxTokens: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cachedTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  /** The reasoning mode the request asked for (`off`, `low`, `default`); null until prepared. */
  reasoning: z.string().nullable(),
  costUsd: z.number().nullable(),
  /** The provider's reason the answer ended (`stop`, `length`…), when it said. */
  finishReason: z.string().nullable(),
  /** The answer's length in characters before any post-processing; null until it settles. */
  answerChars: z.number().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /**
   * A skip reason, or what the caller did with the answer (ghost text: empty after
   * post-processing; an agent step cut off and retried; where a chat insertion landed or why
   * nothing was shown). Several notes on one request are joined with " · ".
   */
  note: z.string().nullable(),
  /** Whether "Show text" has something to show (held in main's memory only). */
  hasText: z.boolean()
})
export type DevAiRequest = z.infer<typeof DevAiRequest>

export const DevToolsState = z.object({ enabled: z.boolean() })
export type DevToolsState = z.infer<typeof DevToolsState>

export const DevToolsSnapshot = z.object({
  enabled: z.boolean(),
  log: z.array(DevLogEntry),
  requests: z.array(DevAiRequest)
})
export type DevToolsSnapshot = z.infer<typeof DevToolsSnapshot>

export const DevRequestText = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  /** The raw answer; null while running or after a failure. */
  response: z.string().nullable()
})
export type DevRequestText = z.infer<typeof DevRequestText>

export const DevClearTarget = z.enum(['log', 'requests'])
export type DevClearTarget = z.infer<typeof DevClearTarget>

/** Strings that look like credentials: OpenAI/OpenRouter-style keys, bearer tokens, JWTs. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g
]

/** The text with anything that looks like a key or a token replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}

/** Object keys whose value is never copied into a report. */
const SECRET_KEY = /key|token|secret|password|hint|license|email|jwt|session/i

/**
 * A settings value with every secret-looking field removed (by key name) and every string run
 * through `redactSecrets`; arrays and objects are walked, everything else is kept.
 */
export function redactSettings(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(redactSettings)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue
      out[k] = redactSettings(v)
    }
    return out
  }
  return value
}

/** What the copied diagnostics report is built from; gathered by main. */
export interface DevDiagnosticsInput {
  generatedAt: string
  app: {
    version: string
    platform: string
    arch: string
    electron: string
    node: string
    chrome: string
  }
  ai: {
    /** The open project's source (`ownKey`, `cloud`, `local`), or null with no project open. */
    source: string | null
    ownKeyProvider: string
    keySaved: boolean
    encryption: string
    models: unknown
  }
  /** App-wide and project settings; redacted again here, whatever the caller passed. */
  settings: { app: unknown; project: unknown }
  log: readonly DevLogEntry[]
  requests: readonly DevAiRequest[]
}

const ms = (value: number | null): string => (value === null ? '-' : `${Math.round(value)} ms`)

/** One inspector row as a report line: never the prompt or the answer. */
export function requestSummaryLine(row: DevAiRequest): string {
  const parts = [
    row.startedAt,
    row.feature,
    row.status,
    `${row.provider ?? '-'}/${row.model ?? '-'}`,
    `tier ${row.tier ?? '-'}`,
    `prompt ${row.promptVersion ?? '-'}`,
    `wait ${ms(row.waitMs)}`,
    `first token ${ms(row.firstTokenMs)}`,
    `total ${ms(row.totalMs)}`,
    `tokens ${row.inputTokens ?? '-'} in / ${row.outputTokens ?? '-'} out` +
      (row.reasoningTokens === null ? '' : ` (${row.reasoningTokens} reasoning)`) +
      ` / max ${row.maxTokens ?? '-'}`,
    `finish ${row.finishReason ?? '-'}`,
    `answer ${row.answerChars ?? '-'} chars`
  ]
  if (row.reasoning !== null && row.reasoning !== 'default') {
    parts.push(`reasoning ${row.reasoning}`)
  }
  if (row.costUsd !== null) parts.push(`$${row.costUsd.toFixed(6)}`)
  if (row.requestId !== null) parts.push(`id ${row.requestId}`)
  if (row.errorCode !== null) parts.push(`error ${row.errorCode}: ${row.errorMessage ?? ''}`)
  if (row.note !== null) parts.push(`note: ${row.note}`)
  return parts.join(' | ')
}

/**
 * The plain-text report "Copy diagnostics" puts on the clipboard: the build, the AI setup,
 * the settings (redacted), the newest errors and warnings, and the newest AI requests as
 * summaries. Pure, so what it can contain is tested rather than trusted.
 */
export function formatDiagnosticsReport(input: DevDiagnosticsInput): string {
  const lines: string[] = []
  lines.push('MythScribe diagnostics', `Generated: ${input.generatedAt}`, '')
  lines.push('## App')
  lines.push(`Version: ${input.app.version}`)
  lines.push(`Platform: ${input.app.platform} (${input.app.arch})`)
  lines.push(
    `Electron ${input.app.electron} · Node ${input.app.node} · Chromium ${input.app.chrome}`,
    ''
  )
  lines.push('## AI')
  lines.push(`Project source: ${input.ai.source ?? '(no project open)'}`)
  lines.push(`Own-key provider: ${input.ai.ownKeyProvider}`)
  lines.push(`Key saved: ${input.ai.keySaved ? 'yes' : 'no'} (storage: ${input.ai.encryption})`)
  lines.push(`Models: ${JSON.stringify(redactSettings(input.ai.models))}`, '')
  lines.push('## Settings (keys and secrets removed)')
  lines.push(`App: ${JSON.stringify(redactSettings(input.settings.app), null, 2)}`)
  lines.push(`Project: ${JSON.stringify(redactSettings(input.settings.project), null, 2)}`, '')
  const log = input.log.slice(-DEV_REPORT_ROWS)
  lines.push(`## Recent errors and warnings (${log.length})`)
  for (const entry of log) {
    lines.push(
      redactSecrets(`${entry.at} ${entry.level.toUpperCase()} [${entry.source}] ${entry.message}`)
    )
    if (entry.details) lines.push(redactSecrets(indent(entry.details)))
  }
  lines.push('')
  const requests = input.requests.slice(-DEV_REPORT_ROWS)
  lines.push(`## Recent AI requests (${requests.length}, no prompt or answer text)`)
  for (const row of requests) lines.push(redactSecrets(requestSummaryLine(row)))
  return `${lines.join('\n')}\n`
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}
