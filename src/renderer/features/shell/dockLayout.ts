import { useMemo } from 'react'
import type { Layout } from '@shared/layout'
import { useIsArchived } from './archived'
import { useLayoutStore } from './layoutStore'

/**
 * The old story bible's panels (notes redesign, fresh start): the tags column and the quick
 * reference, closed on screen while it is archived. The stored layout keeps them as they were, so
 * switching it back on (Settings › Archived features) shows them where the author left them.
 */
export function withStoryBiblePanelsClosed(layout: Layout): Layout {
  return {
    ...layout,
    tags: { ...layout.tags, open: false },
    references: { ...layout.references, open: false }
  }
}

/** The layout as the dock shows it: the stored one, less the archived story bible's panels. */
export function useDockLayout(): Layout {
  const layout = useLayoutStore((s) => s.layout)
  const archived = useIsArchived('storyBible')
  return useMemo(() => (archived ? withStoryBiblePanelsClosed(layout) : layout), [layout, archived])
}
