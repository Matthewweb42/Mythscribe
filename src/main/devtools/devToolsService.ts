import {
  DEV_AI_MAX,
  DEV_LOG_DETAILS_MAX,
  DEV_LOG_MAX,
  DEV_LOG_MESSAGE_MAX,
  DEV_TEXT_MAX,
  GHOST_SKIP_LABEL,
  redactSecrets,
  type DevAiRequest,
  type DevClearTarget,
  type DevLogEntry,
  type DevLogLevel,
  type DevLogSource,
  type DevRequestText,
  type DevToolsSnapshot,
  type DevToolsState,
  type GhostSkipReason
} from '@shared/devtools'
import type { IpcError } from '@shared/ipc/contract'
import type { AppStateStore } from '../appState/appStateStore'
import type { AiRequestObserver, AiRequestTrace } from '../ai/request'
import { AiProviderError, type AiMessage } from '../ai/providers/types'
import { AppError, IPC_LOG_PREFIX } from '../ipc/errors'

export interface DevToolsServiceDeps {
  /** Where the switch lives (`devTools` in app-state.json); nothing else is written there. */
  appState: AppStateStore
  /** The switch moved; `index.ts` pushes `devtools:changed` and rebuilds the menu. */
  onChange: (state: DevToolsState) => void
  /** A new log entry while on; `index.ts` pushes `devtools:logAdded`. */
  onLog: (entry: DevLogEntry) => void
  /** An inspector row was added or moved on while on; `index.ts` pushes `devtools:requestChanged`. */
  onRequest: (row: DevAiRequest) => void
  /** Opens Chromium's DevTools on the focused window. */
  openChromium: () => void
  /** Milliseconds; injectable for tests. */
  now?: () => number
}

/** The console methods the hook wraps. */
export type ConsoleLike = Pick<Console, 'error' | 'warn'>

interface HeldText {
  messages: AiMessage[]
  response: string | null
}

/**
 * Developer tools in main (2026-10-07, `plans/plan-devtools.md`): the one owner of the switch,
 * the live log, and the AI inspector. Both buffers are in memory only and capped (`DEV_LOG_MAX`,
 * `DEV_AI_MAX`); a prompt and its answer are held beside their row for "Show text" and leave with
 * it. While the switch is off every recording call returns at once, so nothing is kept; turning
 * it off drops whatever was held. Every message goes through `redactSecrets` on the way in, so a
 * key that slipped into an error never reaches the panel or the copied report.
 */
export class DevToolsService {
  private log: DevLogEntry[] = []
  private requests: DevAiRequest[] = []
  private texts = new Map<number, HeldText>()
  private nextLogId = 1
  private nextRequestId = 1
  /** Set while a log entry is being delivered, so a console write it causes is not logged again. */
  private delivering = false
  private readonly now: () => number

  constructor(private readonly deps: DevToolsServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  enabled(): boolean {
    return this.deps.appState.get().devTools
  }

  state(): DevToolsState {
    return { enabled: this.enabled() }
  }

  setEnabled(on: boolean): DevToolsState {
    if (on !== this.enabled()) this.deps.appState.update((s) => ({ ...s, devTools: on }))
    if (!on) this.dropAll()
    const state = this.state()
    this.deps.onChange(state)
    return state
  }

  snapshot(): DevToolsSnapshot {
    if (!this.enabled()) return { enabled: false, log: [], requests: [] }
    return { enabled: true, log: [...this.log], requests: [...this.requests] }
  }

  clear(what: DevClearTarget): void {
    if (what === 'log') {
      this.log = []
      return
    }
    this.requests = []
    this.texts.clear()
  }

  /** Opens Chromium's DevTools; refused while the switch is off, so the menu item cannot be faked. */
  openChromium(): void {
    if (!this.enabled()) throw new AppError('VALIDATION', 'Developer tools are off.')
    this.deps.openChromium()
  }

  /** Adds one entry to the live log; a no-op while off. */
  record(level: DevLogLevel, source: DevLogSource, message: string, details: string | null): void {
    if (!this.enabled()) return
    const entry: DevLogEntry = {
      id: this.nextLogId++,
      at: new Date(this.now()).toISOString(),
      level,
      source,
      message: cut(redactSecrets(message), DEV_LOG_MESSAGE_MAX),
      details: details === null ? null : cut(redactSecrets(details), DEV_LOG_DETAILS_MAX)
    }
    this.log.push(entry)
    if (this.log.length > DEV_LOG_MAX) this.log.splice(0, this.log.length - DEV_LOG_MAX)
    this.deliver(() => this.deps.onLog(entry))
  }

  /** A thrown value as a log entry: its message, and its stack as the details. */
  recordError(source: DevLogSource, err: unknown, level: DevLogLevel = 'error'): void {
    if (!this.enabled()) return
    if (err instanceof Error) {
      this.record(level, source, `${err.name}: ${err.message}`, err.stack ?? null)
    } else {
      this.record(level, source, String(err), null)
    }
  }

  /**
   * An IPC call that answered an error envelope; INTERNAL and IO are errors, the rest warnings.
   * The details are the stack of what was thrown when it was a bug, else the envelope's details.
   */
  ipcFailure(channel: string, error: IpcError, cause?: unknown): void {
    if (!this.enabled()) return
    const level: DevLogLevel = error.code === 'INTERNAL' || error.code === 'IO' ? 'error' : 'warn'
    const stack = error.code === 'INTERNAL' && cause instanceof Error ? (cause.stack ?? null) : null
    const details = stack ?? (error.details === undefined ? null : safeJson(error.details))
    this.record(level, 'ipc', `${channel} failed: ${error.code}: ${error.message}`, details)
  }

  /**
   * Wraps `console.error` and `console.warn` so main's own warnings reach the live log while on.
   * The original is always called first and unchanged. Returns the unwrap.
   */
  hookConsole(target: ConsoleLike): () => void {
    const original = { error: target.error, warn: target.warn }
    const wrap =
      (level: DevLogLevel, fn: (...args: unknown[]) => void) =>
      (...args: unknown[]): void => {
        fn.apply(target, args)
        if (this.delivering || !this.enabled()) return
        // A failed channel is logged by `ipcFailure` with its code; its console line would repeat it.
        if (typeof args[0] === 'string' && args[0].startsWith(IPC_LOG_PREFIX)) return
        const error = args.find((a): a is Error => a instanceof Error)
        const message = args
          .filter((a) => !(a instanceof Error))
          .map((a) => (typeof a === 'string' ? a : safeJson(a)))
          .join(' ')
        const text = error ? `${message} ${error.name}: ${error.message}`.trim() : message
        this.record(level, 'main', text, error?.stack ?? null)
      }
    target.error = wrap('error', original.error)
    target.warn = wrap('warn', original.warn)
    return () => {
      target.error = original.error
      target.warn = original.warn
    }
  }

  /** Ghost text sent nothing on an idle tick: an inspector row that says why. */
  ghostSkip(reason: GhostSkipReason): void {
    if (!this.enabled()) return
    const row = this.newRow({
      feature: 'ghostText',
      requestId: null,
      tier: null,
      promptVersion: null,
      streamed: false,
      status: 'skipped'
    })
    row.note = GHOST_SKIP_LABEL[reason]
    this.addRow(row)
  }

  /**
   * Ghost text answered but post-processing left nothing to show: the note goes on the newest
   * row of that request id, with the raw answer's length, the finish reason, and the output
   * tokens against the cap, which is what tells "the model wrote nothing" from "we cut it all".
   */
  ghostEmpty(requestId: string): void {
    if (!this.enabled()) return
    const row = [...this.requests].reverse().find((r) => r.requestId === requestId)
    if (row === undefined) return
    const parts = [
      `raw answer ${row.answerChars ?? 0} characters`,
      `finish reason ${row.finishReason ?? 'not reported'}`,
      `${row.outputTokens ?? '?'} of ${row.maxTokens ?? '?'} output tokens`
    ]
    if (row.reasoningTokens !== null) parts.push(`${row.reasoningTokens} of them reasoning`)
    if (row.status === 'cached') parts.push('served from the local cache')
    row.note = `No suggestion: empty after post-processing (${parts.join(', ')})`
    this.deliver(() => this.deps.onRequest({ ...row }))
  }

  /**
   * 2026-10-07: what a caller did with a request's answer, or why nothing was shown (an agent
   * step cut off and retried, a ghost answer that was all reasoning, where a chat insertion
   * landed in the editor and how the author settled it). The note goes on the newest row of that
   * request id (or of the id with a suffix the caller added, `:step2`, `:regen`); notes on one
   * row are joined with " · ". A no-op while off or when no such row is held.
   */
  annotate(requestId: string, note: string): void {
    if (!this.enabled()) return
    const row = [...this.requests]
      .reverse()
      .find((r) => r.requestId === requestId || r.requestId?.startsWith(`${requestId}:`) === true)
    if (row === undefined) return
    const text = cut(redactSecrets(note), DEV_LOG_MESSAGE_MAX)
    row.note = row.note === null ? text : `${row.note} · ${text}`
    this.deliver(() => this.deps.onRequest({ ...row }))
  }

  /** One row's held prompt and answer, or null when it is gone or the switch is off. */
  text(id: number): DevRequestText | null {
    if (!this.enabled()) return null
    const held = this.texts.get(id)
    if (held === undefined) return null
    return {
      messages: held.messages.map((m) => ({ role: m.role, content: m.content })),
      response: held.response
    }
  }

  /** The request path's observer: a live trace while on, a no-op one while off. */
  readonly observer: AiRequestObserver = {
    start: (info) => {
      if (!this.enabled()) return NOOP_TRACE
      const started = this.now()
      const row = this.newRow({
        feature: info.feature,
        requestId: info.requestId,
        tier: info.tier,
        promptVersion: info.promptVersion,
        streamed: info.streamed,
        status: 'running'
      })
      this.addRow(row)
      const held: HeldText = { messages: capMessages(info.messages), response: null }
      this.texts.set(row.id, held)
      row.hasText = true
      const elapsed = (): number => this.now() - started
      const push = (): void => {
        if (this.requests.includes(row)) this.deliver(() => this.deps.onRequest({ ...row }))
      }
      return {
        prepared: ({ provider, model, tier, maxTokens, reasoning }) => {
          row.provider = provider
          row.model = model
          row.tier = tier
          row.maxTokens = maxTokens
          row.reasoning = reasoning
          push()
        },
        sent: () => {
          row.waitMs = elapsed()
          push()
        },
        firstToken: () => {
          row.firstTokenMs = elapsed()
          push()
        },
        done: ({ text, usage, costUsd, cached, finishReason }) => {
          row.status = cached ? 'cached' : 'ok'
          row.totalMs = elapsed()
          row.inputTokens = usage.inputTokens
          row.outputTokens = usage.outputTokens
          row.cachedTokens = usage.cachedInputTokens ?? null
          row.reasoningTokens = usage.reasoningTokens ?? null
          row.costUsd = costUsd
          row.finishReason = finishReason
          row.answerChars = text.length
          held.response = text.slice(0, DEV_TEXT_MAX)
          push()
        },
        failed: (err) => {
          const code = errorCode(err)
          row.status = code === 'CANCELLED' ? 'cancelled' : 'failed'
          row.totalMs = elapsed()
          row.errorCode = code
          row.errorMessage = redactSecrets(err instanceof Error ? err.message : String(err))
          push()
          if (row.status === 'failed') {
            this.record(
              'error',
              'ai',
              `${row.feature} failed: ${code}: ${row.errorMessage}`,
              `model ${row.model ?? '-'} · provider ${row.provider ?? '-'} · request ${row.requestId ?? '-'}`
            )
          }
        }
      }
    }
  }

  private newRow(
    base: Pick<
      DevAiRequest,
      'feature' | 'requestId' | 'tier' | 'promptVersion' | 'streamed' | 'status'
    >
  ): DevAiRequest {
    return {
      ...base,
      id: this.nextRequestId++,
      provider: null,
      model: null,
      startedAt: new Date(this.now()).toISOString(),
      waitMs: null,
      firstTokenMs: null,
      totalMs: null,
      maxTokens: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      reasoning: null,
      costUsd: null,
      finishReason: null,
      answerChars: null,
      errorCode: null,
      errorMessage: null,
      note: null,
      hasText: false
    }
  }

  private addRow(row: DevAiRequest): void {
    this.requests.push(row)
    while (this.requests.length > DEV_AI_MAX) {
      const gone = this.requests.shift()
      if (gone) this.texts.delete(gone.id)
    }
    this.deliver(() => this.deps.onRequest({ ...row }))
  }

  private deliver(send: () => void): void {
    if (this.delivering) return
    this.delivering = true
    try {
      send()
    } catch {
      // A window that went away mid-send; the entry is kept and the next snapshot has it.
    } finally {
      this.delivering = false
    }
  }

  private dropAll(): void {
    this.log = []
    this.requests = []
    this.texts.clear()
  }
}

const NOOP_TRACE: AiRequestTrace = {
  prepared: () => undefined,
  sent: () => undefined,
  firstToken: () => undefined,
  done: () => undefined,
  failed: () => undefined
}

function errorCode(err: unknown): string {
  if (err instanceof AiProviderError) return err.code
  if (err instanceof AppError) return err.code
  return 'INTERNAL'
}

/** The messages as held for "Show text": copied, and cut so one request holds at most `DEV_TEXT_MAX`. */
function capMessages(messages: AiMessage[]): AiMessage[] {
  let left = DEV_TEXT_MAX
  return messages.map((m) => {
    const content = m.content.slice(0, Math.max(0, left))
    left -= content.length
    return { role: m.role, content }
  })
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
