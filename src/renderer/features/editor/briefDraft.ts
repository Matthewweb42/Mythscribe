import { useMemo, useState } from 'react'
import type { AiUsage } from '@shared/ai'
import { AI_DATA_SHARING, AI_DIAL_LABEL, isFeatureAllowed } from '@shared/aiSettings'
import { docToText } from '@shared/docText'
import { BRIEF_TEXT_MIN, type SceneBrief } from '@shared/sceneMeta'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'
import { useSceneMetaStore } from './sceneMetaStore'

let requestCounter = 0
/** A request id `ai:cancel` can find (F-5.10), unique across this renderer's metadata panes. */
const nextRequestId = (): string => `b-${Date.now().toString(36)}-${++requestCounter}`

/**
 * One brief draft (F-14.3), keyed by the node it was asked for so a document switch drops it
 * without an effect (the tag bar's `pickingFor` idiom). A `done` draft is a proposal (F-14.5)
 * the author settles: Use draft fills the five fields and settles it accepted, Discard settles
 * it rejected. The pending state carries the request id its Cancel button stops (F-5.10).
 */
export type BriefDraftState =
  | { nodeId: string; status: 'pending'; requestId: string }
  | {
      nodeId: string
      status: 'done'
      proposalId: string
      brief: SceneBrief
      truncated: boolean
      model: string
      costUsd: number
      /** The tokens the request spent, for the cost line (F-5.9). */
      usage: AiUsage
      cached: boolean
    }
  | { nodeId: string; status: 'error'; message: string; nextStep: string }

/** What `useBriefDraft` hands the pane: the state for this node and the four actions on it. */
export interface BriefDraft {
  /** The draft for this node, or null while idle (a draft for another node reads as none). */
  state: BriefDraftState | null
  /** True for a document: a folder has no text, so it gets no Draft with AI button at all. */
  available: boolean
  /** Why Draft with AI cannot run, for its title; null when it can. */
  blocked: string | null
  pending: boolean
  /** Flushes the document, then asks main for a draft. A no-op while `blocked`. */
  start: () => void
  /** Stops the pending request; the pane goes idle when its cancelled reply lands. */
  cancel: () => void
  /** Fills the five fields through the autosave store and settles the proposal accepted. */
  accept: () => void
  /** Drops the draft and settles the proposal rejected. */
  discard: () => void
}

/**
 * The draft-with-AI flow of the brief (F-14.3) for one node: the gate (dial, per-feature
 * toggle, `BRIEF_TEXT_MIN` characters of live text, nothing already in flight), the request
 * through the activity store so the header indicator and Cancel can find it, and the
 * settlement of the proposal it comes back as. `onLanded` runs when a draft arrives, so the
 * pane can open its disclosure on it.
 */
export function useBriefDraft(id: string, onLanded: () => void): BriefDraft {
  const [draft, setDraft] = useState<BriefDraftState | null>(null)
  const mine = draft?.nodeId === id ? draft : null
  const pending = mine?.status === 'pending'
  const settings = useAiSettingsStore((s) => s.settings)
  const available = useTreeStore((s) => s.byId[id]?.kind === 'document')
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  const flushDocuments = useDocumentStore((s) => s.flush)
  const meta = useSceneMetaStore((s) => s.docs[id]?.content ?? null)
  const edit = useSceneMetaStore((s) => s.edit)
  const track = useAiActivityStore((s) => s.track)
  const cancelRequest = useAiActivityStore((s) => s.cancel)
  const textLength = useMemo(() => (content ? docToText(content).length : 0), [content])

  const { minDial } = AI_DATA_SHARING.brief
  let blocked: string | null = null
  if (settings === null || settings.dial < minDial) {
    blocked = `Drafting a brief needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (Settings, AI tab)`
  } else if (!isFeatureAllowed(settings, 'brief')) {
    blocked = 'Brief drafts are turned off for this project (Settings, AI tab)'
  } else if (pending) {
    blocked = 'A brief draft is already on the way'
  } else if (meta === null) {
    blocked = 'The metadata is still loading'
  } else if (textLength < BRIEF_TEXT_MIN) {
    blocked = `Write ${BRIEF_TEXT_MIN.toLocaleString()} characters before asking for a brief`
  }

  // Main reads the saved row, so unsaved typing is flushed first: the draft is made from what
  // the author sees, and the character gate here and in main agree.
  const start = (): void => {
    if (blocked !== null) return
    const nodeId = id
    const requestId = nextRequestId()
    /** Replaces the pending state this request owns; a reply for another request changes nothing. */
    const settle = (next: BriefDraftState | null): void => {
      setDraft((current) =>
        current?.status === 'pending' && current.requestId === requestId ? next : current
      )
    }
    setDraft({ nodeId, status: 'pending', requestId })
    flushDocuments()
      .then(() => track('brief', requestId, ipc().invoke('ai:draftBrief', { nodeId, requestId })))
      .then((result) => {
        if (result.ok) {
          settle({
            nodeId,
            status: 'done',
            proposalId: result.proposalId,
            brief: result.brief,
            truncated: result.truncated,
            model: result.model,
            costUsd: result.costUsd,
            usage: result.usage,
            cached: result.cached
          })
          onLanded()
        } else if (result.code === 'CANCELLED') {
          settle(null)
        } else {
          settle({ nodeId, status: 'error', message: result.message, nextStep: result.nextStep })
        }
      })
      .catch((err: unknown) => {
        settle(null)
        toast.error(describeError(err))
      })
  }

  const cancel = (): void => {
    if (mine?.status !== 'pending') return
    void cancelRequest(mine.requestId)
  }

  const accept = (): void => {
    if (mine?.status !== 'done' || meta === null) return
    edit(id, { ...meta, brief: mine.brief })
    void proposalStore.settle(mine.proposalId, 'accepted')
    setDraft(null)
  }

  const discard = (): void => {
    if (mine?.status !== 'done') return
    void proposalStore.settle(mine.proposalId, 'rejected')
    setDraft(null)
  }

  return { state: mine, available, blocked, pending, start, cancel, accept, discard }
}
