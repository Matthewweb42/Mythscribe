import type { Editor } from '@tiptap/core'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { BetaReaderPanel } from '@renderer/features/editor/BetaReaderPanel'
import { useBetaReaderStore } from '@renderer/features/editor/betaReaderStore'
import { BriefDraftPanel } from '@renderer/features/editor/BriefDraftPanel'
import { useBriefDraftStore } from '@renderer/features/editor/briefDraftStore'
import { CritiquePanel } from '@renderer/features/editor/CritiquePanel'
import { useCritiqueStore } from '@renderer/features/editor/critiqueStore'
import { ProofreadPanel } from '@renderer/features/editor/ProofreadPanel'
import { useProofreadStore } from '@renderer/features/editor/proofreadStore'
import { RewritePanel } from '@renderer/features/editor/RewritePanel'
import { useRewriteStore } from '@renderer/features/editor/rewriteStore'

/**
 * The results of the scene features in the assistant panel (2026-10-06; they sat between the
 * toolbar and the text before): the rewrite (F-14.10), the editor's notes (F-14.8), the
 * proofreading fixes (F-14.12), the beta reader's report (F-14.11), and the brief draft
 * (F-14.3), each while its session runs, with every action it had (accept, apply, regenerate,
 * dismiss, the cost line, citations that select the passage). Each panel acts on the live editor
 * of the scene its session belongs to: the active editor when it holds that scene, else none
 * (the panel's editor actions wait until the scene is open again; its editor going away ends the
 * session, `DocumentEditor`'s `dismissFor`). Scrolls on its own above the conversation, so a
 * long report never pushes the composer away. Nothing while no session runs.
 */
export function AiResults(): React.JSX.Element | null {
  const active = useActiveEditorStore((s) => s.active)
  const rewrite = useRewriteStore((s) => s.session?.nodeId ?? null)
  const critique = useCritiqueStore((s) => s.session?.nodeId ?? null)
  const proofread = useProofreadStore((s) => s.session?.nodeId ?? null)
  const betaReader = useBetaReaderStore((s) => s.session?.nodeId ?? null)
  const brief = useBriefDraftStore((s) => s.draft !== null)
  if (rewrite === null && critique === null && proofread === null && betaReader === null && !brief)
    return null
  const editorOf = (nodeId: string): Editor | null =>
    active !== null && active.id === nodeId && !active.editor.isDestroyed ? active.editor : null
  return (
    <div
      data-testid="ai-results"
      className="flex max-h-[55%] shrink-0 flex-col overflow-y-auto border-b border-line"
    >
      {rewrite === null ? null : <RewritePanel id={rewrite} editor={editorOf(rewrite)} />}
      {critique === null ? null : <CritiquePanel id={critique} editor={editorOf(critique)} />}
      {proofread === null ? null : <ProofreadPanel id={proofread} editor={editorOf(proofread)} />}
      {betaReader === null ? null : (
        <BetaReaderPanel id={betaReader} editor={editorOf(betaReader)} />
      )}
      <BriefDraftPanel />
    </div>
  )
}
