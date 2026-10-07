import type { Editor } from '@tiptap/core'
import { ArrowLeft } from 'lucide-react'
import {
  CONTINUITY_SCENE_CHAR_BUDGET,
  type ContinuityFinding,
  type ContinuityRef
} from '@shared/continuity'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { REWRITE_BUSY_MESSAGE } from '@renderer/features/editor/applyFix'
import {
  FIX_BUTTON,
  FIX_PRIMARY_BUTTON,
  FIX_QUOTE_BUTTON,
  FixDiff,
  OffVoiceFlag
} from '@renderer/features/editor/FixDiff'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useRewriteStore } from '@renderer/features/editor/rewriteStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useContinuityFindings, useContinuityStore } from './continuityStore'
import { describeRequest } from './usageFormat'

/** What a card says once its quote is no longer in the scene. */
export const CONTINUITY_GONE_MESSAGE = 'That passage has changed; check the scene again'
/** What a check says when the scene names nothing the story bible knows. */
export const CONTINUITY_NO_REFERENCES =
  'There is nothing in the story bible to check this scene against yet.'
/** Why a finding whose proposal row is gone (evicted) cannot be applied. */
export const CONTINUITY_NO_PROPOSAL =
  'The suggestion this fix belonged to is gone; check the scene again to apply a fix'
/** The title of a scene that has left the tree. */
const MISSING_SCENE = 'Deleted scene'

const QUIET_LINK =
  'flex items-center gap-1 rounded px-1 text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline'
const LINK =
  'm-0 cursor-pointer border-0 bg-transparent p-0 text-left text-xs text-accent underline-offset-2 hover:underline'

/**
 * The way into the findings view (F-13.4; since the 2026-10-06 panel polish a quiet line under
 * the results instead of a header button): "N continuity notes" while findings are open, and
 * "Back to the conversation" while the view shows. Nothing at all while there are no findings
 * and the chat shows: no animation, no toast, no sound.
 */
export function ContinuityLink(): React.JSX.Element | null {
  const count = useContinuityStore((s) => s.ids.length)
  const open = useContinuityStore((s) => s.viewOpen)
  const setViewOpen = useContinuityStore((s) => s.setViewOpen)
  if (!open && count === 0) return null
  return (
    <div className="flex shrink-0 justify-end px-3 pt-1">
      <button
        type="button"
        data-testid="continuity-button"
        aria-pressed={open}
        title={open ? 'Back to the conversation' : 'What the scenes state against the story bible'}
        onClick={() => setViewOpen(!open)}
        className={QUIET_LINK}
      >
        {open ? (
          <>
            <ArrowLeft size={12} aria-hidden="true" />
            Back to the conversation
          </>
        ) : (
          <>
            <span data-testid="continuity-count">{count}</span>
            {count === 1 ? 'continuity note' : 'continuity notes'}
          </>
        )}
      </button>
    </div>
  )
}

/**
 * The findings view of the assistant panel (F-13.4): what the last check said on top (the check
 * itself is a chat turn the router sends to Check consistency), then every open finding grouped by scene in the order received. Each card
 * cites both sides: the scene's passage (a click opens the scene and selects it) and the
 * reference it contradicts (the sheet field with a link to the entity, or the other scene's
 * passage as a jump), with the reason, the word diff of the passage against the fix, Apply, and
 * `Changed in the story`, which dismisses it for good. Nothing here touches the manuscript until
 * Apply, and Apply needs the finding's scene to be the open one.
 */
export function ContinuityView(): React.JSX.Element {
  const findings = useContinuityFindings()
  const groups: { nodeId: string; findings: ContinuityFinding[] }[] = []
  for (const finding of findings) {
    const group = groups.find((g) => g.nodeId === finding.nodeId)
    if (group) group.findings.push(finding)
    else groups.push({ nodeId: finding.nodeId, findings: [finding] })
  }
  return (
    <section
      aria-label="Continuity"
      data-testid="continuity-panel"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t border-line px-3 py-2 text-sm"
    >
      <CheckScene />
      {groups.length === 0 ? (
        <p data-testid="continuity-empty" className="m-0 text-xs text-fg-muted">
          No open findings.
        </p>
      ) : (
        groups.map((group) => <SceneGroup key={group.nodeId} {...group} />)
      )}
    </section>
  )
}

/** The wait with Stop, the failure, and what the last check said. */
function CheckScene(): React.JSX.Element {
  const running = useContinuityStore((s) => s.running)
  const outcome = useContinuityStore((s) => s.outcome)
  const error = useContinuityStore((s) => s.error)
  const stop = useContinuityStore((s) => s.stop)
  const outcomeTitle = useTreeStore((s) =>
    outcome === null ? null : (s.byId[outcome.nodeId]?.title ?? MISSING_SCENE)
  )

  return (
    <div className="flex shrink-0 flex-col gap-1">
      {running !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <p
            data-testid="continuity-pending"
            aria-live="polite"
            className="m-0 text-xs text-fg-muted"
          >
            Reading the scene against the story bible…
          </p>
          <button type="button" data-testid="continuity-stop" onClick={stop} className={FIX_BUTTON}>
            Stop
          </button>
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" data-testid="continuity-error" className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {outcome === null ? null : outcome.references === 0 ? (
        <p data-testid="continuity-no-references" className="m-0 text-xs text-fg-muted">
          {CONTINUITY_NO_REFERENCES}
        </p>
      ) : (
        <>
          {outcome.truncated ? (
            <p data-testid="continuity-truncated" className="m-0 text-xs text-warning">
              {`Only the first ${CONTINUITY_SCENE_CHAR_BUDGET.toLocaleString()} characters were read, or not every reference fit.`}
            </p>
          ) : null}
          <p data-testid="continuity-result" className="m-0 text-xs text-fg-muted">
            {outcome.found === 0
              ? `No contradictions found in ${outcomeTitle ?? MISSING_SCENE}.`
              : `${outcome.found} ${outcome.found === 1 ? 'contradiction' : 'contradictions'} found in ${outcomeTitle ?? MISSING_SCENE}.`}
          </p>
          <p className="m-0 flex flex-wrap gap-2 text-xs text-fg-subtle">
            <span data-testid="continuity-cost">{describeRequest(outcome)}</span>
            {outcome.dropped > 0 ? (
              <span data-testid="continuity-dropped">
                {`${outcome.dropped} uncited or dismissed ${outcome.dropped === 1 ? 'finding' : 'findings'} dropped`}
              </span>
            ) : null}
          </p>
        </>
      )}
    </div>
  )
}

function SceneGroup({
  nodeId,
  findings
}: {
  nodeId: string
  findings: ContinuityFinding[]
}): React.JSX.Element {
  const title = useTreeStore((s) => s.byId[nodeId]?.title ?? MISSING_SCENE)
  const active = useActiveEditorStore((s) => s.active)
  const editor =
    active !== null && active.id === nodeId && !active.editor.isDestroyed ? active.editor : null
  return (
    <div data-testid="continuity-group" className="flex flex-col gap-2">
      <h3 className="m-0 text-xs font-medium text-fg-muted">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {findings.map((finding) => (
          <Finding key={finding.id} finding={finding} editor={editor} />
        ))}
      </ul>
    </div>
  )
}

/** Opens the scene and selects the quoted passage in it; a passage that is gone toasts (`openPassage`). */
const jumpTo = (nodeId: string, quote: string): void => {
  void openPassage(nodeId, (doc) => locateText(doc, quote))
}

/** One finding. `editor` is the finding's scene when it is the open one, else null. */
function Finding({
  finding,
  editor
}: {
  finding: ContinuityFinding
  editor: Editor | null
}): React.JSX.Element {
  const apply = useContinuityStore((s) => s.apply)
  const settle = useContinuityStore((s) => s.settle)
  const gone = useContinuityStore((s) => s.gone[finding.id] === true)
  const rewriting = useRewriteStore((s) => s.session !== null)
  const { fix, proposalId } = finding

  let title = 'Replace the quoted passage with this fix'
  if (gone) title = CONTINUITY_GONE_MESSAGE
  else if (proposalId === null) title = CONTINUITY_NO_PROPOSAL
  else if (rewriting) title = REWRITE_BUSY_MESSAGE

  return (
    <li
      data-testid="continuity-finding"
      data-ref-kind={finding.ref.kind}
      className="flex flex-col gap-1 rounded-md border-l-2 border-warning bg-surface-raised p-2"
    >
      <button
        type="button"
        data-testid="continuity-quote"
        title="Open the scene at this passage"
        onClick={() => jumpTo(finding.nodeId, finding.quote)}
        className={FIX_QUOTE_BUTTON}
      >
        {finding.quote}
      </button>
      <Reference reference={finding.ref} />
      <p data-testid="continuity-why" className="m-0 text-xs text-fg-muted">
        {finding.why}
      </p>
      {finding.flagged ? (
        <OffVoiceFlag violation={finding.violation} testId="continuity-flag" />
      ) : null}
      {fix === null ? null : (
        <FixDiff quote={finding.quote} fix={fix} testId="continuity-fix-diff" />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {fix === null ? null : editor === null ? (
          <button
            type="button"
            data-testid="continuity-open-scene"
            title="The fix can be applied once its scene is open"
            onClick={() => jumpTo(finding.nodeId, finding.quote)}
            className={FIX_BUTTON}
          >
            Open the scene to apply
          </button>
        ) : (
          <button
            type="button"
            data-testid="continuity-apply"
            disabled={gone || proposalId === null || rewriting}
            title={title}
            onClick={() => void apply(finding.id, editor)}
            className={FIX_PRIMARY_BUTTON}
          >
            Apply
          </button>
        )}
        <button
          type="button"
          data-testid="continuity-dismiss"
          title="The story changed here on purpose; do not raise this again for this scene"
          onClick={() => void settle(finding.id, 'dismissed')}
          className={FIX_BUTTON}
        >
          Changed in the story
        </button>
        {gone ? (
          <span data-testid="continuity-stale" className="text-xs text-warning">
            {CONTINUITY_GONE_MESSAGE}
          </span>
        ) : fix !== null && editor !== null && proposalId === null ? (
          <span data-testid="continuity-no-proposal" className="text-xs text-fg-subtle">
            {CONTINUITY_NO_PROPOSAL}
          </span>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The second citation: what the story bible says (label, value, whose), and where it says it. A
 * sheet field links to the entity's page; an observed fact shows the other scene's passage as a
 * jump; the timeline links to the previous scene. A link whose target was deleted is plain text.
 */
function Reference({ reference }: { reference: ContinuityRef }): React.JSX.Element {
  const sceneTitle = useTreeStore((s) =>
    reference.nodeId === null ? null : (s.byId[reference.nodeId]?.title ?? null)
  )
  const entityLive = useEntityStore(
    (s) => reference.entityId !== null && s.byId[reference.entityId] !== undefined
  )
  const { kind, entityId, entityName, nodeId, quote } = reference
  const source =
    kind === 'sheet'
      ? 'sheet'
      : kind === 'fact'
        ? (sceneTitle ?? 'another scene')
        : 'previous scene'
  return (
    <div data-testid="continuity-ref" className="flex flex-col gap-0.5 text-xs">
      <p className="m-0 text-fg">
        <span className="text-fg-muted">{`Story bible (${source}): `}</span>
        {entityName !== null ? `${entityName} · ` : ''}
        {`${reference.label}: ${reference.value}`}
      </p>
      {kind === 'sheet' && entityId !== null && entityLive ? (
        <button
          type="button"
          data-testid="continuity-ref-entity"
          onClick={() => useEntityStore.getState().select(entityId)}
          className={LINK}
        >
          {`Open ${entityName ?? 'the sheet'}`}
        </button>
      ) : null}
      {kind === 'fact' && quote !== null ? (
        nodeId !== null && sceneTitle !== null ? (
          <button
            type="button"
            data-testid="continuity-ref-quote"
            title={`Open ${sceneTitle} at this passage`}
            onClick={() => jumpTo(nodeId, quote)}
            className={FIX_QUOTE_BUTTON}
          >
            {quote}
          </button>
        ) : (
          <p
            data-testid="continuity-ref-quote"
            className="m-0 border-l-2 border-line px-2 py-0.5 text-sm italic text-fg-muted"
          >
            {quote}
          </p>
        )
      ) : null}
      {kind === 'timeline' && nodeId !== null && sceneTitle !== null ? (
        <button
          type="button"
          data-testid="continuity-ref-scene"
          onClick={() => useTreeStore.getState().select(nodeId)}
          className={LINK}
        >
          {`Open ${sceneTitle}`}
        </button>
      ) : null}
    </div>
  )
}
