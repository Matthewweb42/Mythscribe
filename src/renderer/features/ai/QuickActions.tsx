import { useCallback, useId } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { CONTINUITY_TEXT_MIN } from '@shared/continuity'
import { PROOFREAD_TEXT_MIN } from '@shared/proofread'
import {
  QUICK_ACTION_IDS,
  QUICK_ACTIONS,
  quickActionReason,
  type QuickActionId
} from '@shared/quickActions'
import { WHAT_NEXT_TEXT_MIN } from '@shared/whatNext'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { useProofreadStore } from '@renderer/features/editor/proofreadStore'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useAiSettingsStore } from './aiSettingsStore'
import { useAssistantStore } from './assistantStore'
import { useContinuityStore } from './continuityStore'

/** Why a turn-writing quick action waits (F-5.17's one busy rule). */
export const CONVERSATION_BUSY_MESSAGE = 'Waiting for the current answer'
export const PROOFREAD_BUSY_MESSAGE = 'A proofreading pass is already in progress'
/** The proofread panel is not mounted in focus mode (F-6.1), so a pass would have nowhere to show. */
export const PROOFREAD_FOCUS_MESSAGE = 'Leave focus mode to proofread'
/** The proofread panel belongs to the single-scene view; a stacked region has none. */
export const PROOFREAD_STACK_MESSAGE = 'Open the scene on its own to proofread'
export const CONTINUITY_BUSY_MESSAGE = 'A check is already running'

/** The text each action needs before it can run, in characters. */
const MIN_LENGTH: Record<QuickActionId, number> = {
  whatNext: WHAT_NEXT_TEXT_MIN,
  proofread: PROOFREAD_TEXT_MIN,
  continuity: CONTINUITY_TEXT_MIN,
  recap: 1
}

const BUTTON =
  'flex items-baseline gap-1 rounded-md border border-line px-2 py-0.5 text-xs text-fg hover:bg-surface-raised disabled:opacity-40 disabled:hover:bg-transparent'

/**
 * The open scene the quick actions act on: the live editor the author last worked in, whether
 * it holds a manuscript scene (not front or end matter), and its text length, which follows
 * every keystroke.
 */
function useOpenScene(): {
  editor: Editor | null
  nodeId: string | null
  scene: boolean
  length: number
} {
  const active = useActiveEditorStore((s) => s.active)
  const editor = active !== null && !active.editor.isDestroyed ? active.editor : null
  const selector = useCallback(() => (editor ? editor.state.doc.textContent.length : 0), [editor])
  const length = useEditorState({ editor, selector }) ?? 0
  const nodeId = active?.id ?? null
  const isScene = useTreeStore(
    (s) =>
      nodeId !== null && s.byId[nodeId]?.kind === 'document' && s.sectionOf[nodeId] === 'manuscript'
  )
  return { editor, nodeId, scene: editor !== null && isScene, length }
}

/**
 * The quick actions of the assistant (F-5.17): one click each on the open scene or the
 * selection, every button naming its tier. What should come next? and What happened here?
 * write into the active conversation (and bring the chat back from the Continuity view);
 * Proofread opens its panel over the editor; Check consistency runs the check and shows the
 * Continuity view. A button that cannot run is disabled and its title says why
 * (`quickActionReason`: the dial, the toggle, the scene, the length, then what keeps it busy);
 * when none can run, the first reason shows as a line under the row. Mouse-down is swallowed so
 * the editor's selection survives the click.
 */
export function QuickActions(): React.JSX.Element {
  const { editor, nodeId, scene, length } = useOpenScene()
  const settings = useAiSettingsStore((s) => s.settings)
  const focus = useFocusStore((s) => s.active)
  const standalone = useTreeStore((s) => nodeId !== null && s.selectedId === nodeId)
  const proofreading = useProofreadStore((s) => s.session !== null)
  const checking = useContinuityStore((s) => s.running !== null)
  const conversationBusy = useAssistantStore((s) => {
    const active = s.conversations?.active ?? null
    return active === null || s.pending[active] !== undefined
  })
  const reasonId = useId()

  const busyOf = (id: QuickActionId): string | null => {
    switch (id) {
      case 'proofread':
        if (proofreading) return PROOFREAD_BUSY_MESSAGE
        if (focus) return PROOFREAD_FOCUS_MESSAGE
        return standalone ? null : PROOFREAD_STACK_MESSAGE
      case 'continuity':
        return checking ? CONTINUITY_BUSY_MESSAGE : null
      default:
        return conversationBusy ? CONVERSATION_BUSY_MESSAGE : null
    }
  }
  const reasons = QUICK_ACTION_IDS.map((id) =>
    quickActionReason(id, { settings, scene, length, minLength: MIN_LENGTH[id], busy: busyOf(id) })
  )
  const allOff = reasons.every((reason) => reason !== null)

  const run = (id: QuickActionId): void => {
    if (editor === null || nodeId === null) return
    const continuity = useContinuityStore.getState()
    switch (id) {
      case 'whatNext':
        continuity.setViewOpen(false)
        void useAssistantStore.getState().whatNext()
        return
      case 'recap':
        continuity.setViewOpen(false)
        void useAssistantStore.getState().recap()
        return
      case 'proofread':
        useProofreadStore.getState().start(nodeId, editor)
        return
      case 'continuity':
        continuity.check(nodeId)
        continuity.setViewOpen(true)
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-line px-3 py-2">
      <div
        role="group"
        aria-label="Quick actions"
        aria-describedby={allOff ? reasonId : undefined}
        className="flex flex-wrap gap-1"
      >
        {QUICK_ACTION_IDS.map((id, index) => {
          const { label, tier, description } = QUICK_ACTIONS[id]
          const reason = reasons[index] ?? null
          return (
            <button
              key={id}
              type="button"
              data-testid={`quick-action-${id}`}
              aria-label={label}
              disabled={reason !== null}
              title={reason ?? `${description}. Uses the ${tier} tier.`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(id)}
              className={BUTTON}
            >
              {label}
              <span className="text-[0.625rem] text-fg-subtle">{tier}</span>
            </button>
          )
        })}
      </div>
      {allOff ? (
        <p id={reasonId} data-testid="quick-action-reason" className="m-0 text-xs text-fg-muted">
          {reasons[0]}
        </p>
      ) : null}
    </div>
  )
}
