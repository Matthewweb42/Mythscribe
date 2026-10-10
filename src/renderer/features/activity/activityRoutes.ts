import { openAssistant } from '@renderer/features/ai/aiActions'
import { useContinuityStore } from '@renderer/features/ai/continuityStore'
import { useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { useConversionStore } from '@renderer/features/knowledge/conversionStore'
import { useLibraryStore } from '@renderer/features/library/libraryStore'
import { useOrganiseStore } from '@renderer/features/organise/organiseStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { showSideWork } from '@renderer/features/sideWork/sideWork'
import { useTodoStore } from '@renderer/features/todo/todoStore'
import type { ActivityNote } from './activityJobs'
import { useActivityStore } from './activityStore'

/**
 * Where a notification's Open and Retry go (F-7.12). Open: Organise and the upload's review in
 * the big review dialog (over focus mode too); an edit pass's report; the To do list; the
 * consistency findings view. Retry: the job's own way to run again (Organise with the same
 * request, the upload's sort of the same files, the pass resumed, the check run again, the
 * re-read's failed scenes queued again). Either way the notification goes.
 */
export async function openNote(note: ActivityNote): Promise<void> {
  useActivityStore.getState().dismiss(note.id)
  switch (note.kind) {
    case 'organise':
      showSideWork('organise', 'dialog')
      return
    case 'upload':
      showSideWork('upload', 'dialog')
      return
    case 'editPass':
      if (note.ref !== null) await useEditPassStore.getState().openReport(note.ref)
      return
    case 'todoCheck': {
      // The list lives in the sidebar, which focus mode hides.
      const focus = useFocusStore.getState()
      if (focus.active) await focus.exit()
      const layout = useLayoutStore.getState()
      layout.setSidebarTab('todo')
      if (!layout.layout.sidebar.open) layout.toggle('sidebar')
      return
    }
    case 'continuity':
      useContinuityStore.getState().setViewOpen(true)
      openAssistant()
      return
    case 'conversion':
      return
  }
}

export async function retryNote(note: ActivityNote): Promise<void> {
  useActivityStore.getState().dismiss(note.id)
  switch (note.kind) {
    case 'organise': {
      const { request } = useOrganiseStore.getState()
      if (request !== null) await useOrganiseStore.getState().start(request)
      return
    }
    case 'upload': {
      const { flow } = useLibraryStore.getState()
      if (flow?.stage === 'failed') await useLibraryStore.getState().sort(flow.fileIds)
      return
    }
    case 'editPass':
      if (note.ref !== null) await useEditPassStore.getState().resume(note.ref)
      return
    case 'todoCheck':
      await useTodoStore.getState().runCheck()
      return
    case 'continuity':
      if (note.ref !== null) useContinuityStore.getState().check(note.ref)
      return
    case 'conversion':
      await useConversionStore.getState().retryReread()
      return
  }
}
