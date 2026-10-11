import { DEFAULT_STORY_MEMORY, type StoryMemoryVersion } from '@shared/storyMemory'
import { useProjectStore } from './projectStore'

/**
 * The open project's story-memory system (F-16.2), for components: `v1` with no project open.
 * The renderer's one reader of `ProjectInfo.storyMemory`; v2 surfaces (F-16.4 onward) branch on it.
 */
export function useStoryMemory(): StoryMemoryVersion {
  return useProjectStore((s) => s.current?.storyMemory ?? DEFAULT_STORY_MEMORY)
}

/** The same value for store code outside React (actions, effects that are not hooks). */
export function currentStoryMemory(): StoryMemoryVersion {
  return useProjectStore.getState().current?.storyMemory ?? DEFAULT_STORY_MEMORY
}
