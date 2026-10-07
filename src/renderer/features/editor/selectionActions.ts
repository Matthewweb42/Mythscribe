import type { Editor } from '@tiptap/core'
import { isFeatureAllowed, type AiSettings } from '@shared/aiSettings'
import { openAssistant } from '@renderer/features/ai/aiActions'
import { useAssistantStore } from '@renderer/features/ai/assistantStore'
import { useRewriteStore } from './rewriteStore'
import { selectedText } from './selectedText'

/**
 * What a selection offers (2026-10-06): Rewrite (F-14.10) and Ask AI, from the selection bubble
 * and the editor's right-click menu alike. Each is offered only while the dial and its toggle
 * allow it; a forbidden one is not shown at all, never as a dead button.
 */
export interface SelectionOffer {
  rewrite: boolean
  ask: boolean
}

export function selectionOffer(settings: AiSettings | null): SelectionOffer {
  return {
    rewrite: settings !== null && isFeatureAllowed(settings, 'rewrite'),
    ask: settings !== null && isFeatureAllowed(settings, 'chat')
  }
}

/** Rewrites the editor's selection and opens the assistant panel, where the rewrite shows. */
export function rewriteSelection(nodeId: string, editor: Editor): void {
  useRewriteStore.getState().start(nodeId, editor)
  openAssistant()
}

/** Attaches the editor's selection to the assistant's composer as a quote and opens the panel. */
export function askAboutSelection(editor: Editor): void {
  useAssistantStore.getState().attach(selectedText(editor))
  openAssistant()
}
