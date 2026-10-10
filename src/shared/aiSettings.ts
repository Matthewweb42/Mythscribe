import { z } from 'zod'
import { AI_FEATURE_IDS, AiFeatureId, type AiProviderId, type OwnKeyProvider } from './ai'
import { DEFAULT_HONESTY, Honesty } from './critique'

/** Settings-table key under which the AI dial and toggles (F-14.4) are stored as JSON. */
export const AI_SETTINGS_KEY = 'ai'

/**
 * The stored AI level (F-14.4, narrowed by F-5.21): 0 Off, 1 on. Since 2026-10-07 it is the
 * "Use AI" control in Settings › AI (decided by the author): off means nothing leaves the
 * machine. A row stored while the dial had four levels may carry 2 (Suggest) or 3 (Draft); both
 * read as 1, on. How the chat acts once AI is on is `AiSettings.chatMode`.
 */
export const AiDial = z
  .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
  .transform((level): 0 | 1 => (level === 0 ? 0 : 1))
export type AiDial = z.output<typeof AiDial>

/** What the one on/off control is called in Settings › AI and in the new-project wizard. */
export const USE_AI_LABEL = 'Use AI'

/** One-line meaning of each state of Use AI; shown in Settings, the wizard, and the docs page. */
export const USE_AI_MEANING = {
  on: 'AI features on. The assistant works in the mode picked under the chat box.',
  off: 'No AI at all. Nothing leaves this machine.'
} as const

/**
 * The assistant chat's mode (decided by the author 2026-10-07; replaces the F-5.21 switch's Ask
 * and Auto and the chat's Query, Author, and Plan modes): one setting per project, picked under
 * the chat box. Auto: the chat agent (F-5.22) looks things up, answers with sources, and makes
 * its own edits, each logged with Undo (deletions still ask). Ask: the same agent, every edit
 * waiting for Apply. Plan: the agent with read-only tools, to discuss and brainstorm; it never
 * proposes or makes an edit. The mode governs the chat only: edit passes always return tracked
 * changes and background indexing runs whenever AI is on.
 */
export const ASSISTANT_MODES = ['auto', 'ask', 'plan'] as const
export const AssistantMode = z.enum(ASSISTANT_MODES)
export type AssistantMode = z.infer<typeof AssistantMode>
/** New projects start the chat in Ask (decided by the author 2026-10-07). */
export const DEFAULT_ASSISTANT_MODE: AssistantMode = 'ask'

export const ASSISTANT_MODE_LABEL: Record<AssistantMode, string> = {
  auto: 'Auto',
  ask: 'Ask',
  plan: 'Plan'
}

/** One-line meaning per mode: the tooltip of each option under the chat box, and the docs page. */
export const ASSISTANT_MODE_MEANING: Record<AssistantMode, string> = {
  auto:
    'The assistant looks things up, answers with sources, and makes its edits itself, each ' +
    'with Undo; deletions still ask.',
  ask:
    'The assistant looks things up and answers with sources; every edit it wants to make ' +
    'waits for your Apply.',
  plan:
    'The assistant reads the whole project to discuss and brainstorm with you; it never ' +
    'proposes or makes edits.'
}

/**
 * The AI level the new-project wizard (F-5.18) and `project:create` speak: `off` is Use AI off,
 * `ask` and `auto` are Use AI on with that chat mode. The wizard offers only `off` and `ask`
 * since 2026-10-07; `auto` stays in the contract.
 */
export const AI_SWITCH_POSITIONS = ['off', 'ask', 'auto'] as const
export const AiSwitch = z.enum(AI_SWITCH_POSITIONS)
export type AiSwitch = z.infer<typeof AiSwitch>

/** The settings fields one wizard position writes. */
export function aiSwitchPatch(position: AiSwitch): Pick<AiSettings, 'dial' | 'chatMode'> {
  return {
    dial: position === 'off' ? 0 : 1,
    chatMode: position === 'auto' ? 'auto' : DEFAULT_ASSISTANT_MODE
  }
}

/**
 * The chat mode a stored row stands at. A row from before 2026-10-07 has no `chatMode` and never
 * gains autonomy silently (decided by the author): the F-5.21 switch at Auto (on, with `auto`
 * true) becomes Auto, anything else Ask.
 */
export function storedAssistantMode(row: {
  dial: AiDial
  auto?: boolean | undefined
  chatMode?: AssistantMode | undefined
}): AssistantMode {
  if (row.chatMode !== undefined) return row.chatMode
  return row.dial !== 0 && row.auto === true ? 'auto' : DEFAULT_ASSISTANT_MODE
}

/** The label for a stored level, as gate messages name it. */
export const AI_DIAL_LABEL: Record<AiDial, string> = { 0: 'Off', 1: 'On' }

/** Bounds for the ghost-text idle delay (F-5.3): the spec's 0.5–5 s, stored in milliseconds. */
export const GHOST_IDLE_MS_MIN = 500
export const GHOST_IDLE_MS_MAX = 5_000
export const DEFAULT_GHOST_IDLE_MS = 1_500

/**
 * The VibeWrite mode (F-5.3), per project. `enabled` is the toolbar toggle's state, the
 * author's moment-to-moment "write with me" switch; it is independent of `features.ghostText`,
 * the dial's per-feature gate (F-14.4), which decides whether ghost text may ever run. Both
 * must be on (and Use AI on) before a request leaves.
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
export const AiSource = z.enum(['ownKey', 'cloud', 'local'])
export type AiSource = z.infer<typeof AiSource>

export const AI_SOURCE_LABEL: Record<AiSource, string> = {
  ownKey: 'My own key',
  cloud: 'MythScribe Cloud',
  local: 'Local model'
}

/**
 * The provider whose models and ledger rows a source uses (F-15.4, F-5.15): on My own key, the
 * provider the key is for (OpenRouter or OpenAI, `AiStatus.provider`).
 */
export function providerForSource(source: AiSource, ownKey: OwnKeyProvider): AiProviderId {
  return source === 'ownKey' ? ownKey : source
}

/**
 * F-5.15: what the AI tab says whenever the local source is chosen. Local models are smaller
 * than the hosted ones, and the voice checks (F-14.7) reject more of what they write.
 */
export const LOCAL_QUALITY_WARNING =
  'Local models are smaller than hosted ones: expect weaker answers, more rejected suggestions, ' +
  'and slower replies, depending on your computer. Every feature still works the same way.'

/** One-line meaning per option; shown under each radio in the AI tab and in the new-project wizard (F-15.11). */
export const AI_SOURCE_MEANING: Record<AiSource, string> = {
  ownKey:
    'Calls go straight to OpenRouter (or OpenAI) with your own API key; nothing is paid to MythScribe.',
  cloud: 'Calls go through MythScribe Cloud and are charged to your credits at the published rate.',
  local:
    'Calls go to a model running on your computer (Ollama, LM Studio); nothing leaves the machine and nothing is charged.'
}

/**
 * The note on the Cloud option in the wizard and in Settings › AI while Cloud does not serve AI
 * yet (`CLOUD_AI_AVAILABLE` in `cloudApi.ts`; decided by the author 2026-10-07).
 */
export const CLOUD_COMING_SOON = 'Coming soon'

/** What Settings › AI says when a project is still stored on Cloud while Cloud does not serve AI. */
export const CLOUD_UNAVAILABLE_NOTICE =
  'MythScribe Cloud isn\u2019t available yet \u2014 choose My own key or Local model.'

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

export const AiSettings = z
  .object({
    dial: AiDial,
    /** F-5.21's Auto bit, read only to migrate a row stored before `chatMode` (2026-10-07). */
    auto: z.boolean().optional(),
    /** The assistant chat's mode; absent on a row stored before 2026-10-07 (`storedAssistantMode`). */
    chatMode: AssistantMode.optional(),
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
  .transform(({ auto, chatMode, ...rest }) => ({
    ...rest,
    chatMode: storedAssistantMode({ dial: rest.dial, auto, chatMode })
  }))
export type AiSettings = z.infer<typeof AiSettings>
/** The shape before parsing: `ghostText` may be absent (a row stored before F-5.3) and `features` may lack newer ids. */
export type AiSettingsInput = z.input<typeof AiSettings>

/** Installs at Off (F-14.4) with every toggle on, so raising the dial is the one act that enables anything. */
export function defaultAiSettings(): AiSettings {
  return {
    dial: 0,
    chatMode: DEFAULT_ASSISTANT_MODE,
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
  /**
   * The lowest stored level at which the feature may run: 1 (Use AI on) for every feature since
   * the one switch (F-5.21); off runs nothing.
   */
  minDial: AiDial
}

/**
 * The one registry of what each feature sends and the dial level it needs (CLAUDE.md, author
 * control rule 3). `isFeatureAllowed` and the panel's disabled state read the same `minDial`,
 * so the table can never disagree with the gate. Exhaustive over `AiFeatureId` by type and by
 * test. Every feature needs only Use AI on and its own toggle.
 */
/**
 * What the story bible block (F-14.9, `renderStoryBible`) carries, phrased once for every
 * feature whose prompt includes it, so the panel and the block can never drift apart.
 */
export const STORY_BIBLE_SENDS =
  "the story bible (your tag names by category, the scene's tags, the sheets of the " +
  'story-bible entries linked to those tags with what the manuscript states about them, and ' +
  'the titles, metadata, and summaries of the scenes either side of it)'

/**
 * F-5.23: the story map, as the data-sharing panel names it: the manuscript's chapter and scene
 * titles in reading order, each scene's progress, the first sentence of each stored summary, and
 * which scene the author is at.
 */
export const STORY_MAP_SENDS =
  'the story map (the chapter and scene titles in reading order, whether each scene is planned, ' +
  'drafted, or revised, the first sentence of each stored scene summary, and which scene you ' +
  'are at)'

export const AI_DATA_SHARING: Record<AiFeatureId, AiDataSharing> = {
  tags: {
    label: 'Tag suggestions',
    sends: "The current document's text and the existing tag names.",
    minDial: 1
  },
  summary: {
    label: 'Scene summaries, story bible, and tags',
    sends:
      "A scene's text (the first 20,000 characters), its metadata, the names of the " +
      'story-bible entries and tags that occur in the scene, and the names of your tone, ' +
      'content, plot-thread, and custom tags, to keep ' +
      'its summary, key points, characters present, the facts it states about your ' +
      'characters, places, and world, and its tags up to date after you pause typing.',
    minDial: 1
  },
  query: {
    label: 'Story Intelligence',
    sends:
      'Your question, scene summaries, the full text of the top matching scenes, the sheets ' +
      'of the story-bible entries your question names with what the manuscript states about ' +
      "them, and the open scene's synopsis and notes (the first 1,500 characters).",
    minDial: 1
  },
  critique: {
    label: "Editor's notes",
    sends:
      "The scene's text (the first 20,000 characters), its metadata, its brief plus the " +
      "previous scene's reader-knows-after line and the next scene's goal, the voice profile " +
      '(stylometric rules, learned style notes, and up to 3 exemplar passages), your author rules and banned ' +
      `phrases, and ${STORY_BIBLE_SENDS}.`,
    minDial: 1
  },
  continuity: {
    label: 'Consistency check',
    sends:
      'The sheets of the story-bible entries named in a scene, what the manuscript states about ' +
      "them in other scenes with the passages, the previous scene's timeline and this scene's, " +
      "the scene's brief plus the previous scene's reader-knows-after line and the next " +
      "scene's goal, and the voice profile (stylometric rules, learned style notes, and up to 3 exemplar passages) " +
      "with your author rules and banned phrases; with them, the scene's text (the first " +
      '20,000 characters) when you ask for a check, or only the paragraphs that state ' +
      'something different when it runs after you pause typing.',
    minDial: 1
  },
  proofread: {
    label: 'Proofread',
    sends:
      "The scene's text (the first 20,000 characters), or only the passage you selected, its " +
      "brief plus the previous scene's reader-knows-after line and the next scene's goal, the " +
      'voice profile (stylometric rules, learned style notes, and up to 3 exemplar passages) with your author rules ' +
      'and banned phrases, and up to 200 words to leave alone: the names of your story-bible ' +
      'entries and tags and the words in the project dictionary.',
    minDial: 1
  },
  whatNext: {
    label: 'What comes next',
    sends:
      'The last 6,000 characters of the scene, or of the text up to the end of the passage you ' +
      "selected, its brief plus the previous scene's reader-knows-after line and the next " +
      `scene's goal, ${STORY_BIBLE_SENDS}, and ${STORY_MAP_SENDS}, only when you click What ` +
      'should come next?.',
    minDial: 1
  },
  route: {
    label: 'Assistant routing',
    sends:
      'Your message (the first 1,000 characters), the last two turns of the conversation (300 ' +
      'characters each), the first 200 characters of the passage you selected, and the open ' +
      "document's kind and title, so the assistant can pick which feature answers you.",
    minDial: 1
  },
  synopsis: {
    label: 'Synopsis suggestions',
    sends:
      "The scene's text (the first 12,000 characters) and its stored summary and key points, " +
      'only when you ask for a suggested synopsis.',
    minDial: 1
  },
  notesSuggest: {
    label: 'Notes suggestions',
    sends:
      "The scene's text (the first 12,000 characters), its stored summary and key points, its " +
      "notes (the first 1,500 characters), its brief plus the previous scene's " +
      "reader-knows-after line and the next scene's goal, " +
      `${STORY_BIBLE_SENDS}, and what you asked to focus on, only when you ask for suggested notes.`,
    minDial: 1
  },
  voiceNotes: {
    label: 'Learned style notes',
    sends:
      'Up to 6,000 characters of your own paragraphs from across the manuscript (never text ' +
      'accepted from the AI) and the previous notes, about once per 5,000 new words, to keep ' +
      'a few notes on how you write that the voice profile carries.',
    minDial: 1
  },
  editPass: {
    label: 'Edit passes',
    sends:
      'Only when you start a pass, the text of each scene you picked, in pieces of up to ' +
      '12,000 characters, with its title and your instruction for a custom pass; for line, ' +
      'copy, proofread, and custom passes the voice profile (stylometric rules, learned style ' +
      'notes, and up to 3 exemplar passages) with your author rules and banned phrases; for ' +
      'copy edits and proofreads up to 200 words to leave alone (the names of your story-bible ' +
      'entries and tags and the project dictionary); for a continuity pass the sheets of the ' +
      'story-bible entries the scene names and what other scenes state about them; for ' +
      "developmental, line, and custom passes the scene's mood and theme as the AI read them.",
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
      "The active scene's text (head-truncated), its synopsis and notes (the first 1,500 " +
      'characters), the notes of documents tagged with any #name ' +
      `you mention, ${STORY_BIBLE_SENDS}, the recent turns of the conversation, and your ` +
      'message. In Author mode, the voice profile, your author rules and ' +
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
      "reader-knows-after line and the next scene's goal, the voice profile (stylometric rules, " +
      'learned style notes, and up to 3 exemplar passages), your author rules and banned phrases, and ' +
      `${STORY_BIBLE_SENDS}. An answer that breaks the voice profile or uses a banned phrase is ` +
      'sent back once, with the same context plus the rule it broke, for a second try.',
    minDial: 1
  },
  importStructure: {
    label: 'Import structure detection',
    sends:
      'The manuscript you are importing, in chunks of about 2,500 words (long paragraphs ' +
      'shortened), and your tag names, only when you ask for the check in the import dialog.',
    minDial: 1
  },
  rewrite: {
    label: 'Rewrite in my voice',
    sends:
      'The selected passage (up to 4,000 characters), up to 300 characters of manuscript text ' +
      'before and after it, the scene metadata (location, POV, timeline), the voice profile ' +
      '(stylometric rules, learned style notes, and up to 3 exemplar passages), your author rules and banned ' +
      `phrases, ${STORY_BIBLE_SENDS}, and the scene's mood and theme as the AI read them. An ` +
      'off-voice rewrite is sent back once with the rule ' +
      'it broke; a regenerate carries your note.',
    minDial: 1
  },
  agent: {
    label: 'Assistant lookups and edits',
    sends:
      `Your message, the recent turns of the conversation, ${STORY_MAP_SENDS}, the open ` +
      "document's title, synopsis, " +
      'notes (the first 1,500 characters), and stored summary, up to 1,500 characters before ' +
      'the caret and 2,000 of the selected passage, and then, one lookup at a time (at most 6 ' +
      'per message), what the assistant asks to read: a story-bible record as of the open ' +
      'scene (its sheet, what the scenes state, relationships, threads, where it is named, the ' +
      'last scene card), scene cards, matching paragraphs of the manuscript, the outline of ' +
      'titles and word counts, up to 6,000 characters of a document per read, notes, ' +
      'story-bible sheets, tag names, and the To do list. When it may edit, the voice ' +
      'profile (stylometric rules, learned style notes, and up to 3 exemplar passages) and ' +
      'your author rules and banned phrases go too.',
    minDial: 1
  },
  contextImport: {
    label: 'Context library sorting',
    sends:
      'The documents you upload to the Library (Word, Markdown, text, PDF text), in chunks of ' +
      'about 8,000 characters (only the new or changed passages of an updated file), the names ' +
      'of your existing story-bible sheets, and the file names of uploaded images (never the ' +
      'images themselves), only after you confirm the estimate.',
    minDial: 1
  },
  planLinks: {
    label: 'Plan links',
    sends:
      'The titles and synopses (the first 240 characters) of your planned scenes, the names and ' +
      "hints of your structure template's empty beats, and the titles and stored summaries (the " +
      'first 240 characters) of your written scenes, to find which written scene fulfils which ' +
      'plan, in the background after a scene summary changes or when you ask the outline to find links.',
    minDial: 1
  },
  todo: {
    label: 'To do list: gaps and suggestions',
    sends:
      "Only when you click Check the whole book: each written scene's title and card (when, " +
      'point of view, and what changed, up to 200 characters), your open threads with their ' +
      'questions, the names of your story-bible sheets with which fields are blank (never their ' +
      'values), and the names of the items already listed or settled. When a To do card first ' +
      "shows its suggestions: that item, its sheet's fields (up to 600 characters), what the " +
      "place the line would go holds now (that field, the sheet's page, the scene's notes, or " +
      'its brief, up to 300 characters), and up to 3 passages that name it (up to 400 ' +
      'characters each). The local To do items are found on your machine and send nothing.',
    minDial: 1
  },
  reviewChat: {
    label: 'Upload review chat',
    sends:
      'Only when you send a message on the review of an upload: your message, the last 4 turns ' +
      'of that conversation, and the pending review as a list (each sheet’s name, kind, other ' +
      'names, file names, field values, and the opening of its details, up to 14,000 ' +
      'characters) with the opening of each Project note (up to 3,000 characters).',
    minDial: 1
  },
  organise: {
    label: 'Organise',
    sends:
      'Only when you ask to organise (the Organise button, its offer, or the chat): your ' +
      'instruction, the names, categories, aliases, and usage of your tags, your story-bible ' +
      'sheets with their field values (up to 300 characters each), page text (up to 400), and ' +
      'observed facts, the notes of your documents (up to 800 characters each), and the ' +
      'outline of titles and word counts, in chunks of about 14,000 characters. Never the ' +
      'manuscript text.',
    minDial: 1
  },
  authorMode: {
    label: 'Author mode',
    sends: "The active scene's text, referenced notes, the scene brief, and your instruction.",
    minDial: 1
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

/**
 * How a gate says a feature cannot run with AI off (F-5.21; Use AI since 2026-10-07): every
 * feature runs whenever AI is on, so the one control to name is Use AI. Main appends the
 * current state; the renderer appends where the control lives.
 */
export function needsSwitchText(label: string): string {
  return `${label} needs ${USE_AI_LABEL} turned on`
}
