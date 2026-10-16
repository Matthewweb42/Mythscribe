import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, PenLine } from 'lucide-react'
import { priceFor } from '@shared/ai'
import { isFeatureAllowed } from '@shared/aiSettings'
import {
  EDIT_FLOW_CATEGORIES,
  EDIT_FLOW_CHECKS,
  EDIT_FLOW_DEPTH_HELP,
  EDIT_FLOW_DEPTH_LABEL,
  EDIT_FLOW_DEPTHS,
  EDIT_FLOW_HELP,
  EDIT_FLOW_LABEL,
  EDIT_FLOW_SCOPE_LABEL,
  EDIT_FLOW_SCOPES,
  EDIT_FLOW_STAGES,
  EDIT_FLOW_TIER,
  flowCategoryFixes,
  type EditFlowCategory,
  type EditFlowDetail,
  type EditFlowIssue,
  type EditFlowPlanResult,
  type EditFlowRun,
  type EditFlowSpec
} from '@shared/editFlow'
import { useOpenScene } from '@renderer/features/ai/aiActions'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { NotebookChange } from '@renderer/features/ai/AgentTurn'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import { useHostedPricing } from '@renderer/features/account/hostedPricing'
import { confirmLine, estimateLine, quoteEstimate, useFeatureModel } from '@renderer/features/editPass/passQuote'
import {
  FIX_BUTTON,
  FIX_PRIMARY_BUTTON,
  FIX_QUOTE_BUTTON,
  FixDiff,
  OffVoiceFlag
} from '@renderer/features/editor/FixDiff'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useStoryMemory } from '@renderer/features/project/storyMemory'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { specFor, useEditFlowStore } from './editFlowStore'

const SECTION = 'flex flex-col gap-2 border-b border-line px-3 py-3'
const HEADING = 'm-0 text-xs font-semibold uppercase tracking-wide text-fg-muted'
const QUIET_LINK =
  'flex items-center gap-1 rounded px-1 text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline'
const CHOICE = 'flex items-start gap-2 text-sm'

/**
 * The Edit button in the right column's header (notes redesign phase 2): opens the edit flow in
 * the column, or goes back to the chat. Story memory v1 projects only (what the installed app
 * runs); hidden in v2, whose channels the flow does not serve.
 */
export function EditFlowButton(): React.JSX.Element | null {
  const memory = useStoryMemory()
  const open = useEditFlowStore((s) => s.open)
  if (memory !== 'v1') return null
  return (
    <button
      type="button"
      data-testid="edit-flow-open"
      aria-pressed={open}
      title={open ? 'Back to the conversation' : 'Edit: stages and checks over a scene, a chapter or the book'}
      onClick={() => {
        const store = useEditFlowStore.getState()
        if (open) store.close()
        else store.openFlow()
      }}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:text-fg"
    >
      <PenLine size={13} aria-hidden="true" />
      Edit
    </button>
  )
}

/**
 * The edit flow in the right column: the set-up (stages and checks, scope, Quick or Deep, the
 * price, Run) or a run's results (the overview, note edits with Undo, and the issues grouped by
 * category, each opening its passage; fixes accepted or rejected here or inline in the text).
 */
export function EditFlowPanel(): React.JSX.Element {
  const shownId = useEditFlowStore((s) => s.shownId)
  const projectId = useProjectStore((s) => s.current?.id ?? null)
  // The kept runs of the project open now, read when the panel shows.
  useEffect(() => {
    if (projectId === null) return
    useEditFlowStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [projectId])
  return (
    <section
      aria-label="Edit flow"
      data-testid="edit-flow-panel"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      {shownId === null ? <FlowSetup /> : <FlowResults runId={shownId} />}
    </section>
  )
}

/** What `editFlow:plan` says the spec would send; null while it is asked, or with the reason. */
function useQuote(spec: EditFlowSpec | string): {
  plan: EditFlowPlanResult | null
  error: string | null
} {
  const [state, setState] = useState<{
    spec: EditFlowSpec | string | null
    plan: EditFlowPlanResult | null
    error: string | null
  }>({ spec: null, plan: null, error: null })
  useEffect(() => {
    if (typeof spec === 'string') return
    let live = true
    ipc()
      .invoke('editFlow:plan', spec)
      .then(
        (plan) => {
          if (live) setState({ spec, plan, error: null })
        },
        (err: unknown) => {
          if (live) setState({ spec, plan: null, error: describeError(err) })
        }
      )
    return () => {
      live = false
    }
  }, [spec])
  if (typeof spec === 'string') return { plan: null, error: spec }
  return state.spec === spec ? { plan: state.plan, error: state.error } : { plan: null, error: null }
}

function FlowSetup(): React.JSX.Element {
  const categories = useEditFlowStore((s) => s.categories)
  const depth = useEditFlowStore((s) => s.depth)
  const scope = useEditFlowStore((s) => s.scope)
  const chapterId = useEditFlowStore((s) => s.chapterId)
  const sceneId = useEditFlowStore((s) => s.sceneId)
  const starting = useEditFlowStore((s) => s.starting)
  const runs = useEditFlowStore((s) => s.runs)
  const open = useOpenScene()
  const settings = useAiSettingsStore((s) => s.settings)
  const allowed = settings !== null && isFeatureAllowed(settings, 'editFlow')
  const { nodeId, scene } = open
  // One spec per choice, so the price is asked once for it.
  const spec = useMemo(
    () => specFor({ categories, depth, scope, chapterId, sceneId }, { nodeId, scene }),
    [categories, depth, scope, chapterId, sceneId, nodeId, scene]
  )
  const { plan, error } = useQuote(spec)
  const { model, source } = useFeatureModel('editFlow', EDIT_FLOW_TIER[depth])
  const pricing = useHostedPricing()
  const priced = useMemo(() => {
    if (plan === null) return null
    const price = priceFor(model, plan.tokensIn, plan.tokensOut)
    return quoteEstimate(
      {
        scenes: plan.scenes,
        words: plan.words,
        chunks: plan.requests,
        tokensIn: plan.tokensIn,
        tokensOut: plan.tokensOut,
        costUsd: price.costUsd,
        priced: price.priced
      },
      model,
      source === 'cloud',
      pricing
    )
  }, [plan, model, source, pricing])
  const [confirming, setConfirming] = useState(false)
  const reason = !allowed
    ? 'The edit flow needs Use AI on for this project (Settings, AI).'
    : typeof spec === 'string'
      ? spec
      : (error ?? (plan === null ? 'Pricing…' : null))

  const run = async (): Promise<void> => {
    if (typeof spec === 'string') return
    if (priced?.quote?.needsConfirm === true && !confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    await useEditFlowStore.getState().start(spec)
  }

  return (
    <>
      <CategoryGroup title="Stages" list={EDIT_FLOW_STAGES} />
      <CategoryGroup title="Focused checks" list={EDIT_FLOW_CHECKS} />
      <CategoryGroup title="Notes" list={['updateNotes']} />
      <fieldset className={SECTION}>
        <legend className={`${HEADING} mb-1`}>Scope</legend>
        <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Scope">
          {EDIT_FLOW_SCOPES.map((value) => (
            <label key={value} className="flex items-center gap-1 text-sm">
              <input
                type="radio"
                name="edit-flow-scope"
                checked={scope === value}
                onChange={() => useEditFlowStore.getState().setScope(value)}
              />
              {EDIT_FLOW_SCOPE_LABEL[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className={SECTION}>
        <legend className={`${HEADING} mb-1`}>Depth</legend>
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Depth">
          {EDIT_FLOW_DEPTHS.map((value) => (
            <label key={value} className={CHOICE}>
              <input
                type="radio"
                name="edit-flow-depth"
                className="mt-1"
                checked={depth === value}
                onChange={() => useEditFlowStore.getState().setDepth(value)}
              />
              <span>
                {EDIT_FLOW_DEPTH_LABEL[value]}
                <span className="block text-xs text-fg-muted">{EDIT_FLOW_DEPTH_HELP[value]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <section className={SECTION} aria-label="Price" data-testid="edit-flow-price">
        {plan !== null && priced !== null ? (
          <>
            <p className="m-0 text-sm">
              {`${plan.scopeTitle === 'the whole book' ? 'The whole book' : plan.scopeTitle} · ${formatCount(plan.words, 'word')} · ${formatCount(plan.requests, 'request')}`}
            </p>
            <p className="m-0 text-xs text-fg-muted" data-testid="edit-flow-price-line">
              {estimateLine(priced)}
            </p>
          </>
        ) : (
          <p className="m-0 text-xs text-fg-muted">{reason ?? 'Pricing…'}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="edit-flow-run"
            disabled={reason !== null || starting}
            onClick={() => void run()}
            className={FIX_PRIMARY_BUTTON}
          >
            {confirming ? 'Confirm and run' : 'Run'}
          </button>
          {confirming && priced?.quote ? (
            <>
              <span role="status" className="text-xs text-fg">
                {confirmLine(priced.quote)}
              </span>
              <button type="button" className={FIX_BUTTON} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : null}
        </div>
      </section>
      {runs.length > 0 ? <KeptRuns runs={runs} /> : null}
    </>
  )
}

function CategoryGroup({
  title,
  list
}: {
  title: string
  list: readonly EditFlowCategory[]
}): React.JSX.Element {
  const categories = useEditFlowStore((s) => s.categories)
  return (
    <fieldset className={SECTION}>
      <legend className={`${HEADING} mb-1`}>{title}</legend>
      {list.map((category) => (
        <label key={category} className={CHOICE} data-testid="edit-flow-category">
          <input
            type="checkbox"
            className="mt-1"
            checked={categories.includes(category)}
            onChange={() => useEditFlowStore.getState().toggleCategory(category)}
          />
          <span>
            {EDIT_FLOW_LABEL[category]}
            <span className="block text-xs text-fg-muted">{EDIT_FLOW_HELP[category]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function runLine(run: EditFlowRun): string {
  const what = run.spec.categories.map((category) => EDIT_FLOW_LABEL[category]).join(', ')
  const line = `${what} · ${run.scopeTitle} · ${EDIT_FLOW_DEPTH_LABEL[run.spec.depth]}`
  // Phase 3: an update started by leaving a chapter, kept apart from the author's own runs.
  return run.automatic ? `${line} · automatic` : line
}

function KeptRuns({ runs }: { runs: EditFlowRun[] }): React.JSX.Element {
  return (
    <section className={SECTION} aria-label="Earlier runs">
      <h3 className={HEADING}>Earlier runs</h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              data-testid="edit-flow-kept-run"
              onClick={() => void useEditFlowStore.getState().show(run.id)}
              className="m-0 cursor-pointer border-0 bg-transparent p-0 text-left text-xs text-accent underline-offset-2 hover:underline"
            >
              {runLine(run)}
            </button>
            <span className="ml-1 text-xs text-fg-muted">{`${run.counts.pending} open`}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

const STATUS_LINE: Record<EditFlowRun['status'], string> = {
  running: 'Running',
  done: 'Done',
  cancelled: 'Stopped',
  failed: 'Stopped'
}

function FlowResults({ runId }: { runId: string }): React.JSX.Element {
  const detail = useEditFlowStore((s) => (s.detail?.run.id === runId ? s.detail : null))
  const listed = useEditFlowStore((s) => s.runs.find((run) => run.id === runId) ?? null)
  const run = detail?.run ?? listed
  return (
    <>
      <div className="flex shrink-0 items-center justify-between px-3 pt-2">
        <button
          type="button"
          data-testid="edit-flow-back"
          onClick={() => void useEditFlowStore.getState().show(null)}
          className={QUIET_LINK}
        >
          <ArrowLeft size={12} aria-hidden="true" />
          New run
        </button>
      </div>
      {run === null ? (
        <p className="m-0 px-3 py-2 text-sm text-fg-muted">Loading…</p>
      ) : (
        <>
          <RunHeader run={run} />
          {detail === null ? null : <RunBody detail={detail} />}
        </>
      )}
    </>
  )
}

function RunHeader({ run }: { run: EditFlowRun }): React.JSX.Element {
  return (
    <section className={SECTION} aria-label="Run" data-testid="edit-flow-run-status" data-status={run.status}>
      <p className="m-0 text-sm font-medium">{runLine(run)}</p>
      <p className="m-0 text-xs text-fg-muted">
        {`${STATUS_LINE[run.status]} · ${run.done} of ${formatCount(run.total, 'request')} · ${formatUsd(run.costUsd)}`}
        {run.dropped > 0 ? ` · ${formatCount(run.dropped, 'item')} left out (no passage found)` : ''}
      </p>
      {run.error ? <p className="m-0 text-xs text-danger">{run.error}</p> : null}
      {run.status === 'running' ? (
        <button
          type="button"
          data-testid="edit-flow-stop"
          className={`${FIX_BUTTON} self-start`}
          onClick={() => void useEditFlowStore.getState().cancel(run.id)}
        >
          Stop (keep what came back)
        </button>
      ) : null}
    </section>
  )
}

function RunBody({ detail }: { detail: EditFlowDetail }): React.JSX.Element {
  const groups = useMemo(() => {
    const byCategory = new Map<EditFlowCategory, EditFlowIssue[]>()
    for (const issue of detail.issues) {
      const list = byCategory.get(issue.flowCategory) ?? []
      list.push(issue)
      byCategory.set(issue.flowCategory, list)
    }
    return EDIT_FLOW_CATEGORIES.flatMap((category) => {
      const issues = byCategory.get(category)
      return issues === undefined ? [] : [{ category, issues }]
    })
  }, [detail.issues])
  const { run } = detail
  const empty =
    detail.issues.length === 0 && run.overview === null && run.noteEdits.length === 0
  return (
    <>
      {run.overview !== null ? (
        <section className={SECTION} aria-label="Overview" data-testid="edit-flow-overview">
          <h3 className={HEADING}>Overview</h3>
          <p className="m-0 whitespace-pre-wrap text-sm">{run.overview}</p>
        </section>
      ) : null}
      {run.noteEdits.length > 0 ? (
        <section className={SECTION} aria-label="Notes updated">
          <h3 className={HEADING}>{EDIT_FLOW_LABEL.updateNotes}</h3>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {run.noteEdits.map((entry, index) =>
              entry.edit.kind === 'notebook' ? (
                <li
                  key={`${entry.edit.pageId}-${index}`}
                  data-testid="edit-flow-note-edit"
                  data-status={entry.undone ? 'undone' : 'applied'}
                  className="flex flex-col gap-1"
                >
                  <span className="text-xs text-fg-muted">
                    {entry.undone
                      ? `Undone: ${entry.edit.title}`
                      : `${entry.edit.created ? 'Made the page' : 'Updated'} “${entry.edit.title}”`}
                  </span>
                  {entry.undone ? null : (
                    <>
                      <NotebookChange edit={entry.edit} />
                      <button
                        type="button"
                        data-testid="edit-flow-note-undo"
                        className={`${FIX_BUTTON} self-start`}
                        onClick={() => void useEditFlowStore.getState().undoNote(index)}
                      >
                        Undo
                      </button>
                    </>
                  )}
                </li>
              ) : null
            )}
          </ul>
        </section>
      ) : null}
      {groups.map(({ category, issues }) => (
        <section
          key={category}
          className={SECTION}
          aria-label={EDIT_FLOW_LABEL[category]}
          data-testid="edit-flow-group"
          data-category={category}
        >
          <h3 className={HEADING}>{`${EDIT_FLOW_LABEL[category]} (${issues.length})`}</h3>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {issues.map((issue) => (
              <IssueItem key={issue.id} issue={issue} title={detail.titles[issue.nodeId] ?? ''} />
            ))}
          </ul>
        </section>
      ))}
      {empty && run.status !== 'running' ? (
        <p className="m-0 px-3 py-3 text-sm text-fg-muted" data-testid="edit-flow-empty">
          Nothing to change came back.
        </p>
      ) : null}
    </>
  )
}

const ISSUE_STATUS: Record<EditFlowIssue['status'], string> = {
  pending: '',
  accepted: 'Accepted',
  rejected: 'Rejected',
  stale: 'Text changed'
}

function IssueItem({ issue, title }: { issue: EditFlowIssue; title: string }): React.JSX.Element {
  const store = useEditFlowStore.getState()
  const pending = issue.status === 'pending'
  const fix = issue.kind === 'change' && flowCategoryFixes(issue.flowCategory)
  const status = issue.textChanged ? 'Text changed' : ISSUE_STATUS[issue.status]
  return (
    <li
      className="flex flex-col gap-1"
      data-testid="edit-flow-issue"
      data-status={issue.status}
      data-kind={issue.kind}
    >
      <span className="text-xs text-fg-muted">{title}</span>
      <button
        type="button"
        data-testid="edit-flow-issue-jump"
        title={`Open ${title} at this passage`}
        className={FIX_QUOTE_BUTTON}
        onClick={() => void store.jump(issue)}
      >
        {fix ? (
          <FixDiff quote={issue.original} fix={issue.replacement ?? ''} testId="edit-flow-diff" />
        ) : (
          `“${issue.original}”`
        )}
      </button>
      {issue.rationale ? <p className="m-0 text-sm">{issue.rationale}</p> : null}
      {issue.flagged ? <OffVoiceFlag violation={issue.violation} testId="edit-flow-flag" /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {status !== '' ? (
          <span className="text-xs text-fg-muted" data-testid="edit-flow-issue-status">
            {status}
          </span>
        ) : null}
        {pending && fix && !issue.textChanged ? (
          <>
            <button
              type="button"
              className={FIX_PRIMARY_BUTTON}
              data-testid="edit-flow-issue-accept"
              onClick={() => void store.accept(issue)}
            >
              Accept
            </button>
            <button
              type="button"
              className={FIX_BUTTON}
              data-testid="edit-flow-issue-reject"
              onClick={() => void store.reject(issue)}
            >
              Reject
            </button>
          </>
        ) : null}
        {pending && (!fix || issue.textChanged) ? (
          <button
            type="button"
            className={FIX_BUTTON}
            data-testid="edit-flow-issue-dismiss"
            onClick={() => void store.reject(issue)}
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </li>
  )
}
