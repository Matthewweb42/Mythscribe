import { z } from 'zod'

/**
 * Automatic updates (F-15.7): the channels, what the app remembers between runs, and what the
 * Settings tab shows. Shared because main owns the updater and the renderer only displays what
 * it reports; the release notes are turned into plain text here so both sides agree on the
 * words and nothing ever renders provider HTML.
 */

export const UPDATE_CHANNELS = ['stable', 'beta'] as const
export const UpdateChannel = z.enum(UPDATE_CHANNELS)
export type UpdateChannel = z.infer<typeof UpdateChannel>

export const UPDATE_CHANNEL_LABEL: Record<UpdateChannel, string> = {
  stable: 'Stable',
  beta: 'Beta'
}

/** One plain sentence per channel, shown beside the choice. */
export const UPDATE_CHANNEL_MEANING: Record<UpdateChannel, string> = {
  stable: 'Released builds, the ones everyone gets.',
  beta: 'Earlier builds that may have rough edges.'
}

/** Longest release-notes text kept or shown; a longer one is cut with an ellipsis. */
export const RELEASE_NOTES_MAX = 8000

/** The notes of one release, as plain text: what "What's new" and the ready state show. */
export const ReleaseNotes = z.object({
  version: z.string(),
  /** The release date as the provider reported it (ISO), or null when it said nothing. */
  date: z.string().nullable(),
  text: z.string().max(RELEASE_NOTES_MAX)
})
export type ReleaseNotes = z.infer<typeof ReleaseNotes>

/** What the app remembers about updates between runs; lives in app-state.json. */
export const UpdateSettings = z.object({
  channel: UpdateChannel.default('stable'),
  /** Whether the app checks by itself; the manual check works either way. */
  autoCheck: z.boolean().default(true),
  /**
   * The notes of the update that was downloaded last. While that version is not the running
   * one they are the pending update's; once it is, they are "what's new in this version".
   */
  installedNotes: ReleaseNotes.nullable().default(null),
  /** The version whose notes the author has already seen, so they are shown once. */
  lastSeenVersion: z.string().nullable().default(null)
})
export type UpdateSettings = z.infer<typeof UpdateSettings>

export function defaultUpdateSettings(): UpdateSettings {
  return { channel: 'stable', autoCheck: true, installedNotes: null, lastSeenVersion: null }
}

/**
 * Where the update stands right now. `unsupported` is a development build or a Linux package
 * that is updated by its package manager; `ready` means the download is on disk and only a
 * restart is left.
 */
export const UpdateStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unsupported'), reason: z.string() }),
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('checking') }),
  z.object({ state: z.literal('upToDate'), checkedAt: z.string() }),
  z.object({
    state: z.literal('downloading'),
    version: z.string(),
    percent: z.number().int().min(0).max(100)
  }),
  z.object({ state: z.literal('ready'), version: z.string(), notes: ReleaseNotes }),
  z.object({ state: z.literal('error'), message: z.string(), nextStep: z.string() })
])
export type UpdateStatus = z.infer<typeof UpdateStatus>

/** Everything the Updates tab and the header notice read; main answers it whole. */
export const UpdateState = z.object({
  currentVersion: z.string(),
  channel: UpdateChannel,
  autoCheck: z.boolean(),
  status: UpdateStatus,
  installedNotes: ReleaseNotes.nullable(),
  /** The running version's notes have not been shown yet (the app was just updated). */
  unseenNotes: z.boolean()
})
export type UpdateState = z.infer<typeof UpdateState>

/** What to do about a failed check or download, wherever it is shown. */
export const UPDATE_ERROR_NEXT_STEP =
  'Check your connection and try again, or download the installer from mythscribe.app.'

/** First automatic check after start: late enough that it never competes with the first window. */
export const UPDATE_CHECK_DELAY_MS = 10_000

/** How often the app checks after that, while it stays open. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * The channel name the updater asks GitHub for: the stable releases publish `latest.yml`, the
 * beta ones `beta.yml`. A beta install also accepts a newer stable release (electron-updater
 * walks the release feed with `allowPrerelease` on and falls back to `latest.yml`), which is
 * what "no downgrade" means here: a beta stays installed until a newer stable ships.
 */
export function updaterChannelFor(channel: UpdateChannel): string {
  return channel === 'beta' ? 'beta' : 'latest'
}

/** One version's notes as the GitHub provider reports them in the multi-version form. */
export interface ReleaseNoteEntry {
  version: string
  note: string | null
}

/**
 * The release notes as plain text. GitHub hands electron-updater the release body as HTML (or
 * one entry per version), and nothing in the app renders HTML, so tags become text here: list
 * items become `- ` lines, paragraphs, breaks and headings become newlines, the five basic
 * entities are decoded, blank runs collapse, and the result is capped at `RELEASE_NOTES_MAX`.
 */
export function releaseNotesText(raw: string | ReleaseNoteEntry[] | null | undefined): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return cap(plainText(raw))
  const sections = raw
    .map((entry) => {
      const body = plainText(entry.note ?? '')
      return body.length === 0 ? '' : `Version ${entry.version}\n${body}`
    })
    .filter((section) => section.length > 0)
  return cap(sections.join('\n\n'))
}

/**
 * Tags that end a block of text; the text after them starts on its own line. `</li>` is not
 * one of them: the `- ` an item opens with already starts its line, and a second newline would
 * put a blank line between the items of one list.
 */
const BLOCK_END = /<\/(?:p|div|h[1-6]|ul|ol|blockquote|tr|pre)\s*>/gi
const LINE_BREAK = /<br\s*\/?>/gi
const LIST_ITEM = /<li\b[^>]*>/gi
const HEADING_START = /<(?:p|div|h[1-6]|blockquote|pre)\b[^>]*>/gi
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

function plainText(html: string): string {
  const stripped = html
    .replace(SCRIPT_OR_STYLE, '')
    .replace(LINE_BREAK, '\n')
    .replace(LIST_ITEM, '\n- ')
    .replace(HEADING_START, '\n')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]*>/g, '')
  return collapse(decodeEntities(stripped))
}

/** The five entities a release body realistically carries; `&amp;` last so nothing decodes twice. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, '&')
}

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cap(text: string): string {
  if (text.length <= RELEASE_NOTES_MAX) return text
  return `${text.slice(0, RELEASE_NOTES_MAX - 1).trimEnd()}…`
}
