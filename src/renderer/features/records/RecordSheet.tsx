import { useId, useMemo, useState } from 'react'
import { ImagePlus, Trash2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { entityImageUrl } from '@shared/entities'
import { KNOWER_KINDS } from '@shared/memory/knows'
import { isTopicKind } from '@shared/memory/topics'
import {
  CASE_RULES,
  RECORD_ALIAS_MAX,
  RECORD_NAME_MAX,
  type CaseRule,
  type RecordAlias,
  type StoryRecordSummary
} from '@shared/memory/records'
import { openNameMention } from '@renderer/features/editor/openPassage'
import { useCategory, useCategoryStore } from '@renderer/features/entities/categoryStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { listOutline } from '@renderer/features/outline/outlineRows'
import { pageKey, usePageStore } from '@renderer/features/research/pageStore'
import { PageEditor } from '@renderer/features/research/PageEditor'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useAssistantName } from '@renderer/features/shell/viewStore'
import { describeError } from '@renderer/lib/errors'
import { namedInOf, useNameMentionStore } from './nameMentionStore'
import { useRecordStore, type AliasesInput } from './recordStore'
import { FromTheBook } from './FromTheBook'
import { KnowsSection } from './KnowsSection'
import { AgeSection } from './AgeSection'
import { ThreadsSection } from './ThreadsSection'
import { TopicSection } from './TopicSection'
import { RenameInBook } from './RenameInBook'
import {
  aliasesInputOf,
  CASE_RULE_HINT,
  CASE_RULE_LABEL,
  holdersOf,
  mergePreview,
  mergeSummary,
  nicknamesOf,
  sharedWith,
  sharingInput
} from './recordView'

const BUTTON =
  'rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent'
const SELECT = 'rounded-md border border-line bg-bg px-1 py-0.5 text-xs'
const HEADING = 'm-0 text-xs font-semibold tracking-wide text-fg-muted uppercase'

/**
 * A record's sheet (F-16.6, story memory v2; answer 7): one view, no Structured/Blank pair, no
 * sync. Its name and nicknames (each with its case rule, *Shared* and remove, which goes to
 * Dismissed; a nickname another record already has is offered as shared with it), *Same as…*
 * (merge another record into this one, with a preview of what moves) and *Split* (move nicknames
 * to a new record), its image and category, **Pinned** (the author's own lines, canon) and
 * **Ideas** (read by the assistant, never treated as true) as pages, and *Named in* (the scenes
 * that name it, from the local name scan; a click selects the first mention). *Rename in book…*
 * (F-16.13) renames one of its names everywhere the manuscript writes it, with one Undo.
 * **From the book, as of [scene]** (F-16.18) shows what the prose states, each line with ⓘ and
 * *Not right*. F-16.22: a character's or group's **Knows, as of [scene]**; a secret's sheet has
 * **The secret** in place of From the book, and a secret's or thread's sheet keeps its one label
 * (no nicknames, Named in, Rename in book or nickname Split; *Same as…* only with its own kind).
 * F-16.23: a character's **Age, as of [scene]**, a named record's **Threads, as of [scene]** (the
 * steps naming it), and a thread's **The thread** in place of From the book. Relationships arrive
 * with their phase.
 */
export function RecordSheet({ id }: { id: string }): React.JSX.Element | null {
  const record = useRecordStore((s) => s.byId[id])
  if (record === undefined) return null
  return <Sheet record={record} />
}

function Sheet({ record }: { record: StoryRecordSummary }): React.JSX.Element {
  const assistant = useAssistantName()
  // P2b-D1, D2: a secret or thread is a topic, not a name: one label, a fixed category, no
  // nicknames, no Rename in book and no nickname Split (it splits by reveal in its own section).
  const topic = isTopicKind(record.kind)
  const category = useCategory(record.categoryId)
  const categories = useCategoryStore((s) => s.categories)
  const [busy, setBusy] = useState(false)

  /** Runs one change; a refusal is toasted. Answers whether it went through. */
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    try {
      await action()
      return true
    } catch (err) {
      toast.error(describeError(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveNames = (change: (input: AliasesInput) => AliasesInput): Promise<boolean> =>
    run(async () => {
      await useRecordStore.getState().setAliases(record.id, change(aliasesInputOf(record)))
    })

  const onDelete = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete "${record.name}"?`,
      message: `This removes the ${category.noun}, its names, Pinned and Ideas. The book keeps its text. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    // Its pages are written first, so closing the sheet has nothing left to save to a gone record.
    await run(async () => {
      await usePageStore.getState().flush()
      await useRecordStore.getState().remove(record.id)
    })
  }

  return (
    <div
      data-testid="record-sheet"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-5">
        <header className="flex items-start gap-3">
          <RecordImage record={record} busy={busy} run={run} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <NameInput
              key={record.name}
              value={record.name}
              label="Name"
              maxLength={RECORD_NAME_MAX}
              className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xl font-semibold hover:border-line focus:border-line"
              onCommit={(text) =>
                saveNames((input) => ({ ...input, name: { ...input.name, text } }))
              }
            />
            {topic ? (
              // A topic's category is fixed, and a secret's is in no picker (`SECRET_CATEGORY`):
              // a select would show the first option in its place.
              <p data-testid="record-category" className="m-0 text-xs text-fg-muted">
                Category: {category.name}
              </p>
            ) : (
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                Category
                <select
                  aria-label="Category"
                  value={record.categoryId}
                  disabled={busy}
                  onChange={(event) =>
                    void run(async () => {
                      await useRecordStore
                        .getState()
                        .update(record.id, { categoryId: event.target.value })
                    })
                  }
                  className={SELECT}
                >
                  {categories.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <button
            type="button"
            aria-label={`Delete ${record.name}`}
            title={`Delete this ${category.noun}`}
            onClick={() => void onDelete()}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-raised hover:text-fg"
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </header>

        {topic ? null : <Names record={record} busy={busy} run={run} saveNames={saveNames} />}
        <SameAsAndSplit record={record} busy={busy} run={run} />
        {topic ? null : <RenameInBook record={record} busy={busy} />}

        <section aria-label="Pinned" className="flex flex-col gap-1">
          <h3 className={HEADING}>Pinned</h3>
          <p className="m-0 text-xs text-fg-muted">
            Your own lines about {record.name}. Read as true unless you mark a line Not canon.
          </p>
          <div className="rounded-md border border-line">
            <PageEditor
              owner={{ kind: 'pinned', id: record.id }}
              label="Pinned"
              placeholder="Eyes: grey. Born in the harbour town…"
              inline
            />
          </div>
        </section>

        <section aria-label="Ideas" className="flex flex-col gap-1">
          <h3 className={HEADING}>Ideas</h3>
          <p className="m-0 text-xs text-fg-muted">
            {assistant} reads these but never treats them as true.
          </p>
          <div className="rounded-md border border-line">
            <PageEditor
              owner={{ kind: 'ideas', id: record.id }}
              label="Ideas"
              placeholder="Maybe she was a smuggler once…"
              inline
              notCanonToggle={false}
            />
          </div>
        </section>

        {/* F-16.18: what the prose states, as of a scene; F-16.22, F-16.23: a topic's own section. */}
        {isTopicKind(record.kind) ? (
          <TopicSection recordId={record.id} kind={record.kind} />
        ) : (
          <FromTheBook recordId={record.id} />
        )}
        {/* F-16.23: a character's age, as of a scene. */}
        {record.kind === 'character' ? <AgeSection recordId={record.id} /> : null}
        {/* F-16.22: what a character or group knows, as of a scene. */}
        {KNOWER_KINDS.includes(record.kind) ? <KnowsSection recordId={record.id} /> : null}
        {/* F-16.23: the thread steps that name it, as of a scene. */}
        {topic ? null : <ThreadsSection recordId={record.id} />}

        {topic ? null : <NamedIn record={record} />}
      </div>
    </div>
  )
}

/** The image: a thumb with Change and Remove, or Add image. */
function RecordImage({
  record,
  busy,
  run
}: {
  record: StoryRecordSummary
  busy: boolean
  run: (action: () => Promise<void>) => Promise<boolean>
}): React.JSX.Element {
  const update = (image: 'choose' | 'remove'): void =>
    void run(async () => {
      await useRecordStore.getState().update(record.id, { image })
    })
  if (record.image === null) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => update('choose')}
        title="Add an image"
        aria-label="Add image"
        className="flex size-16 shrink-0 items-center justify-center rounded-md border border-dashed border-line text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        <ImagePlus size={18} aria-hidden="true" />
      </button>
    )
  }
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <img
        src={entityImageUrl(record.image)}
        alt={record.name}
        className="size-16 rounded-md object-cover"
      />
      <div className="flex gap-1">
        <button type="button" disabled={busy} onClick={() => update('choose')} className={BUTTON}>
          Change
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => update('remove')}
          aria-label="Remove image"
          className={BUTTON}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

/**
 * A text field that saves on Enter or when it loses focus, only when the trimmed text changed. A
 * save main refuses puts the saved name back, so the field never shows a name the record lacks.
 */
function NameInput({
  value,
  label,
  maxLength,
  className,
  onCommit
}: {
  value: string
  label: string
  maxLength: number
  className: string
  onCommit: (text: string) => Promise<boolean>
}): React.JSX.Element {
  const [text, setText] = useState(value)
  const commit = (): void => {
    const next = text.trim()
    if (next === '' || next === value) {
      setText(value)
      return
    }
    void onCommit(next).then((saved) => {
      if (!saved) setText(value)
    })
  }
  return (
    <input
      aria-label={label}
      value={text}
      maxLength={maxLength}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          setText(value)
        }
      }}
      className={className}
    />
  )
}

/** The case-rule choice of one name. */
function CaseRuleSelect({
  entry,
  disabled,
  onChange
}: {
  entry: RecordAlias
  disabled: boolean
  onChange: (rule: CaseRule) => void
}): React.JSX.Element {
  return (
    <select
      aria-label={`Case for ${entry.text}`}
      title={CASE_RULE_HINT[entry.caseRule]}
      value={entry.caseRule}
      disabled={disabled}
      onChange={(event) => {
        const rule = CASE_RULES.find((option) => option === event.target.value)
        if (rule !== undefined) onChange(rule)
      }}
      className={SELECT}
    >
      {CASE_RULES.map((rule) => (
        <option key={rule} value={rule}>
          {CASE_RULE_LABEL[rule]}
        </option>
      ))}
    </select>
  )
}

/**
 * The record's own name's case rule, its nicknames as chips, and the field that adds one. A
 * nickname another record already answers to (a surname) is offered as shared (identity rule 4):
 * on Share, the other record's name is marked shared first, then this one's is added shared.
 */
function Names({
  record,
  busy,
  run,
  saveNames
}: {
  record: StoryRecordSummary
  busy: boolean
  run: (action: () => Promise<void>) => Promise<boolean>
  saveNames: (change: (input: AliasesInput) => AliasesInput) => Promise<boolean>
}): React.JSX.Element {
  const all = useRecordStore(useShallow((s) => s.ids.flatMap((id) => s.byId[id] ?? [])))
  const [adding, setAdding] = useState('')
  const main = record.aliases.find((entry) => entry.isMain)
  const nicknames = nicknamesOf(record)
  const at = (entry: RecordAlias): number => nicknames.indexOf(entry)

  const patchNickname = (
    entry: RecordAlias,
    patch: Partial<AliasesInput['aliases'][number]>
  ): Promise<boolean> =>
    saveNames((input) => ({
      ...input,
      aliases: input.aliases.map((each, index) =>
        index === at(entry) ? { ...each, ...patch } : each
      )
    }))

  const add = async (): Promise<void> => {
    const text = adding.trim()
    if (text === '') return
    const holders = holdersOf(text, all, record.id)
    if (holders.length > 0) {
      const owners = holders.map((holder) => holder.record.name).join(', ')
      const ok = await dialogs.confirm({
        title: `Share “${text}”?`,
        message: `“${text}” is already a name of ${owners}. Shared, both answer to it, and the scene around it decides who is meant.`,
        confirmLabel: 'Share'
      })
      if (!ok) return
    }
    // The typed nickname stays in the field when main refuses it.
    const saved = await run(async () => {
      const store = useRecordStore.getState()
      for (const { record: other, entry } of holders) {
        if (!entry.shared) await store.setAliases(other.id, sharingInput(other, entry.norm))
      }
      const input = aliasesInputOf(record)
      await store.setAliases(record.id, {
        ...input,
        aliases: [...input.aliases, { text, shared: holders.length > 0 }]
      })
    })
    if (saved) setAdding('')
  }

  return (
    <section aria-label="Names" className="flex flex-col gap-2">
      <h3 className={HEADING}>Names</h3>
      {main !== undefined ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{main.text}</span>
          <CaseRuleSelect
            entry={main}
            disabled={busy}
            onChange={(caseRule) =>
              void saveNames((input) => ({ ...input, name: { ...input.name, caseRule } }))
            }
          />
        </div>
      ) : null}
      {nicknames.length > 0 ? (
        <ul aria-label="Nicknames" className="m-0 flex list-none flex-col gap-1 p-0">
          {nicknames.map((entry) => {
            const others = entry.shared ? sharedWith(entry, all) : []
            return (
              <li
                key={entry.id}
                aria-label={entry.text}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2 py-1 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{entry.text}</span>
                <CaseRuleSelect
                  entry={entry}
                  disabled={busy}
                  onChange={(caseRule) => void patchNickname(entry, { caseRule })}
                />
                <label
                  className="flex items-center gap-1 text-xs text-fg-muted"
                  title="A name several records answer to (a surname, a title); the scene around it decides who is meant"
                >
                  <input
                    type="checkbox"
                    checked={entry.shared}
                    disabled={busy}
                    onChange={(event) =>
                      void patchNickname(entry, { shared: event.target.checked })
                    }
                  />
                  Shared
                  {others.length > 0 ? ` with ${others.map((other) => other.name).join(', ')}` : ''}
                </label>
                <button
                  type="button"
                  aria-label={`Remove ${entry.text}`}
                  title="Remove this name (it goes to Dismissed, where Undo brings it back)"
                  disabled={busy}
                  onClick={() =>
                    void saveNames((input) => ({
                      ...input,
                      aliases: input.aliases.filter((_, index) => index !== at(entry))
                    }))
                  }
                  className="flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-surface-raised hover:text-fg"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <input
          aria-label="New nickname"
          placeholder="Add a nickname"
          value={adding}
          maxLength={RECORD_ALIAS_MAX}
          onChange={(event) => setAdding(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm"
        />
        <button type="submit" disabled={busy || adding.trim() === ''} className={BUTTON}>
          Add
        </button>
      </form>
    </section>
  )
}

/** *Same as…* (merge another record into this one) and *Split* (nicknames to a new record). */
function SameAsAndSplit({
  record,
  busy,
  run
}: {
  record: StoryRecordSummary
  busy: boolean
  run: (action: () => Promise<void>) => Promise<boolean>
}): React.JSX.Element {
  const [open, setOpen] = useState<'sameAs' | 'split' | null>(null)
  const [mergeId, setMergeId] = useState('')
  const [splitting, setSplitting] = useState<string[]>([])
  const pickId = useId()
  // P2b: two secrets, or two threads, merge; a topic never merges with a named record.
  const others = useRecordStore(
    useShallow((s) =>
      s.ids.flatMap((id) => {
        const other = id === record.id ? undefined : s.byId[id]
        if (other === undefined) return []
        const sameFamily = isTopicKind(record.kind)
          ? other.kind === record.kind
          : !isTopicKind(other.kind)
        return sameFamily ? [other] : []
      })
    )
  )
  const namedIn = useNameMentionStore((s) => s.namedIn)
  const merging = others.find((other) => other.id === mergeId)
  const nicknames = nicknamesOf(record)
  const topic = isTopicKind(record.kind)

  const merge = (): Promise<boolean> =>
    run(async () => {
      if (merging === undefined) return
      // The merge appends the pages main holds, so the open ones are written first, and read
      // again after, since they now hold the merged record's lines too.
      const pages = usePageStore.getState()
      await pages.flush()
      await useRecordStore.getState().sameAs(record.id, merging.id)
      await pages.reload([
        pageKey({ kind: 'pinned', id: record.id }),
        pageKey({ kind: 'ideas', id: record.id })
      ])
      toast.success(`${merging.name} is now part of ${record.name}`)
      setOpen(null)
      setMergeId('')
    })

  const split = (): Promise<boolean> =>
    run(async () => {
      if (splitting.length === 0) return
      const { into } = await useRecordStore.getState().split(record.id, splitting, null)
      toast.success(`${into.name} is a record of its own`)
      setOpen(null)
      setSplitting([])
    })

  return (
    <section aria-label="Same as and Split" className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          aria-expanded={open === 'sameAs'}
          disabled={busy || others.length === 0}
          onClick={() => setOpen(open === 'sameAs' ? null : 'sameAs')}
          className={BUTTON}
        >
          Same as…
        </button>
        {topic ? null : (
          <button
            type="button"
            aria-expanded={open === 'split'}
            disabled={busy || nicknames.length === 0}
            onClick={() => setOpen(open === 'split' ? null : 'split')}
            className={BUTTON}
          >
            Split…
          </button>
        )}
      </div>
      {open === 'sameAs' ? (
        <div className="flex flex-col gap-2 rounded-md border border-line p-2 text-sm">
          <label htmlFor={pickId} className="text-xs text-fg-muted">
            Which record is the same as {record.name}?
          </label>
          <select
            id={pickId}
            value={mergeId}
            onChange={(event) => setMergeId(event.target.value)}
            className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
          >
            <option value="">Pick a record</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </select>
          {merging !== undefined ? (
            <p className="m-0 text-xs text-fg-muted">
              {mergeSummary(record, merging, mergePreview(record, merging, namedIn))}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || merging === undefined}
              onClick={() => void merge()}
              className={BUTTON}
            >
              Merge into {record.name}
            </button>
            <button type="button" onClick={() => setOpen(null)} className={BUTTON}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {open === 'split' ? (
        <fieldset className="m-0 flex flex-col gap-1 rounded-md border border-line p-2 text-sm">
          <legend className="px-1 text-xs text-fg-muted">
            Which names belong to someone else? They become a record of their own.
          </legend>
          {nicknames.map((entry) => (
            <label key={entry.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={splitting.includes(entry.id)}
                onChange={(event) =>
                  setSplitting(
                    event.target.checked
                      ? [...splitting, entry.id]
                      : splitting.filter((each) => each !== entry.id)
                  )
                }
              />
              {entry.text}
            </label>
          ))}
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              disabled={busy || splitting.length === 0}
              onClick={() => void split()}
              className={BUTTON}
            >
              Split into a new record
            </button>
            <button type="button" onClick={() => setOpen(null)} className={BUTTON}>
              Cancel
            </button>
          </div>
        </fieldset>
      ) : null}
    </section>
  )
}

/** The scenes that name the record, in reading order, each with its count; a click jumps there. */
function NamedIn({ record }: { record: StoryRecordSummary }): React.JSX.Element {
  const namedIn = useNameMentionStore((s) => s.namedIn)
  const rootIds = useTreeStore((s) => s.rootIds)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const sectionOf = useTreeStore((s) => s.sectionOf)
  const byId = useTreeStore((s) => s.byId)
  const rows = useMemo(() => {
    const counts = new Map(namedInOf(namedIn, record.id).map((row) => [row.nodeId, row.count]))
    return listOutline(rootIds, childrenOf, sectionOf).flatMap(({ id }) => {
      const count = counts.get(id)
      const node = byId[id]
      return count === undefined || node === undefined ? [] : [{ id, title: node.title, count }]
    })
  }, [namedIn, record.id, rootIds, childrenOf, sectionOf, byId])

  const jump = async (nodeId: string): Promise<void> => {
    const mentions = await useNameMentionStore.getState().loadNode(nodeId)
    const first = mentions.find((mention) => mention.recordId === record.id && !mention.ambiguous)
    const names = record.aliases.map((entry) => entry.text)
    if (first === undefined) {
      useTreeStore.getState().select(nodeId)
      return
    }
    await openNameMention(nodeId, [first.from, first.to], first.text, names)
  }

  return (
    <section aria-label="Named in" className="flex flex-col gap-1">
      <h3 className={HEADING}>Named in</h3>
      {rows.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No scene names {record.name} yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() =>
                  void jump(row.id).catch((err: unknown) => toast.error(describeError(err)))
                }
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-raised"
              >
                <span className="min-w-0 flex-1 truncate">{row.title}</span>
                <span className="shrink-0 text-xs text-fg-muted">×{row.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
