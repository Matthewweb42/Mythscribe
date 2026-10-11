import { z } from 'zod'

/**
 * The story-memory switch (F-16.2, story memory redesign phase P0, approved by the author
 * 2026-10-11): which memory system a project runs. `v1` is today's (tags, sheets' fields, scene
 * summaries and cards, the knowledge model); `v2` is the redesign of `FEATURES.md` §2.16 (names
 * and records, quote-proved claims, the This scene panel). Everything new is built behind `v2`,
 * and installed builds stay on `v1` until the author starts the switch-over (F-16.31), the only
 * writer outside tests. A project row stored under `STORY_MEMORY_KEY` in `settings`.
 */
export const STORY_MEMORY_KEY = 'storyMemory'

export const STORY_MEMORY_VERSIONS = ['v1', 'v2'] as const
export const StoryMemoryVersion = z.enum(STORY_MEMORY_VERSIONS)
export type StoryMemoryVersion = z.infer<typeof StoryMemoryVersion>

/** The default for every project, new or old, until the switch-over moves it. */
export const DEFAULT_STORY_MEMORY: StoryMemoryVersion = 'v1'

/**
 * The stored row, read leniently: a missing or unreadable field is `v1` and never switched, so a
 * broken row can only ever keep a project on the system it already runs.
 */
export const StoryMemoryState = z.object({
  version: StoryMemoryVersion.catch(DEFAULT_STORY_MEMORY).default(DEFAULT_STORY_MEMORY),
  /** ISO timestamp of the switch to `version`; null while the project has never switched. */
  switchedAt: z.string().nullable().catch(null).default(null)
})
export type StoryMemoryState = z.infer<typeof StoryMemoryState>

export function defaultStoryMemoryState(): StoryMemoryState {
  return { version: DEFAULT_STORY_MEMORY, switchedAt: null }
}

/** The environment variable that overrides the version for one open (dev builds and the e2e only). */
export const STORY_MEMORY_ENV = 'MYTHSCRIBE_STORY_MEMORY'

/**
 * The override `MYTHSCRIBE_STORY_MEMORY` asks for: exactly `v1` or `v2`, else none. Main reads it
 * only when the app is not packaged, and never writes it to the project.
 */
export function parseStoryMemoryOverride(raw: string | undefined): StoryMemoryVersion | null {
  const parsed = StoryMemoryVersion.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The version a project runs this open: the override when there is one, else the stored one. */
export function effectiveStoryMemory(
  stored: Pick<StoryMemoryState, 'version'>,
  override: StoryMemoryVersion | null
): StoryMemoryVersion {
  return override ?? stored.version
}
