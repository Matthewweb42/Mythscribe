import { z } from 'zod'
import { AI_FEATURE_IDS, AiFeatureId } from './ai'
import { DEFAULT_HONESTY, Honesty } from './critique'

/** Settings-table key under which the AI dial and toggles (F-14.4) are stored as JSON. */
export const AI_SETTINGS_KEY = 'ai'

/** The AI dial (PLAN.md §2.3), monotonic: each level includes everything below it. */
export const AiDial = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
export type AiDial = z.infer<typeof AiDial>
export const AI_DIAL_LEVELS: readonly AiDial[] = [0, 1, 2, 3]

export const AI_DIAL_LABEL: Record<AiDial, string> = {
  0: 'Off',
  1: 'Ask',
  2: 'Suggest',
  3: 'Draft'
}

/** One-line meaning per level (PLAN.md §2.3's table); shown under each radio. */
export const AI_DIAL_MEANING: Record<AiDial, string> = {
  0: 'Nothing leaves this machine.',
  1: 'Queries, summaries, tag suggestions, and critique, on request.',
  2: 'Adds ghost text and rewrite-in-my-voice.',
  3: 'Adds multi-paragraph drafting proposals.'
}

/** Bounds for the ghost-text idle delay (F-5.3): the spec's 0.5–5 s, stored in milliseconds. */
export const GHOST_IDLE_MS_MIN = 500
export const GHOST_IDLE_MS_MAX = 5_000
export const DEFAULT_GHOST_IDLE_MS = 1_500

/**
 * The VibeWrite mode (F-5.3), per project. `enabled` is the toolbar toggle's state, the
 * author's moment-to-moment "write with me" switch; it is independent of `features.ghostText`,
 * the dial's per-feature gate (F-14.4), which decides whether ghost text may ever run. Both
 * must be on (and the dial at Suggest) before a request leaves.
 */
export const GhostTextSettings = z.object({
  enabled: z.boolean(),
  idleMs: z.number().int().min(GHOST_IDLE_MS_MIN).max(GHOST_IDLE_MS_MAX)
})
export type GhostTextSettings = z.infer<typeof GhostTextSettings>

export function defaultGhostTextSettings(): GhostTextSettings {
  return { enabled: false, idleMs: DEFAULT_GHOST_IDLE_MS }
}

/**
 * Where this project's AI requests go (F-15.4): straight to the provider with the author's own
 * key, or through the MythScribe Cloud proxy against the account's credits. Per project, so one
 * manuscript can be on Cloud while another stays on a personal key.
 */
export const AiSource = z.enum(['ownKey', 'cloud'])
export type AiSource = z.infer<typeof AiSource>

export const AI_SOURCE_LABEL: Record<AiSource, string> = {
  ownKey: 'My own key',
  cloud: 'MythScribe Cloud'
}

/** One-line meaning per option; shown under each radio in the AI tab. */
export const AI_SOURCE_MEANING: Record<AiSource, string> = {
  ownKey: 'Calls go straight to OpenAI with the key below; nothing is paid to MythScribe.',
  cloud: 'Calls go through MythScribe Cloud and are charged to your credits at the published rate.'
}

/** The editor's-notes settings (F-14.8), per project: how blunt the critique is. */
export const CritiqueSettings = z.object({ honesty: Honesty })
export type CritiqueSettings = z.infer<typeof CritiqueSettings>

export function defaultCritiqueSettings(): CritiqueSettings {
  return { honesty: DEFAULT_HONESTY }
}

/** Every toggle on: raising the dial is the one act that enables anything (F-14.4). */
export function defaultFeatureToggles(): Record<AiFeatureId, boolean> {
  return Object.fromEntries(AI_FEATURE_IDS.map((id) => [id, true])) as Record<AiFeatureId, boolean>
}

export const AiSettings = z.object({
  dial: AiDial,
  /**
   * One toggle per feature. A stored row from before a feature existed lacks its key, so the
   * missing toggles are filled from the defaults (on) instead of the whole row falling back
   * and resetting the dial (F-14.10 added `rewrite` after projects had settings rows).
   */
  features: z
    .partialRecord(AiFeatureId, z.boolean())
    .transform((stored) => ({ ...defaultFeatureToggles(), ...stored })),
  /** Defaulted, so a row stored before F-5.3 (no `ghostText` key) still parses instead of falling back wholesale. */
  ghostText: GhostTextSettings.default(defaultGhostTextSettings),
  /** Defaulted likewise for a row stored before F-14.8. */
  critique: CritiqueSettings.default(defaultCritiqueSettings),
  /** Defaulted likewise for a row stored before F-15.4: an existing project keeps its own key. */
  source: AiSource.default('ownKey')
})
export type AiSettings = z.infer<typeof AiSettings>
/** The shape before parsing: `ghostText` may be absent (a row stored before F-5.3) and `features` may lack newer ids. */
export type AiSettingsInput = z.input<typeof AiSettings>

/** Installs at Off (F-14.4) with every toggle on, so raising the dial is the one act that enables anything. */
export function defaultAiSettings(): AiSettings {
  return {
    dial: 0,
    features: defaultFeatureToggles(),
    ghostText: defaultGhostTextSettings(),
    critique: defaultCritiqueSettings(),
    source: 'ownKey'
  }
}

export interface AiDataSharing {
  /** How Settings names the feature, in the toggles, the data-sharing table, and the Usage block. */
  label: string
  /** Exactly what leaves the machine when the feature runs; the rule "no text the panel does not list" refers to this. */
  sends: string
  /** The lowest dial level at which the feature may run. */
  minDial: AiDial
}

/**
 * The one registry of what each feature sends and the dial level it needs (CLAUDE.md, author
 * control rule 3). `isFeatureAllowed` and the panel's disabled state read the same `minDial`,
 * so the table can never disagree with the gate. Exhaustive over `AiFeatureId` by type and by
 * test. `chat` is Plan-mode conversation that drafts nothing into the manuscript, so it sits at
 * Ask with the other cited, on-request features.
 */
/**
 * What the story bible block (F-14.9, `renderStoryBible`) carries, phrased once for every
 * feature whose prompt includes it, so the panel and the block can never drift apart.
 */
export const STORY_BIBLE_SENDS =
  "the story bible (your tag names by category, the scene's tags, and the titles, " +
  'metadata, and summaries of the scenes either side of it)'

export const AI_DATA_SHARING: Record<AiFeatureId, AiDataSharing> = {
  tags: {
    label: 'Tag suggestions',
    sends: "The current document's text and the existing tag names.",
    minDial: 1
  },
  summary: {
    label: 'Scene summaries',
    sends:
      "A scene's text (the first 20,000 characters), its metadata, and the names of your " +
      'character tags, to keep its summary, key points, and characters present up to date ' +
      'after you pause typing.',
    minDial: 1
  },
  query: {
    label: 'Story Intelligence',
    sends: 'Your question, scene summaries, and the full text of the top matching scenes.',
    minDial: 1
  },
  critique: {
    label: "Editor's notes",
    sends:
      "The scene's text (the first 20,000 characters), its metadata, its brief plus the " +
      "previous scene's reader-knows-after line and the next scene's goal, the voice profile " +
      '(stylometric rules and up to 3 exemplar passages), your author rules and banned ' +
      `phrases, and ${STORY_BIBLE_SENDS}.`,
    minDial: 1
  },
  betaReader: {
    label: 'Beta reader',
    sends:
      "The scene's text (the first 20,000 characters) and the stored summaries and key points " +
      'of every manuscript scene before it, in reading order, so a first-time reader can report ' +
      'what they know, believe, and expect. No voice profile, no story bible: the reader knows ' +
      'only what is on the page.',
    minDial: 1
  },
  brief: {
    label: 'Scene brief drafts',
    sends:
      "The scene's text (the first 20,000 characters) and its metadata (location, POV, " +
      'timeline), to draft the five brief lines for you to correct.',
    minDial: 1
  },
  chat: {
    label: 'Assistant chat',
    sends:
      "The active scene's text (head-truncated), the notes of documents tagged with any #name " +
      `you mention, ${STORY_BIBLE_SENDS}, the recent turns of the conversation, and your ` +
      'message. In Agent mode, which needs Suggest, the voice profile, your author rules and ' +
      "banned phrases, the scene metadata, and the scene brief (plus the previous scene's " +
      "reader-knows-after line and the next scene's goal) go too, and an off-voice answer is " +
      'sent back once with the rule it broke.',
    minDial: 1
  },
  embeddings: {
    label: 'Search indexing',
    sends: 'Chunks of scene text, to compute embeddings for search.',
    minDial: 1
  },
  ghostText: {
    label: 'Ghost text',
    sends:
      'Up to 500 characters of text before the cursor and 100 after it, plus the scene’s notes, ' +
      "its metadata (location, POV, timeline), its brief plus the previous scene's " +
      "reader-knows-after line and the next scene's goal, the voice profile (stylometric rules " +
      'and up to 3 exemplar passages), your author rules and banned phrases, and ' +
      `${STORY_BIBLE_SENDS}. An answer that breaks the voice profile or uses a banned phrase is ` +
      'sent back once, with the same context plus the rule it broke, for a second try.',
    minDial: 2
  },
  rewrite: {
    label: 'Rewrite in my voice',
    sends:
      'The selected passage (up to 4,000 characters), up to 300 characters of manuscript text ' +
      'before and after it, the scene metadata (location, POV, timeline), the voice profile ' +
      '(stylometric rules and up to 3 exemplar passages), your author rules and banned ' +
      `phrases, and ${STORY_BIBLE_SENDS}. An off-voice rewrite is sent back once with the rule ` +
      'it broke; a regenerate carries your note.',
    minDial: 2
  },
  authorMode: {
    label: 'Author mode',
    sends: "The active scene's text, referenced notes, the scene brief, and your instruction.",
    minDial: 3
  }
}

/** The features in display order: by the level they need, then as `AI_FEATURE_IDS` lists them. */
export const AI_FEATURES_BY_LEVEL: readonly AiFeatureId[] = [...AI_FEATURE_IDS].sort(
  (a, b) => AI_DATA_SHARING[a].minDial - AI_DATA_SHARING[b].minDial
)

/** True only when the dial is high enough for `feature` and its own toggle is on. */
export function isFeatureAllowed(settings: AiSettings, feature: AiFeatureId): boolean {
  return settings.dial >= AI_DATA_SHARING[feature].minDial && settings.features[feature]
}
