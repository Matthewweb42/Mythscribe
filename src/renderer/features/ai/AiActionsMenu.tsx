import { useCallback, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { ContextMenu } from '@renderer/features/manuscript/ContextMenu'
import type { MenuItem } from '@renderer/features/manuscript/contextMenuItems'
import {
  AI_ACTION_IDS,
  AI_ACTIONS,
  startSceneAction,
  useAiActionReasons,
  useOpenScene,
  type AiActionId
} from './aiActions'
import { useAssistantStore } from './assistantStore'
import { useContinuityStore } from './continuityStore'

const BUTTON =
  'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:bg-surface-raised aria-expanded:text-fg'

/**
 * The assistant's actions menu (2026-10-06, replacing the quick-action row of F-5.17 and the
 * toolbar's AI buttons): one item per one-click action on the open scene or the selection. An
 * item that cannot run is disabled and its tooltip says why (`aiActionReason`: the dial, the
 * toggle, the scene, the length, then what keeps it busy); one that can names what it does and
 * its tier. What should come next? and What happened here? write into the active conversation
 * (and bring the chat back from the Continuity view); the others start their feature, whose
 * result shows above the chat, in the Continuity view, or in the notes column. Mouse-down on the
 * button is swallowed so the editor's selection survives the click.
 */
export function AiActionsMenu(): React.JSX.Element {
  const open = useOpenScene()
  const conversationBusy = useAssistantStore((s) => {
    const active = s.conversations?.active ?? null
    return active === null || s.pending[active] !== undefined
  })
  const reasons = useAiActionReasons(open, conversationBusy)
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const close = useCallback(() => setAt(null), [])

  const items: MenuItem[] = AI_ACTION_IDS.map((id) => {
    const { label, tier, description } = AI_ACTIONS[id]
    const reason = reasons[id]
    return {
      id,
      label,
      disabled: reason !== null,
      title: reason ?? `${description}. Uses the ${tier} tier.`
    }
  })

  const run = (id: AiActionId): void => {
    setAt(null)
    const { editor, nodeId } = open
    if (editor === null || nodeId === null || reasons[id] !== null) return
    const continuity = useContinuityStore.getState()
    if (id === 'whatNext') {
      continuity.setViewOpen(false)
      void useAssistantStore.getState().whatNext()
    } else if (id === 'recap') {
      continuity.setViewOpen(false)
      void useAssistantStore.getState().recap()
    } else {
      startSceneAction(id, nodeId, editor)
    }
  }

  const toggle = (): void => {
    if (at !== null) {
      setAt(null)
      return
    }
    const rect = button.current?.getBoundingClientRect()
    if (rect) setAt({ x: rect.left, y: rect.bottom + 4 })
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label="AI actions"
        title="AI actions on the open scene"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        data-testid="ai-actions"
        onMouseDown={(event) => {
          // Keeps the editor's selection, and keeps the open menu's outside-click from closing
          // it first, so this click closes it instead of reopening it.
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={toggle}
        className={BUTTON}
      >
        <Sparkles size={14} aria-hidden="true" />
        Actions
      </button>
      {at !== null ? (
        <ContextMenu
          x={at.x}
          y={at.y}
          items={items}
          onSelect={(id) => {
            const action = AI_ACTION_IDS.find((candidate) => candidate === id)
            if (action !== undefined) run(action)
          }}
          onClose={close}
        />
      ) : null}
    </>
  )
}
