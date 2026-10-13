import type { SearchResult } from '@shared/search'
import { locateText } from '@renderer/features/editor/locateText'
import { openNotesOf } from '@renderer/features/editor/openNotes'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { openResearchPage } from '@renderer/features/research/openResearch'

/**
 * Opens what a search result points at (F-10.1), through the owners that already open each thing:
 * a document through `openPassage`, selecting the first occurrence of the query (a title-only hit
 * has no passage, so the document is only selected); notes by selecting the node and showing the
 * notes panel (the floating one in focus mode, the docked one otherwise); an entity through the
 * entity store, leaving focus mode first like every other opener of the story bible, because the
 * entity page has no focus view. A Research document (F-16.8) opens its page with the Research tab
 * (`openResearchPage`); a record (F-16.6) opens its sheet the way an entity does.
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
    case 'notes':
      openNotesOf(result.id)
      return
    case 'research':
      // F-16.8: a Research page opens in the page editor, which takes no passage jump yet.
      openResearchPage(result.id)
      return
    case 'character':
    case 'setting':
    case 'world': {
      const focus = useFocusStore.getState()
      if (focus.active) await focus.exit()
      useEntityStore.getState().select(result.id)
      return
    }
    case 'record': {
      // F-16.6: a record's sheet, like an entity page, has no focus view.
      const focus = useFocusStore.getState()
      if (focus.active) await focus.exit()
      useRecordStore.getState().select(result.id)
      return
    }
  }
}
