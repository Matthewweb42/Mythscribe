import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { TAGS_MIN_CHARS, type AiUsage } from '@shared/ai'
import { docToText } from '@shared/docText'
import { countInlineTags } from '@shared/inlineTags'
import type { Tag } from '@shared/ipc/contract'
import { TAG_BAR_MAX_FRACTION, TAG_BAR_MIN_HEIGHT, TAG_BAR_SPLIT_LIMITS } from '@shared/layout'
import type { MentionRange } from '@shared/mentions'
import { PROPOSAL_NOTE_MAX, normalizeProposalNote } from '@shared/proposal'
import type { ProposedTag } from '@shared/proposedTags'
import { resolveTagId } from '@shared/tagExchange'
import { toTagName } from '@shared/tags'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { describeRequest } from '@renderer/features/ai/usageFormat'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import {
  resizeTagBarBy,
  resizeTagBarSplitBy,
  useLayoutStore
} from '@renderer/features/shell/layoutStore'
import { ResizeHandle } from '@renderer/features/shell/ResizeHandle'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useMentionStore } from '@renderer/features/tags/mentionStore'
import { useProposedTagStore } from '@renderer/features/tags/proposedTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'
import { MetadataPane } from './MetadataPane'
import { openMention } from './openPassage'
import { TagPicker } from './TagPicker'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md whitespace-nowrap px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const LINK_BUTTON = 'rounded px-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg'

let requestCounter = 0
/** A request id `ai:cancel` can find (F-5.10), unique across this renderer's tag bars. */
const nextRequestId = (): string => `t-${Date.now().toString(36)}-${++requestCounter}`

/**
 * One Recommend request (F-4.7), keyed by the node it was made for so a document switch drops
 * it without an effect (the `pickingFor` idiom); the suggestions are bank tags, rendered live
 * from the bank by id, and leave the list only when accepted, so a failed link keeps its chip.
 * A `done` result is the proposal (F-14.5) the author settles: `acceptedCount` is how many of
 * its chips were linked, which decides between accepted in part and rejected on Dismiss. The
 * pending state carries the request id its Cancel button stops (F-5.10). A `done` result is
 * also how the tags the import pass proposed are offered (F-12.3): the same chips and the same
 * settlements, only the request was made during the import, so `fromImport` replaces the cost
 * line (this bar spent nothing; the pass's cost is on its own rows in the ledger).
 */
type RecommendState =
  | { nodeId: string; status: 'pending'; requestId: string }
  | {
      nodeId: string
      status: 'done'
      proposalId: string
      suggestions: Tag[]
      acceptedCount: number
      model: string
      costUsd: number
      /** The tokens the request spent, for the cost line (F-5.9). */
      usage: AiUsage
      cached: boolean
      /** True for a proposal the import pass left pending (F-12.3), not a Recommend answer. */
      fromImport: boolean
    }
  | { nodeId: string; status: 'error'; message: string; nextStep: string }

/** What Regenerate… sends beside the node: the author's note and the proposal it replaces. */
interface RegenerateOptions {
  note: string | null
  regeneratedFrom: string
}

/**
 * The tag bar (F-4.4) above the editor of a document and, in the stacked view, of the chapter or
 * part itself: the linked tags as colored chips with a remove button each, an "Add tag" picker
 * of the unassigned tags, a collapse toggle, and a draggable height (100 px to 60 % of the
 * window), both kept in the app-wide layout. For a node with a hierarchy level (scene, chapter,
 * part) the metadata pane (F-4.5) sits to the left of the tags, behind a draggable split of
 * 30–70 % of the bar's width, also in the layout. Takes only `id`: it loads the node's links
 * itself and reads the tag records from the bank by id, so a rename or recolor in the Tags tab
 * shows here at once. Below the chips, the inline tags used in the text (F-4.6) are listed with
 * their occurrence counts, taken from the document's live content, so they follow the typing
 * before any save; a folder is never loaded as a document, so its bar has no such list. Under
 * those, the automatic mentions (F-4.12) main recorded for the saved text: one row per tag whose
 * name occurs here, with its count and a jump to the first occurrence. They are not links, so
 * nothing about them is editable from the bar. Under those again, the proposed tags (F-4.12b):
 * the recurring capitalised names of the manuscript that no tag stands for, narrowed to the ones
 * this document carries, each with a Create tag button and a Dismiss button; nothing is created
 * until one is clicked.
 * "Recommend" (F-4.7) asks main for bank tags that fit the live text once it has 50 characters
 * (a folder never does, so there it stays disabled) and shows them as chips the author accepts
 * one at a time, all at once, or dismisses; nothing is linked until accepted, and the note
 * under the chips says which model answered and what it cost. Each answer is a proposal
 * (F-14.5): accepting every chip settles it accepted, Dismiss settles it accepted in part or
 * rejected (one click, no note), and "Regenerate…" asks what was off, settles it regenerated
 * with that note, and asks again with the note and the proposal id in the request. While a
 * request is pending, Cancel stops it (F-5.10): the reply comes back cancelled and the bar
 * returns to idle without a word. The same chips carry the tags an import's structure pass
 * proposed (F-12.3): opening an imported document asks main for its pending proposal once and
 * shows what is left of it, so the author accepts those one by one too.
 */
export function TagBar({ id }: { id: string }): React.JSX.Element {
  const tagBar = useLayoutStore((s) => s.layout.tagBar)
  const toggleTagBar = useLayoutStore((s) => s.toggleTagBar)
  const withMetadata = useTreeStore((s) => (s.byId[id]?.hierarchyLevel ?? null) !== null)
  /** Only a document can carry a pending tag proposal from an import (F-12.3). */
  const isDocument = useTreeStore((s) => s.byId[id]?.kind === 'document')
  /** The row holding both panes; the split drag is measured against its width. */
  const panes = useRef<HTMLDivElement>(null)
  const ids = useDocumentTagStore((s) => s.tagIdsByNode[id])
  /** F-4.13: the links the background job made, marked on their chips until the author takes them. */
  const aiIds = useDocumentTagStore((s) => s.aiTagIdsByNode[id])
  const load = useDocumentTagStore((s) => s.load)
  const add = useDocumentTagStore((s) => s.add)
  const remove = useDocumentTagStore((s) => s.remove)
  const merge = useTagStore((s) => s.merge)
  const mentions = useMentionStore((s) => s.byNode[id])
  const loadMentions = useMentionStore((s) => s.loadForNode)
  const bank = useTagStore((s) => s.byId)
  // A mention of a tag that has left the bank has no name or color to show; main drops the rows
  // on a delete, so this only bridges the moment between the delete and the event.
  const mentioned = useMemo(
    () => (mentions ?? []).filter((row) => bank[row.tagId] !== undefined),
    [mentions, bank]
  )
  // F-4.12b: the app-wide proposals main pushed, narrowed to the names this document carries, so
  // the bar proposes what the author is looking at rather than the whole manuscript's list.
  const proposals = useProposedTagStore((s) => s.proposals)
  const proposed = useMemo(
    () => proposals.filter((proposal) => proposal.nodeIds.includes(id)),
    [proposals, id]
  )
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  const flush = useDocumentStore((s) => s.flush)
  const aliases = useTagStore((s) => s.aliases)
  // Tokens keep the id they were inserted with; a token of a merged tag counts toward the tag it
  // was merged into (F-4.9), so two tokens of what is now one tag show as one row.
  const inlineCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    if (!content) return counts
    const exists = (tagId: string): boolean => bank[tagId] !== undefined
    for (const [tagId, count] of Object.entries(countInlineTags(content))) {
      const resolved = resolveTagId(tagId, aliases, exists)
      counts[resolved] = (counts[resolved] ?? 0) + count
    }
    return counts
  }, [content, bank, aliases])
  const inlineIds = Object.keys(inlineCounts)
  const textLength = useMemo(() => (content ? docToText(content).length : 0), [content])
  const canRecommend = textLength >= TAGS_MIN_CHARS
  /** The node id the picker is open for, so a document switch closes it without an effect. */
  const [pickingFor, setPickingFor] = useState<string | null>(null)
  const picking = pickingFor === id
  const [recommend, setRecommend] = useState<RecommendState | null>(null)
  /** The node whose import proposal was already asked for, so the query runs once per document. */
  const askedPending = useRef<string | null>(null)
  const bankLoaded = useTagStore((s) => s.loaded)
  const result = recommend?.nodeId === id ? recommend : null
  /**
   * A result drained by acceptance (no suggestions left, at least one linked) is finished: it
   * renders as no result and the effect below settles its proposal accepted. An empty answer
   * has `acceptedCount` 0 and stays visible as "No new tags fit." until dismissed.
   */
  const drained =
    result?.status === 'done' && result.suggestions.length === 0 && result.acceptedCount > 0
      ? result
      : null
  const mine = drained ? null : result
  useEffect(() => {
    if (drained) void proposalStore.settle(drained.proposalId, 'accepted')
  }, [drained])
  const pending = mine?.status === 'pending'
  const cancel = useAiActivityStore((s) => s.cancel)
  const track = useAiActivityStore((s) => s.track)
  const bodyId = useId()

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
  }, [id, load])

  // F-4.12: what main's scan recorded for this document; `mention:changed` refreshes it after
  // every save, so the list follows the manuscript without this bar asking again.
  useEffect(() => {
    loadMentions(id).catch((err: unknown) => toast.error(describeError(err)))
  }, [id, loadMentions])

  const linked = ids ?? []
  const linksLoaded = ids !== undefined

  /**
   * F-12.3: what the import's structure pass proposed for this scene waits as a pending proposal
   * until the author opens it. The bar asks main once per document — after the bank and the
   * links are in, since unknown names and names already on the document are dropped here — and
   * seeds the F-4.7 result with what is left, so those chips are accepted one at a time, all at
   * once, or dismissed, settling the proposal exactly as a Recommend answer does. Nothing is
   * linked by the import itself. A row with nothing left to offer is settled rejected and shown
   * to no one. A Recommend result the author asked for owns the bar: the row then stays pending
   * and is offered again the next time the document is opened.
   */
  useEffect(() => {
    if (!isDocument || !bankLoaded || !linksLoaded || askedPending.current === id) return
    askedPending.current = id
    const nodeId = id
    let live = true
    ipc()
      .invoke('proposal:pendingTags', { nodeId })
      .then((answer) => {
        if (!live || answer === null) return
        const bank = useTagStore.getState().byId
        const linkedIds = useDocumentTagStore.getState().tagIdsByNode[nodeId] ?? []
        const byName = new Map(Object.values(bank).map((tag) => [toTagName(tag.name), tag]))
        const suggestions: Tag[] = []
        for (const name of answer.tags) {
          const tag = byName.get(toTagName(name))
          if (!tag || linkedIds.includes(tag.id) || suggestions.includes(tag)) continue
          suggestions.push(tag)
        }
        if (suggestions.length === 0) {
          void proposalStore.settle(answer.proposalId, 'rejected')
          return
        }
        setRecommend((current) =>
          current?.nodeId === nodeId
            ? current
            : {
                nodeId,
                status: 'done',
                proposalId: answer.proposalId,
                suggestions,
                acceptedCount: 0,
                model: answer.model,
                costUsd: 0,
                usage: { inputTokens: 0, outputTokens: 0 },
                cached: false,
                fromImport: true
              }
        )
      })
      .catch(() => {
        // Nobody asked for this query, so a failure says nothing: the proposal stays pending and
        // the next time the document is opened it is offered again.
      })
    return () => {
      live = false
    }
  }, [id, isDocument, bankLoaded, linksLoaded])
  const report = (err: unknown): void => {
    toast.error(describeError(err))
  }
  const maxHeight = Math.max(
    TAG_BAR_MIN_HEIGHT,
    Math.round(window.innerHeight * TAG_BAR_MAX_FRACTION)
  )

  // Main reads the saved row, so unsaved typing is flushed first: the request carries what
  // the author sees, and the 50-character gate here and in main agree.
  const askForTags = (nodeId: string, regenerate?: RegenerateOptions): void => {
    const requestId = nextRequestId()
    /** Replaces the pending state this request owns; a reply for another request changes nothing. */
    const settle = (next: RecommendState | null): void => {
      setRecommend((current) =>
        current?.status === 'pending' && current.requestId === requestId ? next : current
      )
    }
    setRecommend({ nodeId, status: 'pending', requestId })
    flush()
      .then(() =>
        track(
          'tags',
          requestId,
          ipc().invoke(
            'ai:recommendTags',
            regenerate
              ? {
                  nodeId,
                  note: regenerate.note,
                  regeneratedFrom: regenerate.regeneratedFrom,
                  requestId
                }
              : { nodeId, requestId }
          )
        )
      )
      .then((result) => {
        if (result.ok) {
          for (const tag of result.suggestions) merge(tag)
          settle({
            nodeId,
            status: 'done',
            proposalId: result.proposalId,
            suggestions: result.suggestions,
            acceptedCount: 0,
            model: result.model,
            costUsd: result.costUsd,
            usage: result.usage,
            cached: result.cached,
            fromImport: false
          })
        } else if (result.code === 'CANCELLED') {
          settle(null)
        } else {
          settle({
            nodeId,
            status: 'error',
            message: result.message,
            nextStep: result.nextStep
          })
        }
      })
      .catch((err: unknown) => {
        settle(null)
        report(err)
      })
  }
  /** Stops the pending request; the bar goes idle when its cancelled reply lands. */
  const cancelRecommend = (): void => {
    if (mine?.status !== 'pending') return
    void cancel(mine.requestId)
  }
  /** Drops accepted suggestions from the result; draining it is settled by the effect above. */
  const dropAccepted = (nodeId: string, acceptedIds: string[]): void => {
    setRecommend((current) => {
      if (current?.nodeId !== nodeId || current.status !== 'done') return current
      const suggestions = current.suggestions.filter((tag) => !acceptedIds.includes(tag.id))
      const acceptedCount = current.acceptedCount + current.suggestions.length - suggestions.length
      return { ...current, suggestions, acceptedCount }
    })
  }
  const accept = (tagId: string): void => {
    const nodeId = id
    add(nodeId, tagId).then(() => dropAccepted(nodeId, [tagId]), report)
  }
  const acceptAll = (): void => {
    if (mine?.status !== 'done') return
    const nodeId = id
    void Promise.allSettled(
      mine.suggestions.map((tag) => add(nodeId, tag.id).then(() => tag.id))
    ).then((outcomes) => {
      const accepted: string[] = []
      let failure: unknown = null
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') accepted.push(outcome.value)
        else failure ??= outcome.reason
      }
      dropAccepted(nodeId, accepted)
      if (failure !== null) report(failure)
    })
  }
  /** One click: the proposal is accepted in part when any chip was linked, rejected otherwise. */
  const dismiss = (): void => {
    if (mine?.status !== 'done') return
    void proposalStore.settle(mine.proposalId, mine.acceptedCount > 0 ? 'acceptedPart' : 'rejected')
    setRecommend(null)
  }
  /**
   * Asks what was off (optional, bounded like the stored note), settles the shown proposal
   * regenerated with the note, and asks again for the same node with the note and the
   * proposal id, so main can build the regenerate prompt and link the rows.
   */
  const regenerate = (): void => {
    if (mine?.status !== 'done') return
    const { nodeId, proposalId } = mine
    void dialogs
      .prompt({
        title: "What's off about these?",
        message: 'Optional. Your note goes into the next request and stays with this suggestion.',
        placeholder: 'e.g. too generic, the scene is about the crossing',
        confirmLabel: 'Regenerate',
        validate: (value) =>
          value.trim().length > PROPOSAL_NOTE_MAX
            ? `Keep the note under ${PROPOSAL_NOTE_MAX} characters.`
            : null
      })
      .then((answer) => {
        if (answer === null) return
        const note = normalizeProposalNote(answer)
        void proposalStore.settle(proposalId, 'regenerated', note)
        askForTags(nodeId, { note, regeneratedFrom: proposalId })
      })
  }

  return (
    <div
      role="region"
      aria-label="Tags"
      data-testid="tag-bar"
      className={`relative flex shrink-0 flex-col border-b border-line bg-surface ${tagBar.open ? 'max-h-[60vh]' : ''}`}
      style={tagBar.open ? { height: tagBar.height } : undefined}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 py-1">
        <button
          type="button"
          aria-expanded={tagBar.open}
          aria-controls={tagBar.open ? bodyId : undefined}
          onClick={toggleTagBar}
          className={BUTTON}
        >
          {tagBar.open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className="font-medium">Tags</span>
          <span className="text-fg-subtle tabular-nums">{linked.length}</span>
        </button>
        {tagBar.open ? (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => askForTags(id)}
              disabled={!canRecommend || pending}
              title={
                canRecommend
                  ? undefined
                  : `Add at least ${TAGS_MIN_CHARS} characters to get tag suggestions`
              }
              className={BUTTON}
            >
              {pending ? (
                <Loader2 size={14} aria-hidden="true" className="animate-spin" />
              ) : (
                <Sparkles size={14} aria-hidden="true" />
              )}
              Recommend
            </button>
            <div className="relative">
              <button
                type="button"
                aria-expanded={picking}
                onClick={() => setPickingFor(picking ? null : id)}
                className={BUTTON}
              >
                <Plus size={14} aria-hidden="true" />
                Add tag
              </button>
              {picking ? (
                <TagPicker
                  excludeIds={linked}
                  onPick={(tagId) => {
                    setPickingFor(null)
                    add(id, tagId).catch(report)
                  }}
                  onClose={() => setPickingFor(null)}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {tagBar.open ? (
        <div id={bodyId} ref={panes} className="flex min-h-0 flex-1">
          {withMetadata ? (
            <div
              className="relative shrink-0 pr-3 pl-4"
              style={{ width: `${tagBar.split * 100}%` }}
            >
              <MetadataPane id={id} />
              <ResizeHandle
                side="right"
                value={tagBar.split}
                min={TAG_BAR_SPLIT_LIMITS[0]}
                max={TAG_BAR_SPLIT_LIMITS[1]}
                ariaLabel="Resize metadata pane"
                onChange={(deltaPx) =>
                  resizeTagBarSplitBy(deltaPx, panes.current?.clientWidth ?? 0)
                }
              />
            </div>
          ) : null}
          <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-2">
            {mine ? (
              <div role="group" aria-label="Tag suggestions" className="mb-2">
                {mine.status === 'pending' ? (
                  <p role="status" className="m-0 flex items-center gap-2 text-xs text-fg-muted">
                    <span>Asking for tag suggestions…</span>
                    <button
                      type="button"
                      data-testid="tag-recommend-cancel"
                      onClick={cancelRecommend}
                      className={LINK_BUTTON}
                    >
                      Cancel
                    </button>
                  </p>
                ) : null}
                {mine.status === 'error' ? (
                  <p
                    role="status"
                    data-testid="tag-recommend-result"
                    className="m-0 text-xs text-danger"
                  >
                    {mine.message} {mine.nextStep}
                  </p>
                ) : null}
                {mine.status === 'done' ? (
                  <>
                    {mine.suggestions.length === 0 ? (
                      <p
                        role="status"
                        data-testid="tag-recommend-result"
                        className="m-0 text-xs text-fg-muted"
                      >
                        No new tags fit.
                      </p>
                    ) : (
                      <ul
                        role="list"
                        aria-label="Suggested tags"
                        className="m-0 flex list-none flex-wrap gap-1.5 p-0"
                      >
                        {mine.suggestions.map((tag) => (
                          <SuggestionChip
                            key={tag.id}
                            id={tag.id}
                            onAccept={() => accept(tag.id)}
                          />
                        ))}
                      </ul>
                    )}
                    <p className="mt-1 mb-0 flex items-center gap-2 text-xs text-fg-subtle">
                      <span data-testid="tag-recommend-cost">
                        {mine.fromImport ? `${mine.model} · from import` : describeRequest(mine)}
                      </span>
                      {mine.suggestions.length > 0 ? (
                        <button type="button" onClick={acceptAll} className={LINK_BUTTON}>
                          Accept all
                        </button>
                      ) : null}
                      <button type="button" onClick={regenerate} className={LINK_BUTTON}>
                        <RefreshCw size={11} aria-hidden="true" className="mr-1 inline" />
                        Regenerate…
                      </button>
                      <button type="button" onClick={dismiss} className={LINK_BUTTON}>
                        Dismiss
                      </button>
                    </p>
                  </>
                ) : null}
              </div>
            ) : null}
            {linked.length === 0 ? (
              <p className="m-0 text-xs text-fg-muted">No tags on this document.</p>
            ) : (
              <ul
                role="list"
                aria-label="Document tags"
                className="m-0 flex list-none flex-wrap gap-1.5 p-0"
              >
                {linked.map((tagId) => (
                  <TagChip
                    key={tagId}
                    id={tagId}
                    ai={aiIds?.includes(tagId) ?? false}
                    onRemove={() => {
                      remove(id, tagId).catch(report)
                    }}
                  />
                ))}
              </ul>
            )}
            {inlineIds.length > 0 ? (
              <>
                <p className="mt-2 mb-1 text-xs text-fg-subtle">Inline tags</p>
                <ul
                  role="list"
                  aria-label="Inline tags"
                  className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0"
                >
                  {inlineIds.map((tagId) => (
                    <InlineTagRow key={tagId} id={tagId} count={inlineCounts[tagId] ?? 0} />
                  ))}
                </ul>
              </>
            ) : null}
            {mentioned.length > 0 ? (
              <>
                <p className="mt-2 mb-1 text-xs text-fg-subtle">Mentions</p>
                <ul
                  role="list"
                  aria-label="Mentions"
                  className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0"
                >
                  {mentioned.map((mention) => (
                    <MentionRow
                      key={mention.tagId}
                      id={mention.tagId}
                      nodeId={id}
                      count={mention.count}
                      // A row always carries at least one range; `[0, 0]` makes the jump search by name.
                      range={mention.ranges[0] ?? [0, 0]}
                    />
                  ))}
                </ul>
              </>
            ) : null}
            {proposed.length > 0 ? (
              <>
                <p className="mt-2 mb-1 text-xs text-fg-subtle">Proposed tags</p>
                <ul
                  role="list"
                  aria-label="Proposed tags"
                  className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0"
                >
                  {proposed.map((proposal) => (
                    <ProposedTagRow key={proposal.name} proposal={proposal} onError={report} />
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {tagBar.open ? (
        <ResizeHandle
          side="bottom"
          value={tagBar.height}
          min={TAG_BAR_MIN_HEIGHT}
          max={maxHeight}
          ariaLabel="Resize tag bar"
          ariaValue={Math.round}
          onChange={resizeTagBarBy}
        />
      ) : null}
    </div>
  )
}

/**
 * One chip: the tag's color dot and name from the bank, and its remove button. A link the
 * background job made (F-4.13) carries the "Added by AI" mark and is removed like any other.
 * Nothing if the tag is gone.
 */
function TagChip({
  id,
  ai,
  onRemove
}: {
  id: string
  ai: boolean
  onRemove: () => void
}): React.JSX.Element | null {
  const tag = useTagStore(useShallow((s) => s.byId[id]))
  if (!tag) return null
  return (
    <li
      role="listitem"
      data-ai={ai ? 'true' : undefined}
      className="flex items-center gap-1.5 rounded-full border border-line bg-surface-raised py-0.5 pr-1 pl-2 text-xs"
    >
      <span
        aria-hidden="true"
        style={{ backgroundColor: tag.color }}
        className="size-2.5 shrink-0 rounded-full"
      />
      <span className="max-w-48 truncate">{tag.name}</span>
      {ai ? (
        <span title="Added by AI" data-testid="tag-ai-mark" className="shrink-0 text-fg-subtle">
          <Sparkles size={11} aria-hidden="true" />
          <span className="sr-only">Added by AI</span>
        </span>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${tag.name}`}
        title="Remove"
        onClick={onRemove}
        className="rounded-full p-0.5 text-fg-muted hover:bg-surface hover:text-fg"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  )
}

/** One suggested tag (F-4.7): the bank's color dot and name, and an accept button. Nothing if the tag left the bank. */
function SuggestionChip({
  id,
  onAccept
}: {
  id: string
  onAccept: () => void
}): React.JSX.Element | null {
  const tag = useTagStore(useShallow((s) => s.byId[id]))
  if (!tag) return null
  return (
    <li
      role="listitem"
      className="flex items-center gap-1.5 rounded-full border border-dashed border-line py-0.5 pr-1 pl-2 text-xs"
    >
      <span
        aria-hidden="true"
        style={{ backgroundColor: tag.color }}
        className="size-2.5 shrink-0 rounded-full"
      />
      <span className="max-w-48 truncate">{tag.name}</span>
      <button
        type="button"
        aria-label={`Accept ${tag.name}`}
        title="Add to this document"
        onClick={onAccept}
        className="rounded-full p-0.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        <Plus size={12} aria-hidden="true" />
      </button>
    </li>
  )
}

/**
 * One recorded mention of the document (F-4.12): the bank's color dot and name, how often the
 * name occurs in the saved text, and a jump to the first occurrence. Nothing if the tag is gone.
 */
function MentionRow({
  id,
  nodeId,
  count,
  range
}: {
  id: string
  nodeId: string
  count: number
  range: MentionRange
}): React.JSX.Element | null {
  const tag = useTagStore(useShallow((s) => s.byId[id]))
  if (!tag) return null
  return (
    <li role="listitem" className="flex items-center gap-1.5 text-xs">
      <span
        aria-hidden="true"
        style={{ backgroundColor: tag.color }}
        className="size-2.5 shrink-0 rounded-full"
      />
      <span className="max-w-48 truncate">{tag.name}</span>{' '}
      <span className="text-fg-subtle tabular-nums">×{count}</span>
      <button
        type="button"
        aria-label={`Jump to first mention of ${tag.name}`}
        title="Jump to the first mention"
        onClick={() => void openMention(nodeId, range, tag.name)}
        className="rounded p-0.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        <CornerDownRight size={12} aria-hidden="true" />
      </button>
    </li>
  )
}

/**
 * One proposed tag (F-4.12b): a recurring capitalised name of the manuscript that no tag stands
 * for, how often it occurs, and the two clicks that settle it — Create tag makes it a character
 * tag (which is what links its mentions, F-4.12), Dismiss keeps the name quiet for the project.
 * Nothing is created or hidden until one of them is clicked; while a click is in flight both are
 * disabled, so one proposal is never settled twice.
 */
function ProposedTagRow({
  proposal,
  onError
}: {
  proposal: ProposedTag
  onError: (err: unknown) => void
}): React.JSX.Element {
  const accept = useProposedTagStore((s) => s.accept)
  const dismiss = useProposedTagStore((s) => s.dismiss)
  const [busy, setBusy] = useState(false)
  /** The row leaves the list when main publishes without it, so `busy` only has to outlive the click. */
  const settle = (work: Promise<unknown>): void => {
    setBusy(true)
    work.catch(onError).finally(() => setBusy(false))
  }
  return (
    <li
      role="listitem"
      data-testid="proposed-tag"
      className="flex items-center gap-1.5 rounded-full border border-dashed border-line py-0.5 pr-1 pl-2 text-xs"
    >
      <span className="max-w-48 truncate">{proposal.display}</span>{' '}
      <span className="text-fg-subtle tabular-nums">×{proposal.count}</span>
      <button
        type="button"
        data-testid="proposed-tag-accept"
        aria-label={`Create tag ${proposal.display}`}
        title="Create a character tag for this name"
        disabled={busy}
        onClick={() => settle(accept(proposal.name))}
        className="rounded-full p-0.5 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40"
      >
        <Plus size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="proposed-tag-dismiss"
        aria-label={`Dismiss ${proposal.display}`}
        title="Never propose this name again"
        disabled={busy}
        onClick={() => settle(dismiss(proposal.name))}
        className="rounded-full p-0.5 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  )
}

/** One inline tag of the text (F-4.6): the bank's color dot and name, and how often it occurs. Nothing if the tag is gone. */
function InlineTagRow({ id, count }: { id: string; count: number }): React.JSX.Element | null {
  const tag = useTagStore(useShallow((s) => s.byId[id]))
  if (!tag) return null
  return (
    <li role="listitem" className="flex items-center gap-1.5 text-xs">
      <span
        aria-hidden="true"
        style={{ backgroundColor: tag.color }}
        className="size-2.5 shrink-0 rounded-full"
      />
      <span className="max-w-48 truncate">{tag.name}</span>{' '}
      <span className="text-fg-subtle tabular-nums">×{count}</span>
    </li>
  )
}
