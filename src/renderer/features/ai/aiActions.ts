import { useCallback } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import type { AiFeatureId, Tier } from '@shared/ai'
import {
  AI_DATA_SHARING,
  AI_DIAL_LABEL,
  isFeatureAllowed,
  type AiSettings
} from '@shared/aiSettings'
import { BETA_READER_TEXT_MIN } from '@shared/betaReader'
import { CONTINUITY_TEXT_MIN } from '@shared/continuity'
import { CRITIQUE_TEXT_MIN } from '@shared/critique'
import { PROOFREAD_TEXT_MIN } from '@shared/proofread'
import { featureActionReason } from '@shared/quickActions'
import { REWRITE_TEXT_MAX, REWRITE_TEXT_MIN } from '@shared/rewrite'
import { BRIEF_TEXT_MIN } from '@shared/sceneMeta'
import { SCENE_SUGGEST_TEXT_MIN } from '@shared/sceneSuggest'
import { SUMMARY_TEXT_MIN } from '@shared/summary'
import { WHAT_NEXT_TEXT_MIN } from '@shared/whatNext'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { useBetaReaderStore } from '@renderer/features/editor/betaReaderStore'
import { useBriefDraftStore } from '@renderer/features/editor/briefDraftStore'
import { useCritiqueStore } from '@renderer/features/editor/critiqueStore'
import { useProofreadStore } from '@renderer/features/editor/proofreadStore'
import { useRewriteStore } from '@renderer/features/editor/rewriteStore'
import { useSceneSuggestStore } from '@renderer/features/editor/sceneSuggestStore'
import { useSummaryStore } from '@renderer/features/editor/summaryStore'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useContinuityStore } from './continuityStore'

/**
 * The assistant's AI actions (2026-10-06, "all AI in the AI panel"): the table of the scene
 * features, the rule for when each is off, and how each starts. The toolbar buttons, the
 * quick-action row (F-5.17), and the panel's Actions menu are gone (the last in the 2026-10-06
 * polish); these features start from a chat turn the router (F-5.19) sent to them, the
 * selection bubble, or their own buttons in the notes column (summary, brief draft). Results show in the assistant panel (`AiResults`), the
 * Continuity view, or the notes column (synopsis, notes, summary).
 */

export const AI_ACTION_IDS = [
  'whatNext',
  'recap',
  'critique',
  'betaReader',
  'proofread',
  'continuity',
  'synopsis',
  'notes',
  'brief',
  'summary'
] as const
export type AiActionId = (typeof AI_ACTION_IDS)[number]

/** The actions that start a scene feature; the other two write a turn into the conversation. */
export type SceneActionId = Exclude<AiActionId, 'whatNext' | 'recap'>

export interface AiActionInfo {
  label: string
  /** The feature whose dial level and toggle gate the action. */
  feature: AiFeatureId
  /** The tier the request runs on, named in the item's tooltip. */
  tier: Tier
  /** What the action does, for its tooltip when it can run. */
  description: string
  /** The scene text the action needs, in characters. */
  minLength: number
}

export const AI_ACTIONS: Record<AiActionId, AiActionInfo> = {
  whatNext: {
    label: 'What should come next?',
    feature: 'whatNext',
    tier: 'fast',
    description: 'Three short directions for the scene, in the chat',
    minLength: WHAT_NEXT_TEXT_MIN
  },
  recap: {
    label: 'What happened here?',
    feature: 'query',
    tier: 'strong',
    description: 'A cited recap of the scene or the selection, in the chat',
    minLength: 1
  },
  critique: {
    label: "Editor's notes",
    feature: 'critique',
    tier: 'strong',
    description: "An editor's notes on the scene, each citing its passage",
    minLength: CRITIQUE_TEXT_MIN
  },
  betaReader: {
    label: 'Beta reader',
    feature: 'betaReader',
    tier: 'strong',
    description: 'What a first-time reader knows, expects, and loses track of by this scene',
    minLength: BETA_READER_TEXT_MIN
  },
  proofread: {
    label: 'Proofread',
    feature: 'proofread',
    tier: 'fast',
    description: 'Spelling, typos, grammar, and punctuation fixes to accept one by one',
    minLength: PROOFREAD_TEXT_MIN
  },
  continuity: {
    label: 'Check consistency',
    feature: 'continuity',
    tier: 'strong',
    description: 'Compare the scene with the story bible',
    minLength: CONTINUITY_TEXT_MIN
  },
  synopsis: {
    label: 'Suggest synopsis',
    feature: 'synopsis',
    tier: 'fast',
    description: 'A synopsis for the Synopsis box, to accept or dismiss',
    minLength: SCENE_SUGGEST_TEXT_MIN
  },
  notes: {
    label: 'Suggest notes',
    feature: 'notesSuggest',
    tier: 'fast',
    description: 'Key points to keep in mind, to add to the notes',
    minLength: SCENE_SUGGEST_TEXT_MIN
  },
  brief: {
    label: 'Draft scene brief',
    feature: 'brief',
    tier: 'fast',
    description: "The scene's goal, conflict, turn, beat, and what the reader knows after",
    minLength: BRIEF_TEXT_MIN
  },
  summary: {
    label: 'Summarize scene',
    feature: 'summary',
    tier: 'fast',
    description: 'Refresh the scene summary now instead of after the pause',
    minLength: SUMMARY_TEXT_MIN
  }
}

/** Why a turn-writing action waits (F-5.17's one busy rule). */
export const CONVERSATION_BUSY_MESSAGE = 'Waiting for the current answer'
export const PROOFREAD_BUSY_MESSAGE = 'A proofreading pass is already in progress'
export const CONTINUITY_BUSY_MESSAGE = 'A check is already running'
export const CRITIQUE_BUSY_MESSAGE = "Editor's notes are already open (close them first)"
export const BETA_READER_BUSY_MESSAGE = 'A beta read is already open (close it first)'
export const SUGGEST_BUSY_MESSAGE = 'A suggestion is already on the way'
export const BRIEF_BUSY_MESSAGE = 'A brief draft is already on the way'
export const SUMMARY_BUSY_MESSAGE = 'A summary is already on the way'

/** The open scene the actions act on. */
export interface OpenScene {
  editor: Editor | null
  nodeId: string | null
  /** An editor holds a manuscript document (not front or end matter). */
  scene: boolean
  /** Its text length, in characters. */
  length: number
}

/**
 * The live editor the author last worked in, whether it holds a manuscript scene, and its text
 * length, which follows every keystroke.
 */
export function useOpenScene(): OpenScene {
  const active = useActiveEditorStore((s) => s.active)
  const editor = active !== null && !active.editor.isDestroyed ? active.editor : null
  const selector = useCallback(() => (editor ? editor.state.doc.textContent.length : 0), [editor])
  const length = useEditorState({ editor, selector }) ?? 0
  const nodeId = active?.id ?? null
  const isScene = useTreeStore((s) => nodeId !== null && isManuscriptDocument(s, nodeId))
  return { editor, nodeId, scene: editor !== null && isScene, length }
}

/** The open scene read once, outside React (the router's dispatch). */
export function openSceneNow(): OpenScene {
  const active = useActiveEditorStore.getState().active
  const editor = active !== null && !active.editor.isDestroyed ? active.editor : null
  const nodeId = active?.id ?? null
  return {
    editor,
    nodeId,
    scene:
      editor !== null && nodeId !== null && isManuscriptDocument(useTreeStore.getState(), nodeId),
    length: editor ? editor.state.doc.textContent.length : 0
  }
}

function isManuscriptDocument(
  tree: { byId: Record<string, { kind: string } | undefined>; sectionOf: Record<string, string> },
  nodeId: string
): boolean {
  return tree.byId[nodeId]?.kind === 'document' && tree.sectionOf[nodeId] === 'manuscript'
}

/** What keeps a scene action from starting now (a run already on screen or on its way), or null. */
function sceneActionBusy(id: SceneActionId, nodeId: string | null): string | null {
  switch (id) {
    case 'critique':
      return useCritiqueStore.getState().session !== null ? CRITIQUE_BUSY_MESSAGE : null
    case 'betaReader':
      return useBetaReaderStore.getState().session !== null ? BETA_READER_BUSY_MESSAGE : null
    case 'proofread':
      return useProofreadStore.getState().session !== null ? PROOFREAD_BUSY_MESSAGE : null
    case 'continuity':
      return useContinuityStore.getState().running !== null ? CONTINUITY_BUSY_MESSAGE : null
    case 'synopsis':
    case 'notes': {
      if (nodeId === null) return null
      const pending = useSceneSuggestStore.getState()[id][nodeId]?.status === 'pending'
      return pending ? SUGGEST_BUSY_MESSAGE : null
    }
    case 'brief':
      return useBriefDraftStore.getState().draft?.status === 'pending' ? BRIEF_BUSY_MESSAGE : null
    case 'summary': {
      if (nodeId === null) return null
      const pending = useSummaryStore.getState().byNode[nodeId]?.status === 'pending'
      return pending ? SUMMARY_BUSY_MESSAGE : null
    }
  }
}

/**
 * Why action `id` cannot run on `open`, or null when it can: the dial, then the toggle, then the
 * scene, then the length, then what keeps it busy (`featureActionReason`). `conversationBusy`
 * is the busy rule of the two turn-writing actions.
 */
export function aiActionReason(
  id: AiActionId,
  settings: AiSettings | null,
  open: OpenScene,
  conversationBusy: boolean
): string | null {
  const { feature, minLength } = AI_ACTIONS[id]
  const busy =
    id === 'whatNext' || id === 'recap'
      ? conversationBusy
        ? CONVERSATION_BUSY_MESSAGE
        : null
      : sceneActionBusy(id, open.nodeId)
  return featureActionReason(feature, {
    settings,
    scene: open.scene,
    length: open.length,
    minLength,
    busy
  })
}

/** Opens the assistant: the docked panel, or the floating one in focus mode (F-6.6). */
export function openAssistant(): void {
  const focus = useFocusStore.getState()
  if (focus.active) {
    if (!focus.panels.assistant) focus.togglePanel('assistant')
    return
  }
  const layout = useLayoutStore.getState()
  if (!layout.layout.assistant.open) layout.toggle('assistant')
}

/** Opens the notes column (or the floating notes in focus mode), where the suggestions land. */
export function openNotes(): void {
  const focus = useFocusStore.getState()
  if (focus.active) {
    if (!focus.panels.notes) focus.togglePanel('notes')
    return
  }
  const layout = useLayoutStore.getState()
  if (!layout.layout.notes.open) layout.toggle('notes')
}

/** Where each scene action's result shows, for the chat's notice when the router started it. */
const WHERE_IT_SHOWS: Record<SceneActionId, string> = {
  critique: "Editor's notes are above the chat.",
  betaReader: "The beta reader's report is above the chat.",
  proofread: 'The proofreading fixes are above the chat.',
  continuity: 'The findings are in the Continuity view.',
  synopsis: 'The suggested synopsis is in the Notes column, under the Synopsis box.',
  notes: 'The suggested notes are in the Notes column, ready to add.',
  brief: 'The brief draft is above the chat.',
  summary: "The summary is in the Notes column's Scene details."
}

/**
 * Starts scene action `id` on node `nodeId` (its live `editor` for proofread) and shows where the
 * result lands: the critique, beta reader, proofread, and brief results in the assistant panel,
 * the continuity findings in its Continuity view, the suggestions and the summary in the notes
 * column. `instruction` is the router's restated request, used as the focus of a notes
 * suggestion. Returns the notice saying where the result shows. The caller checks
 * `aiActionReason` first.
 */
export function startSceneAction(
  id: SceneActionId,
  nodeId: string,
  editor: Editor,
  instruction: string | null = null
): string {
  const continuity = useContinuityStore.getState()
  switch (id) {
    case 'critique':
      useCritiqueStore.getState().start(nodeId)
      openAssistant()
      break
    case 'betaReader':
      useBetaReaderStore.getState().start(nodeId)
      openAssistant()
      break
    case 'proofread':
      useProofreadStore.getState().start(nodeId, editor)
      openAssistant()
      break
    case 'continuity':
      continuity.check(nodeId)
      continuity.setViewOpen(true)
      openAssistant()
      break
    case 'synopsis':
      useSceneSuggestStore.getState().suggestSynopsis(nodeId)
      openNotes()
      break
    case 'notes':
      useSceneSuggestStore.getState().suggestNotes(nodeId, instruction)
      openNotes()
      break
    case 'brief':
      useBriefDraftStore.getState().start(nodeId)
      openAssistant()
      break
    case 'summary':
      void useSummaryStore.getState().summarize(nodeId)
      openNotes()
      break
  }
  return WHERE_IT_SHOWS[id]
}

const REWRITE_MAX_LABEL = REWRITE_TEXT_MAX.toLocaleString()

/**
 * Why the selection cannot be rewritten (F-14.10), or null when it can: the dial and toggle
 * first, then a rewrite already in progress, then the selection's length (`length` is the
 * captured passage's, `captureRewriteText`). Shared by the selection bubble, the right-click
 * menu, and a chat turn the router sent to rewrite.
 */
export function rewriteReason(settings: AiSettings | null, length: number): string | null {
  const { minDial } = AI_DATA_SHARING.rewrite
  if (settings === null || settings.dial < minDial) {
    return `Rewrite in my voice needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (Settings, AI tab)`
  }
  if (!isFeatureAllowed(settings, 'rewrite')) {
    return 'Rewrite in my voice is turned off for this project (Settings, AI tab)'
  }
  if (useRewriteStore.getState().session !== null) return 'A rewrite is already in progress'
  if (length > REWRITE_TEXT_MAX) return `The selection is over ${REWRITE_MAX_LABEL} characters`
  if (length < REWRITE_TEXT_MIN) {
    return `Select ${REWRITE_TEXT_MIN}–${REWRITE_MAX_LABEL} characters to rewrite them in your voice`
  }
  return null
}
