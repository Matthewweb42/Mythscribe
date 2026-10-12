import { useEffect, useId, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, ScanEye, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { countInlineTags } from '@shared/inlineTags'
import type { NameMentionView } from '@shared/memory/nameScan'
import type { NameQuestion } from '@shared/memory/nameQuestions'
import { AUTHOR_TODO_TEXT_MAX, type AuthorTodo } from '@shared/memory/authorTodo'
import { formatUsd } from '@renderer/features/ai/usageFormat'
import { useAiStore } from '@renderer/features/ai/aiStore'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { openNameMention } from '@renderer/features/editor/openPassage'
import { AlsoHereField, PovField } from '@renderer/features/editor/SceneDetailsFields'
import { useSceneDetailsEditor } from '@renderer/features/editor/sceneDetailsEditor'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { sceneCounts, useNameMentionStore } from '@renderer/features/records/nameMentionStore'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { namedInLabel } from '@renderer/features/records/recordView'
import { RenameInBook } from '@renderer/features/records/RenameInBook'
import { DockPanelControls, PANEL_TITLE } from '@renderer/features/shell/Dock'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useAuthorTodoStore } from './authorTodoStore'
import { useDismissedStore } from './dismissedStore'
import { useQuestionStore } from './questionStore'
import {
  ambiguousLabel,
  ambiguousWhy,
  castOf,
  INLINE_TAGS_NOTICE,
  namedChips,
  namedWhy,
  NEEDS_A_LOOK_HEADING,
  needsALookBadge,
  needsALookGroups,
  paragraphLabel,
  questionLine,
  type AmbiguousChip,
  type NamedChip
} from './thisSceneView'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'
const CHIP =
  'inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs hover:bg-surface-raised aria-expanded:bg-surface-raised'
const HEADING = 'm-0 mt-3 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase'
const ICON_BUTTON =
  'flex size-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-30'

const capitalize = (word: string): string => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`

type Tab = 'scene' | 'book'

/** The header's toggle for the This scene panel (story memory v2), in the tags panel's slot. */
export function ThisSceneToggleButton(): React.JSX.Element {
  const open = useLayoutStore((s) => s.layout.tags.open)
  const toggle = useLayoutStore((s) => s.toggle)
  return (
    <button
      type="button"
      aria-label="This scene"
      title="This scene"
      aria-pressed={open}
      onClick={() => toggle('tags')}
      className="rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-accent"
    >
      <ScanEye size={16} aria-hidden="true" />
    </button>
  )
}

/**
 * The This scene | Book panel (F-16.12, answers 4 and 19; story memory v2), docked in the tags
 * panel's slot (its id stays `tags`, so a stored layout opens it where the tags were). Everything
 * in it works with Use AI off. **This scene**: *Here* (the POV and *+ also here*), *Named in this
 * scene* (the local name scan's chips, each saying why it is there, with *Go there* and *Not a
 * mention*; an ambiguous span dimmed) and **Needs a look**. **Book**: the Cast. The footer: today's
 * AI spend and **Dismissed (n)**. `id` is the open manuscript scene, or null.
 */
export function ThisSceneColumn({ id }: { id: string | null }): React.JSX.Element | null {
  const open = useLayoutStore((s) => s.layout.tags.open)
  if (!open) return null
  return (
    <aside
      data-testid="this-scene-panel"
      aria-label="This scene column"
      className="flex min-h-0 flex-1 flex-col bg-panel"
    >
      <ThisScenePanel sceneId={id} />
    </aside>
  )
}

export function ThisScenePanel({ sceneId }: { sceneId: string | null }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('scene')
  const panelId = useId()
  const tabs: { id: Tab; label: string }[] = [
    { id: 'scene', label: 'This scene' },
    { id: 'book', label: 'Book' }
  ]
  return (
    <>
      <div className={PANEL_TITLE}>
        <DockPanelControls id="tags" />
        <div role="tablist" aria-label="This scene or the book" className="flex gap-1">
          {tabs.map((each) => (
            <button
              key={each.id}
              type="button"
              role="tab"
              id={`${panelId}-${each.id}`}
              aria-selected={tab === each.id}
              aria-controls={panelId}
              onClick={() => setTab(each.id)}
              className="rounded-md px-2 py-0.5 text-sm text-fg-muted hover:text-fg aria-selected:bg-surface-raised aria-selected:font-medium aria-selected:text-fg"
            >
              {each.label}
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${panelId}-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
      >
        {tab === 'scene' ? <SceneTab sceneId={sceneId} /> : <BookTab />}
      </div>
      <PanelFooter />
    </>
  )
}

function SceneTab({ sceneId }: { sceneId: string | null }): React.JSX.Element {
  return (
    <>
      {sceneId === null ? (
        <p className="m-0 mt-3 text-sm text-fg-muted">Open a scene to see who is in it.</p>
      ) : (
        <>
          <Here key={`here:${sceneId}`} sceneId={sceneId} />
          <NamedInScene key={`named:${sceneId}`} sceneId={sceneId} />
        </>
      )}
      <NeedsALook sceneId={sceneId} />
    </>
  )
}

/** *Here*: the scene's POV and the records present without being named (F-16.11's details). */
function Here({ sceneId }: { sceneId: string }): React.JSX.Element {
  const editor = useSceneDetailsEditor(sceneId)
  const povId = useId()
  return (
    <section aria-labelledby={`${povId}-heading`}>
      <h3 id={`${povId}-heading`} className={HEADING}>
        Here
      </h3>
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor={povId} className="w-10 shrink-0 text-xs text-fg-muted">
          POV
        </label>
        <PovField editor={editor} inputId={povId} />
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        <AlsoHereField editor={editor} />
      </div>
    </section>
  )
}

/** *Named in this scene*: the chips of the scan's mentions, with why each is there. */
function NamedInScene({ sceneId }: { sceneId: string }): React.JSX.Element {
  const headingId = useId()
  const mentions = useNameMentionStore((s) => s.byNode[sceneId])
  const byId = useRecordStore((s) => s.byId)
  const [openKey, setOpenKey] = useState<string | null>(null)

  useEffect(() => {
    useNameMentionStore
      .getState()
      .loadNode(sceneId)
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [sceneId])

  const { named, ambiguous } = namedChips(mentions ?? [], byId)
  const openNamed = named.find((chip) => chip.recordId === openKey)
  const openAmbiguous = ambiguous.find((chip) => chip.spanKey === openKey)
  const toggle = (key: string): void => setOpenKey((current) => (current === key ? null : key))

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={HEADING}>
        Named in this scene
      </h3>
      {named.length === 0 && ambiguous.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">
          {mentions === undefined ? 'Reading…' : 'No record is named here yet.'}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1" data-testid="named-chips">
          {named.map((chip) => (
            <button
              key={chip.recordId}
              type="button"
              aria-expanded={openKey === chip.recordId}
              title={namedWhy(chip)}
              onClick={() => toggle(chip.recordId)}
              className={CHIP}
            >
              {chip.name}
              <span className="text-fg-muted">{chip.mentions.length}</span>
            </button>
          ))}
          {ambiguous.map((chip) => (
            <button
              key={chip.spanKey}
              type="button"
              aria-expanded={openKey === chip.spanKey}
              title={ambiguousWhy(chip)}
              onClick={() => toggle(chip.spanKey)}
              className={`${CHIP} border-dashed text-fg-muted opacity-70`}
            >
              {ambiguousLabel(chip)}
            </button>
          ))}
        </div>
      )}
      {openNamed !== undefined ? (
        <NamedCard sceneId={sceneId} chip={openNamed} onGone={() => setOpenKey(null)} />
      ) : null}
      {openAmbiguous !== undefined ? (
        <AmbiguousCard sceneId={sceneId} chip={openAmbiguous} />
      ) : null}
    </section>
  )
}

/** The names a jump may find a mention by: the mention's own words, then the record's names. */
function namesOf(recordId: string): string[] {
  const record = useRecordStore.getState().byId[recordId]
  return record === undefined ? [] : record.aliases.map((alias) => alias.text)
}

function goThere(sceneId: string, mention: NameMentionView): void {
  openNameMention(
    sceneId,
    [mention.from, mention.to],
    mention.text,
    namesOf(mention.recordId)
  ).catch((err: unknown) => toast.error(describeError(err)))
}

/**
 * Why a chip is there, one line per place the scene names it, each with *Go there* and *Not a
 * mention*, and *Rename in book…* for the record.
 */
function NamedCard({
  sceneId,
  chip,
  onGone
}: {
  sceneId: string
  chip: NamedChip
  onGone: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const record = useRecordStore((s) => s.byId[chip.recordId])
  const notAMention = async (mention: NameMentionView): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const row = await ipc().invoke('names:notAMention', { mentionId: mention.id })
      useDismissedStore.getState().add(row)
      if (chip.mentions.length === 1) onGone()
      await useNameMentionStore.getState().loadNode(sceneId)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="group"
      aria-label={`Why ${chip.name} is here`}
      className="mt-2 rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
    >
      <p className="m-0 text-fg-muted">
        {chip.name}: {namedWhy(chip)}
      </p>
      <ul className="m-0 mt-1 mb-1 list-none p-0">
        {chip.mentions.map((mention) => (
          <li key={mention.id} className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate">
              {paragraphLabel(mention.para)} “{mention.text}”
            </span>
            <button type="button" className={SMALL} onClick={() => goThere(sceneId, mention)}>
              Go there
            </button>
            <button
              type="button"
              className={SMALL}
              disabled={busy}
              onClick={() => void notAMention(mention)}
            >
              Not a mention
            </button>
          </li>
        ))}
      </ul>
      {/* F-16.13: rename it from here, so the open scene changes in its editor. */}
      {record === undefined ? null : <RenameInBook record={record} busy={busy} />}
    </div>
  )
}

function AmbiguousCard({
  sceneId,
  chip
}: {
  sceneId: string
  chip: AmbiguousChip
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={`Why “${chip.text}” is dimmed`}
      className="mt-2 flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
    >
      <span className="min-w-0 flex-1 text-fg-muted">{ambiguousWhy(chip)}</span>
      <button type="button" className={SMALL} onClick={() => goThere(sceneId, chip.mention)}>
        Go there
      </button>
    </div>
  )
}

/** Needs a look: quiet and never required; its badge counts conflicts only. */
function NeedsALook({ sceneId }: { sceneId: string | null }): React.JSX.Element {
  const headingId = useId()
  const todos = useAuthorTodoStore((s) => s.todos)
  const questions = useQuestionStore((s) => s.questions)
  const inlineTags = useDocumentStore((s) => {
    const content = sceneId === null ? null : s.docs[sceneId]?.content
    return content === null || content === undefined
      ? 0
      : Object.keys(countInlineTags(content)).length
  })
  const [adding, setAdding] = useState(false)
  const groups = needsALookGroups({
    todos,
    questions,
    notices: inlineTags > 0 ? [INLINE_TAGS_NOTICE] : [],
    todosOpen: adding
  })
  // P1 has no conflicts yet: slice 5's filed-line checks are the first.
  const badge = needsALookBadge(0)
  return (
    <section aria-labelledby={headingId}>
      <div className="mt-3 mb-1 flex items-center gap-2">
        <h3
          id={headingId}
          className="m-0 text-xs font-medium tracking-wide text-fg-muted uppercase"
        >
          Needs a look
        </h3>
        {badge === null ? null : (
          <span
            data-testid="needs-a-look-badge"
            className="rounded-full bg-accent px-1.5 text-[10px] text-accent-fg"
          >
            {badge}
          </span>
        )}
        <button
          type="button"
          className={`${SMALL} ml-auto`}
          aria-label="Add a to-do"
          onClick={() => setAdding(true)}
        >
          + To-do
        </button>
      </div>
      {groups.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">Nothing needs a look.</p>
      ) : null}
      {groups.map((group) => (
        <div
          key={group.id}
          role="group"
          aria-label={NEEDS_A_LOOK_HEADING[group.id]}
          className="mt-2"
        >
          <h4 className="m-0 mb-1 text-xs text-fg-muted">{NEEDS_A_LOOK_HEADING[group.id]}</h4>
          {group.id === 'todos' ? (
            <TodoList
              todos={group.todos}
              done={group.done}
              sceneId={sceneId}
              adding={adding}
              onDoneAdding={() => setAdding(false)}
            />
          ) : group.id === 'questions' ? (
            <QuestionList questions={group.questions} />
          ) : (
            <ul className="m-0 list-none p-0 text-xs">
              {group.notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  )
}

/** One to-do's line: its tick, its words and links, and (open ones) its move buttons. */
function TodoRow({
  todo,
  index,
  count
}: {
  todo: AuthorTodo
  /** Its place among the open to-dos, for the move buttons; null for a done one. */
  index: number | null
  count: number
}): React.JSX.Element {
  const store = useAuthorTodoStore.getState
  const scene = useTreeStore((s) =>
    todo.nodeId === null ? null : (s.byId[todo.nodeId]?.title ?? null)
  )
  const record = useRecordStore((s) =>
    todo.recordId === null ? null : (s.byId[todo.recordId]?.name ?? null)
  )
  const links = [scene, record].filter((link): link is string => link !== null)
  return (
    <li className="flex min-w-0 items-center gap-1 py-0.5 text-sm">
      <input
        type="checkbox"
        aria-label={`Done: ${todo.text}`}
        checked={todo.done}
        onChange={(event) => void store().update(todo.id, { done: event.target.checked })}
      />
      <span className={`min-w-0 flex-1 ${todo.done ? 'text-fg-muted line-through' : ''}`}>
        {todo.text}
        {links.length === 0 ? null : (
          <span className="ml-1 text-[11px] text-fg-subtle">{links.join(' · ')}</span>
        )}
      </span>
      {index === null ? null : (
        <>
          <button
            type="button"
            aria-label={`Move up: ${todo.text}`}
            disabled={index === 0}
            onClick={() => void store().move(todo.id, -1)}
            className={ICON_BUTTON}
          >
            <ArrowUp size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Move down: ${todo.text}`}
            disabled={index === count - 1}
            onClick={() => void store().move(todo.id, 1)}
            className={ICON_BUTTON}
          >
            <ArrowDown size={12} aria-hidden="true" />
          </button>
        </>
      )}
      <button
        type="button"
        aria-label={`Delete to-do: ${todo.text}`}
        onClick={() => void store().remove(todo.id)}
        className={ICON_BUTTON}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  )
}

/**
 * My to-dos: add, tick, delete and reorder; a to-do may point at this scene, a record, or both.
 * Ticked ones wait behind a collapsed "n done" line, so the list never needs clearing.
 */
function TodoList({
  todos,
  done,
  sceneId,
  adding,
  onDoneAdding
}: {
  todos: AuthorTodo[]
  done: AuthorTodo[]
  sceneId: string | null
  adding: boolean
  onDoneAdding: () => void
}): React.JSX.Element {
  const store = useAuthorTodoStore.getState
  const records = useRecordStore((s) => s.byId)
  const [text, setText] = useState('')
  const [here, setHere] = useState(true)
  const [recordId, setRecordId] = useState('')
  const choices = Object.values(records).sort((a, b) => a.name.localeCompare(b.name))

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const trimmed = text.trim()
    if (trimmed === '') return
    void store()
      .create({
        text: trimmed,
        nodeId: here && sceneId !== null ? sceneId : null,
        recordId: recordId === '' || records[recordId] === undefined ? null : recordId
      })
      .then((made) => {
        if (!made) return
        setText('')
        setRecordId('')
        onDoneAdding()
      })
  }

  return (
    <>
      <ul className="m-0 list-none p-0">
        {todos.map((todo, index) => (
          <TodoRow key={todo.id} todo={todo} index={index} count={todos.length} />
        ))}
      </ul>
      {done.length === 0 ? null : (
        <details className="mt-1 text-xs text-fg-muted">
          <summary className="cursor-pointer">{done.length} done</summary>
          <ul className="m-0 list-none p-0">
            {done.map((todo) => (
              <TodoRow key={todo.id} todo={todo} index={null} count={done.length} />
            ))}
          </ul>
        </details>
      )}
      {adding ? (
        <form onSubmit={submit} className="mt-1 flex flex-col gap-1">
          <input
            aria-label="New to-do"
            autoFocus
            value={text}
            maxLength={AUTHOR_TODO_TEXT_MAX}
            placeholder="Check the tide tables"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onDoneAdding()
            }}
            className="w-full rounded-md border border-line bg-bg px-2 py-1 text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            {sceneId === null ? null : (
              <label className="flex items-center gap-1 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked={here}
                  onChange={(event) => setHere(event.target.checked)}
                />
                For this scene
              </label>
            )}
            {choices.length === 0 ? null : (
              <select
                aria-label="About a record"
                value={recordId}
                onChange={(event) => setRecordId(event.target.value)}
                className="min-w-0 rounded-md border border-line bg-bg px-1 py-0.5 text-xs"
              >
                <option value="">About no record</option>
                {choices.map((record) => (
                  <option key={record.id} value={record.id}>
                    About {record.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className={`${SMALL} ml-auto`} onClick={onDoneAdding}>
              Cancel
            </button>
            <button type="submit" className={SMALL} disabled={text.trim() === ''}>
              Add
            </button>
          </div>
        </form>
      ) : null}
    </>
  )
}

/** The name questions: *Add as* a category · *Not a name*, or *Yes* · *No* for a nickname. */
function QuestionList({ questions }: { questions: NameQuestion[] }): React.JSX.Element {
  const categories = useCategoryStore((s) => s.categories)
  const answer = useQuestionStore((s) => s.answer)
  return (
    <ul className="m-0 list-none p-0">
      {questions.map((question) => (
        <li
          key={`${question.kind}:${question.norm}:${question.recordId ?? ''}`}
          className="flex min-w-0 flex-wrap items-center gap-1 py-0.5 text-sm"
        >
          <span className="min-w-0 flex-1">{questionLine(question)}</span>
          {question.kind === 'newName' ? (
            <>
              <select
                aria-label={`Add ${question.name} as`}
                value=""
                onChange={(event) => {
                  const categoryId = event.target.value
                  if (categoryId === '') return
                  void answer({ kind: 'addAs', name: question.name, categoryId })
                }}
                className="rounded-md border border-line bg-bg px-1 py-px text-xs leading-5"
              >
                <option value="">Add as…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {capitalize(category.noun)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={SMALL}
                onClick={() => void answer({ kind: 'notAName', name: question.name })}
              >
                Not a name
              </button>
            </>
          ) : question.recordId === null ? null : (
            <>
              <button
                type="button"
                className={SMALL}
                onClick={() =>
                  void answer({
                    kind: 'yes',
                    name: question.name,
                    recordId: question.recordId ?? ''
                  })
                }
              >
                Yes
              </button>
              <button
                type="button"
                className={SMALL}
                onClick={() =>
                  void answer({
                    kind: 'no',
                    name: question.name,
                    recordId: question.recordId ?? ''
                  })
                }
              >
                No
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The Book tab: the Cast, a view of the Characters category, most-named first. */
function BookTab(): React.JSX.Element {
  const headingId = useId()
  const records = useRecordStore(useShallow((s) => s.ids.flatMap((id) => s.byId[id] ?? [])))
  const scenes = useNameMentionStore(useShallow((s) => sceneCounts(s.namedIn)))
  const cast = castOf(records, scenes)
  const open = (recordId: string, categoryId: string): void => {
    useRecordStore.getState().select(recordId)
    const layout = useLayoutStore.getState()
    layout.setSidebarTab(categoryId)
    if (!layout.layout.sidebar.open) layout.toggle('sidebar')
  }
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={HEADING}>
        Cast
      </h3>
      {cast.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No characters yet.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {cast.map((record) => (
            <li key={record.id}>
              <button
                type="button"
                onClick={() => open(record.id, record.categoryId)}
                className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-surface-raised"
              >
                <span className="min-w-0 flex-1 truncate">{record.name}</span>
                <span className="shrink-0 text-[11px] text-fg-subtle">
                  {namedInLabel(scenes[record.id] ?? 0)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Today's AI spend and **Dismissed (n)**. *Read now* and the last-read time arrive with P2a's reader. */
function PanelFooter(): React.JSX.Element {
  const today = useAiStore((s) => s.usage?.today.costUsd ?? null)
  const count = useDismissedStore((s) => s.items.length)
  useEffect(() => {
    // The figure is a courtesy: when the ledger cannot be read it shows a dash, never an error.
    useAiStore
      .getState()
      .loadUsage()
      .catch(() => undefined)
  }, [])
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1 text-xs text-fg-muted">
      <span data-testid="this-scene-spend" title="What AI cost today">
        {today === null ? 'Today —' : `Today ${formatUsd(today)}`}
      </span>
      <button
        type="button"
        className={`${SMALL} ml-auto`}
        onClick={() => useDismissedStore.getState().setOpen(true)}
      >
        Dismissed ({count})
      </button>
    </div>
  )
}
