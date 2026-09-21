import { z } from 'zod'
import { AI_FEATURE_IDS, type AiFeatureId } from './ai'

/**
 * Opt-in diagnostics (F-15.8): anonymous usage counts and scrubbed crash reports, off by
 * default. Shared because main records them, the renderer explains and toggles them, and the
 * Worker validates the same shapes — so "content-scrubbed" is enforced by the schema on both
 * sides of the wire rather than by a promise.
 *
 * What a report never carries: manuscript text, document or project names, file paths, the
 * author's account, and anything that links two reports (there is no install id).
 */

/** The counters that are not per AI feature; the wire enum below is these plus `ai.request.*`. */
const APP_COUNTERS = [
  'app.launch',
  'project.create',
  'project.open',
  'export.run',
  'focus.enter',
  'proposal.accept',
  'proposal.reject'
] as const

/**
 * Every counter the app may increment. A fixed set: a counter outside it cannot be recorded and
 * cannot be sent, so no call site can invent a name that carries content.
 */
export type DiagnosticCounter = (typeof APP_COUNTERS)[number] | `ai.request.${AiFeatureId}`

export const DIAGNOSTIC_COUNTERS: readonly DiagnosticCounter[] = [
  ...APP_COUNTERS,
  ...AI_FEATURE_IDS.map((feature): DiagnosticCounter => `ai.request.${feature}`)
]

export const DiagnosticCounter = z.enum(DIAGNOSTIC_COUNTERS)

/** The counter one AI feature's requests are counted under (F-5.14 names the features). */
export function aiRequestCounter(feature: AiFeatureId): DiagnosticCounter {
  return `ai.request.${feature}`
}

/** A local calendar day, `YYYY-MM-DD` (`dayOf` in `main/ai/dailyCap.ts` writes them). */
export const DiagnosticDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
export type DiagnosticDay = z.infer<typeof DiagnosticDay>

/** Counts for one day. Partial: a counter that never fired has no key, not a zero. */
export const DiagnosticCounterTally = z.partialRecord(
  DiagnosticCounter,
  z.number().int().nonnegative()
)
export type DiagnosticCounterTally = z.infer<typeof DiagnosticCounterTally>

/** Everything counted so far, by day; days older than `DIAGNOSTIC_DAYS_MAX` are dropped. */
export const DiagnosticCounts = z.record(DiagnosticDay, DiagnosticCounterTally)
export type DiagnosticCounts = z.infer<typeof DiagnosticCounts>

/** One row on the wire: this counter fired this often on this day. */
export const DiagnosticCountRow = z.object({
  day: DiagnosticDay,
  counter: DiagnosticCounter,
  n: z.number().int().positive()
})
export type DiagnosticCountRow = z.infer<typeof DiagnosticCountRow>

/** Highest `n` one report may carry for one counter on one day; more is clamped, not refused. */
export const DIAGNOSTIC_COUNT_MAX = 10_000
/** Rows one report may carry (days × counters); beyond it the oldest days are left for later. */
export const DIAGNOSTIC_ROWS_MAX = 200
/** Crash reports kept while waiting to be sent; beyond it new ones are dropped, not stored. */
export const DIAGNOSTIC_QUEUE_MAX = 10
/** Days of counts kept; an older day is dropped unsent (the app was offline that long). */
export const DIAGNOSTIC_DAYS_MAX = 14

/** Where a crash came from. Never a native minidump: process memory can hold manuscript text. */
export const CRASH_KINDS = ['main', 'renderer', 'processGone'] as const
export const CrashKind = z.enum(CRASH_KINDS)
export type CrashKind = z.infer<typeof CrashKind>

/** Longest scrubbed error message kept or sent; a longer one is cut with an ellipsis. */
export const CRASH_MESSAGE_MAX = 300
export const CRASH_NAME_MAX = 100
/** Stack frames kept, top-down; deeper ones are dropped. */
export const CRASH_STACK_FRAMES = 20
export const CRASH_FRAME_MAX = 200
/** Version, platform, arch, Electron: short identifiers, never free text. */
export const CRASH_FIELD_MAX = 40

/**
 * What identifies the build a report came from — and nothing else. Four short strings shared by
 * every report of one run, so two reports from the same install cannot be told apart.
 */
export const DiagnosticsEnvironment = z.object({
  appVersion: z.string().max(CRASH_FIELD_MAX),
  platform: z.string().max(CRASH_FIELD_MAX),
  arch: z.string().max(CRASH_FIELD_MAX),
  electron: z.string().max(CRASH_FIELD_MAX)
})
export type DiagnosticsEnvironment = z.infer<typeof DiagnosticsEnvironment>

/** One crash: the error's class, its scrubbed message, and the app frames of its stack. */
export const CrashReport = DiagnosticsEnvironment.extend({
  kind: CrashKind,
  name: z.string().max(CRASH_NAME_MAX),
  message: z.string().max(CRASH_MESSAGE_MAX),
  stack: z.array(z.string().max(CRASH_FRAME_MAX)).max(CRASH_STACK_FRAMES)
})
export type CrashReport = z.infer<typeof CrashReport>

/** What the app remembers about diagnostics between runs; lives in app-state.json. */
export const DiagnosticsSettings = z.object({
  /** Installs off. Nothing is recorded while it is off, so nothing exists to send. */
  enabled: z.boolean().default(false),
  counts: DiagnosticCounts.default({}),
  queue: z.array(CrashReport).max(DIAGNOSTIC_QUEUE_MAX).default([]),
  /** The last day whose counts left the machine; shown in Settings, never sent. */
  lastSentDay: DiagnosticDay.nullable().default(null)
})
export type DiagnosticsSettings = z.infer<typeof DiagnosticsSettings>

export function defaultDiagnosticsSettings(): DiagnosticsSettings {
  return { enabled: false, counts: {}, queue: [], lastSentDay: null }
}

/** Longest `pending` preview the Settings tab is handed (the body is capped well below it). */
export const DIAGNOSTICS_PENDING_MAX = 64 * 1024

/**
 * What the Diagnostics tab reads. `pending` is the next report as JSON — the exact bytes that
 * would be sent, pretty-printed — so "see exactly what would be sent" is not a paraphrase.
 */
export const DiagnosticsState = z.object({
  enabled: z.boolean(),
  pending: z.string().max(DIAGNOSTICS_PENDING_MAX),
  lastSentDay: DiagnosticDay.nullable()
})
export type DiagnosticsState = z.infer<typeof DiagnosticsState>

/**
 * What a renderer error may carry over IPC before main scrubs it. Generous, because the raw
 * text is thrown away: what is stored is `scrubMessage` and `scrubStack` of it, within the
 * crash caps above.
 */
export const RENDERER_ERROR_NAME_MAX = 200
export const RENDERER_ERROR_MESSAGE_MAX = 2_000
export const RENDERER_ERROR_STACK_MAX = 10_000

/** First flush after start: late enough that it never competes with the first window. */
export const DIAGNOSTICS_FLUSH_DELAY_MS = 30_000
/** How often the app flushes after that, while it stays open. */
export const DIAGNOSTICS_FLUSH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** What a stack frame outside the app bundle becomes; the app never sends another program's paths. */
export const EXTERNAL_FRAME = '<external>'

const QUOTED_TEXT = [
  /'[^'\n]*'/g,
  /"[^"\n]*"/g,
  /`[^`\n]*`/g,
  /\u201c[^\u201d\n]*\u201d/g,
  /\u2018[^\u2019\n]*\u2019/g
]
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi
const EMAIL_LIKE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
/**
 * A path: an absolute one (optionally drive-lettered, either separator, UNC's double leading
 * separator included) or any token with a separator inside it, which is what the tail of an
 * absolute path with a space in a folder name looks like after the first match.
 */
const PATH_LIKE = /(?:[A-Za-z]:)?[\\/]+(?:[\w.~$@+%-]+[\\/]*)+|[\w.~$@+%-]+(?:[\\/]+[\w.~$@+%-]*)+/g

/**
 * An error message with every piece of content taken out of it: quoted text (which is how
 * manuscript text reaches an error), URLs, email addresses, and file paths — then whitespace
 * collapsed and the result capped at `CRASH_MESSAGE_MAX`. Over-scrubbing is the intended
 * trade: a less readable message is better than one that carries a sentence of the novel.
 */
export function scrubMessage(text: string): string {
  let out = text
  for (const quoted of QUOTED_TEXT) out = out.replace(quoted, '<text>')
  out = out.replace(URL_LIKE, '<url>')
  out = out.replace(EMAIL_LIKE, '<email>')
  out = out.replace(PATH_LIKE, '<path>')
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length <= CRASH_MESSAGE_MAX) return out
  return `${out.slice(0, CRASH_MESSAGE_MAX - 1).trimEnd()}\u2026`
}

/**
 * The frames of a stack, app-relative. A frame inside one of `roots` (the app bundle) becomes
 * its path relative to that root with the line and column kept — `out/main/index.js:12:3` — and
 * every other frame becomes `<external>`, so no frame ever names a folder on the machine.
 * Function names are left out: they add nothing a file and a line do not.
 */
export function scrubStack(
  stack: string | readonly string[] | null | undefined,
  roots: readonly string[]
): string[] {
  if (stack === null || stack === undefined) return []
  const lines = (typeof stack === 'string' ? [stack] : stack).flatMap((part) => part.split('\n'))
  const normalizedRoots = roots.map(normalizePath).filter((root) => root.length > 0)
  const frames: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    // Only frames; the message line above them is reported as `message`, already scrubbed.
    if (!trimmed.startsWith('at ')) continue
    if (frames.length === CRASH_STACK_FRAMES) break
    frames.push(scrubFrame(trimmed, normalizedRoots))
  }
  return frames
}

/** The location a frame points at: what is in the last parentheses, or what follows `at `. */
function frameLocation(frame: string): string {
  const parens = /\(([^()]*)\)\s*$/.exec(frame)
  if (parens?.[1] !== undefined) return parens[1].trim()
  return frame.slice(3).trim()
}

function scrubFrame(frame: string, roots: readonly string[]): string {
  const location = normalizePath(stripFileUrl(frameLocation(frame)))
  if (location.length === 0) return EXTERNAL_FRAME
  const lower = location.toLowerCase()
  for (const root of roots) {
    const prefix = `${root.toLowerCase()}/`
    if (!lower.startsWith(prefix)) continue
    const relative = location.slice(prefix.length)
    if (relative.length === 0) return EXTERNAL_FRAME
    return relative.slice(0, CRASH_FRAME_MAX)
  }
  return EXTERNAL_FRAME
}

/** Backslashes become slashes and a trailing one is dropped, so roots and frames compare. */
function normalizePath(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  return slashed.length > 1 && slashed.endsWith('/') ? slashed.slice(0, -1) : slashed
}

/** `file:///home/a/b.js` → `/home/a/b.js`, `file:///C:/a/b.js` → `C:/a/b.js`. */
function stripFileUrl(location: string): string {
  if (!location.startsWith('file://')) return location
  const withoutScheme = location.slice('file://'.length)
  return /^\/[A-Za-z]:/.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme
}
