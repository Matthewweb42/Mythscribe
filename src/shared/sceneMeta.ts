import { z } from 'zod'

/** Caps for the three free-text fields; generous, but bounded like every stored string. */
export const SCENE_META_FIELD_MAX = 200
export const SCENE_META_TIMELINE_MAX = 500
/** One line per brief field (F-14.3): a sentence, not a paragraph. */
export const SCENE_BRIEF_FIELD_MAX = 200

/** How much of a scene the AI reads when drafting its brief (F-14.3): head-truncated, like critique. */
export const BRIEF_SCENE_CHAR_BUDGET = 20_000
/** Below this much text there is nothing to draft a brief from (the same floor as critique). */
export const BRIEF_TEXT_MIN = 200
/** The longest synopsis an index card holds (F-11.1): a paragraph, not a scene. */
export const SCENE_SYNOPSIS_MAX = 1000

/**
 * The writing status of a scene, chapter, or part (F-11.1), shown as the colour of its index
 * card and outline row. `none` is the unset state and draws no colour.
 */
export const SCENE_STATUSES = ['none', 'idea', 'draft', 'revised', 'final'] as const
export const SceneStatus = z.enum(SCENE_STATUSES)
export type SceneStatus = z.infer<typeof SceneStatus>

export const SCENE_STATUS_LABELS: Record<SceneStatus, string> = {
  none: 'No status',
  idea: 'Idea',
  draft: 'Draft',
  revised: 'Revised',
  final: 'Final'
}

/**
 * The scene brief (F-14.3, PLAN.md §2.2): the author's stated intent for a scene, one line
 * each, all optional. The AI may draft it from the text; the author corrects it. It is the
 * "brief" every generation and critique prompt carries.
 */
export const SceneBrief = z.object({
  /** What the point-of-view character wants in this scene. */
  goal: z.string().max(SCENE_BRIEF_FIELD_MAX),
  /** What stands in the way. */
  conflict: z.string().max(SCENE_BRIEF_FIELD_MAX),
  /** The turn or outcome: how the scene ends differently from how it began. */
  turn: z.string().max(SCENE_BRIEF_FIELD_MAX),
  /** The emotional beat. */
  beat: z.string().max(SCENE_BRIEF_FIELD_MAX),
  /** What the reader knows after the scene that they did not before. */
  after: z.string().max(SCENE_BRIEF_FIELD_MAX)
})
export type SceneBrief = z.infer<typeof SceneBrief>
export type SceneBriefField = keyof SceneBrief

export const EMPTY_SCENE_BRIEF: SceneBrief = {
  goal: '',
  conflict: '',
  turn: '',
  beat: '',
  after: ''
}

/** The brief's fields in display and prompt order, with the label the pane and the prompt block use. */
export const SCENE_BRIEF_FIELDS: readonly { key: SceneBriefField; label: string; hint: string }[] =
  [
    { key: 'goal', label: 'Goal', hint: 'What the POV character wants here' },
    { key: 'conflict', label: 'Conflict', hint: 'What stands in the way' },
    { key: 'turn', label: 'Turn', hint: 'How the scene ends differently from how it began' },
    { key: 'beat', label: 'Emotional beat', hint: 'The feeling the scene lands on' },
    { key: 'after', label: 'Reader knows after', hint: 'What the reader learns by the end' }
  ]

/** True when no field of the brief has text. */
export function isBriefEmpty(brief: SceneBrief): boolean {
  return SCENE_BRIEF_FIELDS.every(({ key }) => brief[key].trim() === '')
}

/**
 * The metadata of a scene, chapter, or part (F-4.5): Location and POV are free text with
 * autocomplete from the setting and character tags (plain strings, so a location that is not a
 * tag yet still works), the timeline position is free text until F-11.2 replaces it, and the
 * brief (F-14.3), and the index-card synopsis and status (F-11.1). Stored as JSON in
 * `node.scene_meta`. `brief`, `synopsis`, and `status` are defaulted so a row stored before
 * their feature still parses instead of reading as empty metadata.
 */
export const SceneMeta = z.object({
  location: z.string().max(SCENE_META_FIELD_MAX),
  pov: z.string().max(SCENE_META_FIELD_MAX),
  timeline: z.string().max(SCENE_META_TIMELINE_MAX),
  brief: SceneBrief.default(() => ({ ...EMPTY_SCENE_BRIEF })),
  synopsis: z.string().max(SCENE_SYNOPSIS_MAX).default(''),
  status: SceneStatus.default('none')
})
export type SceneMeta = z.infer<typeof SceneMeta>

export const EMPTY_SCENE_META: SceneMeta = {
  location: '',
  pov: '',
  timeline: '',
  brief: EMPTY_SCENE_BRIEF,
  synopsis: '',
  status: 'none'
}

/** A fresh empty metadata record, no object shared with `EMPTY_SCENE_META`. */
export function emptySceneMeta(): SceneMeta {
  return {
    location: '',
    pov: '',
    timeline: '',
    brief: { ...EMPTY_SCENE_BRIEF },
    synopsis: '',
    status: 'none'
  }
}

/**
 * The stored `scene_meta` column as a `SceneMeta`. Lenient on purpose: a null row, invalid JSON,
 * or JSON that fails the schema all read as empty metadata rather than an error, because a
 * half-legible sidecar must never keep the author out of the editor.
 */
export function parseStoredSceneMeta(raw: string | null): SceneMeta {
  if (raw === null) return emptySceneMeta()
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return emptySceneMeta()
  }
  const parsed = SceneMeta.safeParse(json)
  return parsed.success ? parsed.data : emptySceneMeta()
}

export interface SceneBriefBlockInput {
  /** The scene's own brief. */
  current: SceneBrief
  /** The previous manuscript document's brief, or null at the start (or outside the manuscript). */
  previous: SceneBrief | null
  /** The next manuscript document's brief, or null at the end. */
  next: SceneBrief | null
}

/**
 * The prompt block for a scene's brief and its neighbours (F-14.3), shared by every prompt that
 * carries one so they all read the same. The current scene contributes every non-empty line;
 * the previous scene only what the reader knows after it (its `after`, else its `turn`) and the
 * next scene only its `goal`: that is what continuing prose and an intent check need, at a
 * fraction of three full briefs. Null when there is nothing to say at all.
 */
export function renderSceneBriefBlock(input: SceneBriefBlockInput): string | null {
  const lines: string[] = []
  const own = SCENE_BRIEF_FIELDS.flatMap(({ key, label }) => {
    const value = input.current[key].trim()
    return value ? [`- ${label}: ${value}`] : []
  })
  if (own.length) lines.push('Scene brief:', ...own)
  const before = input.previous ? input.previous.after.trim() || input.previous.turn.trim() : ''
  if (before) lines.push(`Previous scene, reader knows after: ${before}`)
  const ahead = input.next ? input.next.goal.trim() : ''
  if (ahead) lines.push(`Next scene's goal: ${ahead}`)
  return lines.length ? lines.join('\n') : null
}

/**
 * The part of `SceneMeta` the AI reads: the three metadata fields and the brief. Prompt inputs
 * take this rather than `SceneMeta`, so the outline's synopsis and status (F-11.1) never reach a
 * prompt or a context hash.
 */
export type PromptSceneMeta = Pick<SceneMeta, 'location' | 'pov' | 'timeline' | 'brief'>

/**
 * The metadata a prompt carries, or null when no metadata field is set (the brief alone travels
 * in its own block). A fresh object with only the `PromptSceneMeta` keys, in the stored order,
 * so the synopsis and status never reach a prompt or a context hash and older hashes still match.
 */
export function promptSceneMeta(meta: SceneMeta): PromptSceneMeta | null {
  const { location, pov, timeline, brief } = meta
  return location || pov || timeline ? { location, pov, timeline, brief } : null
}
