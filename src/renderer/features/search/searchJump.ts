import type { SearchResult } from '@shared/search'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'

/**
 * Opens what a search result points at (F-10.1), through the owners that already open each thing:
 * a document through `openPassage`, selecting the first occurrence of the query (a title-only hit
 * has no passage, so the document is only selected); notes by selecting the node and showing the
 * notes panel (the floating one in focus mode, the docked one otherwise); an entity through the
 * entity store, leaving focus mode first like every other opener of the story bible, because the
 * entity page has no focus view.
 */
export async function jumpToResult(result: SearchResult, query: string): Promise<void> {
  switch (result.type) {
    case 'document':
      if (result.snippet.highlights.length === 0) {
        useTreeStore.getState().select(result.id)
        return
      }
      await openPassage(result.id, (doc) => locateText(doc, query, { ignoreCase: true }))
      return
    case 'notes': {
      useTreeStore.getState().select(result.id)
      const focus = useFocusStore.getState()
      if (focus.active) {
        if (!focus.panels.notes) focus.togglePanel('notes')
        return
      }
      const layout = useLayoutStore.getState()
      if (!layout.layout.notes.open) layout.toggle('notes')
      return
    }
    case 'character':
    case 'setting':
    case 'world': {
      const focus = useFocusStore.getState()
      if (focus.active) await focus.exit()
      useEntityStore.getState().select(result.id)
      return
    }
  }
}
