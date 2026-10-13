import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, ScanEye, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { FiledConflict } from '@shared/filing'
import { countInlineTags } from '@shared/inlineTags'
import type { NameMentionView } from '@shared/memory/nameScan'
import type { NameQuestion } from '@shared/memory/nameQuestions'
import { AUTHOR_TODO_TEXT_MAX, type AuthorTodo } from '@shared/memory/authorTodo'
import { detailFromText } from '@shared/memory/typedVsText'
import type { DetailConflictNotice, HereChip, MemoryNotice } from '@shared/memory/views'
import { formatCents } from '@renderer/features/ai/usageFormat'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { openNameMention } from '@renderer/features/editor/openPassage'
import { useSceneDetailStore } from '@renderer/features/editor/sceneDetailStore'
import { AlsoHereField, PovField } from '@renderer/features/editor/SceneDetailsFields'
import { useSceneDetailsEditor } from '@renderer/features/editor/sceneDetailsEditor'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { useLabelStore } from '@renderer/features/labels/labelStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import {
  useMemoryStore,
  useSceneMemory,
  type SceneEntry
} from '@renderer/features/memory/memoryStore'
import {
  cloudLine,
  noticeButtons,
  noticeLine,
  readAgo,
  readNowMessage,
  typedNote
} from '@renderer/features/memory/memoryView'
import { CardValueInfo } from '@renderer/features/memory/CardValue'
import { KnowsGrid } from '@renderer/features/memory/knows/KnowsGrid'
import { ThreadsList } from '@renderer/features/memory/threads/ThreadsList'
import { TimelineView } from '@renderer/features/memory/timeline/TimelineView'
import { WhoKnowsWhat } from '@renderer/features/memory/knows/WhoKnowsWhat'
import { RebuildMemory } from '@renderer/features/memory/RebuildMemory'
import { useNow } from '@renderer/features/memory/useNow'
import { openPassage } from '@renderer/features/editor/openPassage'
import { locateText } from '@renderer/features/editor/locateText'
import { AsOfPicker } from '@renderer/features/records/AsOfPicker'
import { useAsOf } from '@renderer/features/records/asOf'
import { sceneCounts, useNameMentionStore } from '@renderer/features/records/nameMentionStore'
import { openRecordSheet } from '@renderer/features/records/openRecord'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { namedInLabel } from '@renderer/features/records/recordView'
import { RenameInBook } from '@renderer/features/records/RenameInBook'
import { openResearchPage } from '@renderer/features/research/openResearch'
import { DockPanelControls, PANEL_TITLE } from '@renderer/features/shell/Dock'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useAuthorTodoStore } from './authorTodoStore'
import { useFiledConflictStore } from './filedConflictStore'
import { useDismissedStore } from './dismissedStore'
import { useQuestionStore } from './questionStore'
import { TrueNow } from './TrueNow'
import {
  ambiguousLabel,
  ambiguousWhy,
  castOf,
  conflictLine,
  detailConflictsOf,
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
 * The This scene | Book panel (F-16.12, F-16.18, answers 4 and 19; story memory v2), docked in
 * the tags panel's slot (its id stays `tags`, so a stored layout opens it where the tags were).
 * Everything in it works with Use AI off. **This scene**: *Here* (the POV, with the text's POV
 * over a typed one that differs and "you typed: Tomas" dimmed; characters on the page, each saying
 * where; *+ also here*), *Mentioned* (the local name scan's chips, each saying why it is there,
 * with *Go there* and *Not a mention*; an ambiguous span dimmed; headed *Named in this scene*
 * until the scene has a card, P2a-D21), **True now**, **Who knows what** (F-16.22: the secrets the
 * scene touches, their holders Here, the scoped "No scene shows …" lines and the tension lines, with
 * "+ N more in Book") and **Needs a look** (its reading notices and the typed-detail conflicts
 * among them). **Book**: *As of [scene ▾]*, the Cast, the who-knows-what grid, Threads, the
 * Timeline (F-16.23) and *Rebuild memory*. The footer:
 * "Read 3 min ago · Read now · today 0.3¢ · Cloud 12¢ of $1 · Dismissed (n)". `id` is the open
 * manuscript scene, or null.
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
  // F-16.22: "+ N more in Book" opens the Book tab at the who-knows-what grid.
  const [toGrid, setToGrid] = useState(false)
  const openBook = (): void => {
    setToGrid(true)
    setTab('book')
  }
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
              onClick={() => {
                setToGrid(false)
                setTab(each.id)
              }}
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
        {tab === 'scene' ? (
          <SceneTab sceneId={sceneId} onOpenBook={openBook} />
        ) : (
          <BookTab key={sceneId ?? ''} sceneId={sceneId} toGrid={toGrid} />
        )}
      </div>
      <PanelFooter sceneId={sceneId} />
    </>
  )
}

function SceneTab({
  sceneId,
  onOpenBook
}: {
  sceneId: string | null
  onOpenBook: () => void
}): React.JSX.Element {
  const memory = useSceneMemory(sceneId)
  // P2a-D21: Here and Mentioned once the scene has a card; until then the AI-off form.
  const read = memory?.card !== null && memory?.card !== undefined
  return (
    <>
      {sceneId === null ? (
        <p className="m-0 mt-3 text-sm text-fg-muted">Open a scene to see who is in it.</p>
      ) : (
        <>
          <Here key={`here:${sceneId}`} sceneId={sceneId} memory={read ? memory : undefined} />
          <NamedInScene
            key={`named:${sceneId}`}
            sceneId={sceneId}
            hereIds={read ? memory.here.map((chip) => chip.recordId) : []}
            heading={read ? 'Mentioned' : 'Named in this scene'}
          />
          {memory === undefined ? null : <TrueNow entry={memory} />}
          {memory === undefined ? null : <WhoKnowsWhat entry={memory} onOpenBook={onOpenBook} />}
        </>
      )}
      <NeedsALook sceneId={sceneId} />
      {sceneId === null ? null : <WhatTheAiIsTold key={`told:${sceneId}`} sceneId={sceneId} />}
    </>
  )
}

/** Where a Here chip comes from, as its hover says it. */
function hereWhy(chip: HereChip): string {
  const where = chip.p === null ? '' : `¶${chip.p + 1} `
  if (chip.quote === null) return chip.why === 'alsoHere' ? 'you added: also here' : 'you typed'
  return chip.why === 'pov'
    ? `the POV: ${where}“${chip.quote}”`
    : `on the page: ${where}“${chip.quote}”`
}

/**
 * *Here*: the scene's POV and the records present without being named (F-16.11's details); once
 * the scene has a card (F-16.18), the text's POV where it quotes one (decision 4: a typed POV that
 * differs shows dimmed, "you typed: Tomas") and the characters on the page, each saying where.
 * Each of those chips opens its ⓘ (the quote, *Go there*, how it was checked) with *Not right*,
 * which sends the card's value to Dismissed so the typed POV stands.
 */
function Here({ sceneId, memory }: { sceneId: string; memory?: SceneEntry }): React.JSX.Element {
  const editor = useSceneDetailsEditor(sceneId)
  const byId = useRecordStore((s) => s.byId)
  const povId = useId()
  const [openChip, setOpenChip] = useState<string | null>(null)
  const textPov = memory?.here.find((chip) => chip.why === 'pov' && chip.quote !== null)
  const onPage = memory?.here.filter((chip) => chip.why === 'onPage') ?? []
  const chipKey = (chip: HereChip): string => `${chip.why}:${chip.recordId}`
  const opened = [textPov, ...onPage].find(
    (chip) => chip !== undefined && chipKey(chip) === openChip
  )
  const openedQuote = opened?.quote ?? null
  const openedP = opened?.p ?? null
  const toggle = (chip: HereChip): void => {
    const key = chipKey(chip)
    setOpenChip((current) => (current === key ? null : key))
  }
  const chipButton = (chip: HereChip, testId?: string): React.JSX.Element => (
    <button
      key={chip.recordId}
      type="button"
      className={CHIP}
      title={hereWhy(chip)}
      aria-expanded={openChip === chipKey(chip)}
      data-testid={testId}
      onClick={() => toggle(chip)}
    >
      {byId[chip.recordId]?.name ?? 'Gone'}
    </button>
  )
  return (
    <section aria-labelledby={`${povId}-heading`}>
      <h3 id={`${povId}-heading`} className={HEADING}>
        Here
      </h3>
      <div className="flex min-w-0 items-center gap-2">
        {textPov === undefined ? (
          <>
            <label htmlFor={povId} className="w-10 shrink-0 text-xs text-fg-muted">
              POV
            </label>
            <PovField editor={editor} inputId={povId} />
          </>
        ) : (
          <>
            <span className="w-10 shrink-0 text-xs text-fg-muted">POV</span>
            {chipButton(textPov, 'here-pov')}
            {textPov.typedPov === null ? null : (
              <span className="text-xs text-fg-subtle opacity-70" data-testid="typed-pov">
                {typedNote(byId[textPov.typedPov]?.name ?? 'a record that is gone')}
              </span>
            )}
          </>
        )}
      </div>
      {onPage.length === 0 ? null : (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1" data-testid="on-page">
          <span className="w-10 shrink-0 text-xs text-fg-muted">On page</span>
          {onPage.map((chip) => chipButton(chip))}
        </div>
      )}
      {opened === undefined || openedQuote === null || openedP === null ? null : (
        <div className="mt-1">
          <CardValueInfo
            nodeId={sceneId}
            field={opened.why === 'pov' ? 'pov' : 'present'}
            value={opened.recordId}
            shown={byId[opened.recordId]?.name ?? 'Gone'}
            quote={openedQuote}
            p={openedP}
            checked="verified"
          />
        </div>
      )}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        <AlsoHereField editor={editor} />
      </div>
    </section>
  )
}

/**
 * *Mentioned* (*Named in this scene* until the scene has a card, P2a-D21): the chips of the
 * scan's mentions, with why each is there; the records Here are not repeated.
 */
function NamedInScene({
  sceneId,
  hereIds,
  heading
}: {
  sceneId: string
  hereIds: readonly string[]
  heading: string
}): React.JSX.Element {
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

  const all = namedChips(mentions ?? [], byId)
  const named = all.named.filter((chip) => !hereIds.includes(chip.recordId))
  const { ambiguous } = all
  const openNamed = named.find((chip) => chip.recordId === openKey)
  const openAmbiguous = ambiguous.find((chip) => chip.spanKey === openKey)
  const toggle = (key: string): void => setOpenKey((current) => (current === key ? null : key))

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={HEADING}>
        {heading}
      </h3>
      {named.length === 0 && ambiguous.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">
          {mentions === undefined
            ? 'Reading…'
            : all.named.length > 0
              ? 'Nobody else is named here.'
              : 'No record is named here yet.'}
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
  const conflicts = useFiledConflictStore((s) => s.conflicts)
  const notices = useMemoryStore((s) => s.notices)
  const [adding, setAdding] = useState(false)
  const groups = needsALookGroups({
    conflicts,
    todos,
    questions,
    notices: inlineTags > 0 ? [INLINE_TAGS_NOTICE] : [],
    memory: notices,
    todosOpen: adding
  })
  // F-16.9: the filed lines whose Research source changed; F-16.18: the typed details the text
  // disagrees with (decision 4).
  const badge = needsALookBadge(conflicts.length + detailConflictsOf(notices).length)
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
          {group.id === 'conflicts' ? (
            <>
              {group.details.length === 0 ? null : <DetailConflictList conflicts={group.details} />}
              {group.conflicts.length === 0 ? null : <ConflictList conflicts={group.conflicts} />}
            </>
          ) : group.id === 'todos' ? (
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
            <ul className="m-0 list-none space-y-1 p-0 text-xs" data-testid="notices">
              {group.memory.map((notice) => (
                <ReadingNotice key={notice.id} notice={notice} />
              ))}
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

/**
 * The Book tab: **As of [scene ▾]** (the open scene by default), the Cast (a view of the Characters
 * category, most-named first), **Who knows what** as of that scene (F-16.22), **Threads** as of
 * that scene and the **Timeline** with years and ages (F-16.23), and *Rebuild memory*. `toGrid`:
 * opened from "+ N more in Book", so the grid is scrolled into view.
 */
function BookTab({
  sceneId,
  toGrid
}: {
  sceneId: string | null
  toGrid: boolean
}): React.JSX.Element {
  const headingId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const records = useRecordStore(useShallow((s) => s.ids.flatMap((id) => s.byId[id] ?? [])))
  const scenes = useNameMentionStore(useShallow((s) => sceneCounts(s.namedIn)))
  const cast = castOf(records, scenes)
  const asOf = useAsOf(sceneId)
  useEffect(() => {
    if (toGrid) gridRef.current?.scrollIntoView?.({ block: 'start' })
  }, [toGrid])
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="book-as-of">
        <AsOfPicker scenes={asOf.scenes} value={asOf.asOf} onChange={asOf.setAsOf} />
      </div>
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
                  onClick={() => openRecordSheet(record.id, record.categoryId)}
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
      <div ref={gridRef}>
        <KnowsGrid asOf={asOf.asOf} />
      </div>
      <ThreadsList asOf={asOf.asOf} />
      <TimelineView />
      <RebuildMemory />
    </>
  )
}

/**
 * The footer (F-16.16, F-16.19; design §2.7): "Read 3 min ago" (the open scene's last reading),
 * *Read now* (pending saves flushed, then the scene read ahead of the queue; "Nothing new to read
 * in this scene" when the gate finds nothing), what story memory reading cost today, on Cloud
 * what background reading spent of the month's cap, and **Dismissed (n)**.
 */
function PanelFooter({ sceneId }: { sceneId: string | null }): React.JSX.Element {
  const memory = useSceneMemory(sceneId)
  const status = useMemoryStore((s) => s.status)
  const count = useDismissedStore((s) => s.items.length)
  const now = useNow()
  const [busy, setBusy] = useState(false)
  const readNow = async (): Promise<void> => {
    if (sceneId === null || busy) return
    setBusy(true)
    const result = await useMemoryStore.getState().readNow(sceneId)
    setBusy(false)
    if (result === null) return
    if (!result.ok) {
      toast.error(`${result.message} ${result.nextStep}`.trim())
      return
    }
    const message = readNowMessage(result)
    if (message !== null) toast.info(message)
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line px-3 py-1 text-xs text-fg-muted">
      {sceneId === null ? null : (
        <span data-testid="last-read">{readAgo(memory?.lastRead?.at ?? null, now)}</span>
      )}
      {sceneId === null ? null : (
        <button
          type="button"
          className={SMALL}
          disabled={busy}
          onClick={() => void readNow()}
          title="Read what changed in this scene now"
        >
          {busy ? 'Reading…' : 'Read now'}
        </button>
      )}
      <span data-testid="this-scene-spend" title="What story memory reading cost today">
        today {formatCents(status?.todayUsd ?? 0)}
      </span>
      {status?.cloud === null || status?.cloud === undefined ? null : (
        <span data-testid="cloud-spend" title="Background reading this month, of your Cloud cap">
          {cloudLine(status.cloud)}
        </span>
      )}
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

/** One reading notice (F-16.16, F-16.19): its line and its buttons. */
function ReadingNotice({ notice }: { notice: MemoryNotice }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    await action()
    setBusy(false)
  }
  return (
    <li
      className="rounded-md border border-line bg-surface px-2 py-1.5"
      data-testid="reading-notice"
    >
      <p className="m-0">{noticeLine(notice)}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {noticeButtons(notice).map((button) => (
          <button
            key={button.label}
            type="button"
            className={SMALL}
            disabled={busy}
            onClick={() => {
              if (button.kind === 'settings') {
                useShellDialogStore.getState().show('settings', 'ai')
                return
              }
              if (button.kind === 'answer') {
                void run(() => useMemoryStore.getState().answerNotice(notice.id, button.action))
              }
            }}
          >
            {button.label}
          </button>
        ))}
        <button
          type="button"
          aria-label={`Close: ${noticeLine(notice)}`}
          className={SMALL}
          disabled={busy}
          onClick={() =>
            void run(() => useMemoryStore.getState().answerNotice(notice.id, 'dismiss'))
          }
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}

/**
 * Decision 4's conflicts (F-16.18, P2a-D13): "14.2: the text says the quay; you typed the
 * harbour", with *Go there* (the quote), *Update my detail* (the text's value written into the
 * typed detail through `sceneDetail:set`) and *Keep mine* (never asked again).
 */
function DetailConflictList({
  conflicts
}: {
  conflicts: readonly DetailConflictNotice[]
}): React.JSX.Element {
  return (
    <ul className="m-0 mb-2 list-none space-y-2 p-0 text-xs" data-testid="detail-conflicts">
      {conflicts.map((conflict) => (
        <DetailConflictRow key={conflict.id} conflict={conflict} />
      ))}
    </ul>
  )
}

function DetailConflictRow({ conflict }: { conflict: DetailConflictNotice }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const goThere = (): void => {
    openPassage(conflict.nodeId, (doc) => locateText(doc, conflict.quote)).catch((err: unknown) =>
      toast.error(describeError(err))
    )
  }
  const update = async (): Promise<void> => {
    setBusy(true)
    try {
      // The text may have changed since the conflict was raised: saves land first, and the
      // conflict is asked again of main, so a value the text no longer says is never written.
      await flushPendingSaves()
      const notices = await ipc().invoke('memory:notices', undefined)
      const still = notices.some(
        (notice) =>
          notice.kind === 'detailConflict' &&
          notice.id === conflict.id &&
          notice.text === conflict.text
      )
      if (!still) {
        await useMemoryStore.getState().load()
        toast.info('The text changed since: this is looked at again once the scene is read.')
        return
      }
      const store = useSceneDetailStore.getState()
      if (store.docs[conflict.nodeId] === undefined) await store.load(conflict.nodeId)
      const current = useSceneDetailStore.getState().docs[conflict.nodeId]
      const next = current === undefined ? null : detailFromText(current, conflict)
      if (next === null) {
        toast.error('That value cannot be written into your detail; change it in scene details.')
        return
      }
      await store.save(conflict.nodeId, {
        povRecordId: next.povRecordId,
        place: next.place,
        time: next.time,
        storyYear: next.storyYear,
        alsoHere: next.alsoHere
      })
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }
  const keep = async (): Promise<void> => {
    setBusy(true)
    await useMemoryStore.getState().answerNotice(conflict.id, 'keepMine')
    setBusy(false)
  }
  return (
    <li
      className="rounded-md border border-line bg-surface px-2 py-1.5"
      data-testid="detail-conflict"
    >
      <p className="m-0">{noticeLine(conflict)}</p>
      {conflict.quote === '' ? null : (
        <p className="m-0 mt-0.5 text-fg-muted">
          <q>{conflict.quote}</q>
        </p>
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        {conflict.quote === '' ? null : (
          <button type="button" className={SMALL} onClick={goThere}>
            Go there
          </button>
        )}
        <button type="button" className={SMALL} disabled={busy} onClick={() => void update()}>
          Update my detail
        </button>
        <button type="button" className={SMALL} disabled={busy} onClick={() => void keep()}>
          Keep mine
        </button>
      </div>
    </li>
  )
}

/**
 * F-16.9: the filed lines whose Research source changed. Each says where it was filed from and
 * what the page reads now, with *Go there* (the page), *Update line* (the line beside the page's
 * closest paragraph; nothing is written until Save) and *Keep line*.
 */
function ConflictList({ conflicts }: { conflicts: readonly FiledConflict[] }): React.JSX.Element {
  return (
    <ul className="m-0 list-none space-y-2 p-0 text-xs" data-testid="filed-conflicts">
      {conflicts.map((conflict) => (
        <ConflictRow key={conflict.key} conflict={conflict} />
      ))}
    </ul>
  )
}

function ConflictRow({ conflict }: { conflict: FiledConflict }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(conflict.line)
  const [busy, setBusy] = useState(false)
  const goThere = (): void => openResearchPage(conflict.docId)
  const keep = async (): Promise<void> => {
    setBusy(true)
    await useFiledConflictStore.getState().keep(conflict)
    setBusy(false)
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (text.trim() === '') return
    setBusy(true)
    const done = await useFiledConflictStore.getState().update(conflict, text)
    setBusy(false)
    if (done) setEditing(false)
  }
  return (
    <li
      className="rounded-md border border-line bg-surface px-2 py-1.5"
      data-testid="filed-conflict"
    >
      <p className="m-0 font-medium">
        {conflict.recordName}: “{conflict.line}”
      </p>
      <p className="m-0 mt-0.5 text-fg-muted">{conflictLine(conflict)}</p>
      {editing ? (
        <form className="mt-1 flex flex-col gap-1" onSubmit={(event) => void save(event)}>
          <label className="text-fg-muted" htmlFor={`line-${conflict.key}`}>
            The line
          </label>
          <textarea
            id={`line-${conflict.key}`}
            value={text}
            rows={2}
            onChange={(event) => setText(event.target.value)}
            className="rounded border border-line bg-surface-raised px-1.5 py-1 text-sm"
          />
          {conflict.nowReads === null ? null : (
            <p className="m-0 text-fg-muted">
              The page now reads: <span className="text-fg">“{conflict.nowReads}”</span>
            </p>
          )}
          <div className="flex gap-1">
            <button type="submit" className={SMALL} disabled={busy || text.trim() === ''}>
              Save line
            </button>
            <button type="button" className={SMALL} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1">
          <button type="button" className={SMALL} onClick={goThere}>
            Go there
          </button>
          <button type="button" className={SMALL} disabled={busy} onClick={() => setEditing(true)}>
            Update line
          </button>
          <button type="button" className={SMALL} disabled={busy} onClick={() => void keep()}>
            Keep line
          </button>
        </div>
      )}
    </li>
  )
}

/**
 * F-16.14: exactly the Story notes block the v2 prose prompts send for this scene (at the
 * 400-token budget), read from main when the section opens and again when the scene's names,
 * details, labels or records change while it is open. Local; nothing is sent.
 */
function WhatTheAiIsTold({ sceneId }: { sceneId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null | undefined>(undefined)
  const mentions = useNameMentionStore((s) => s.byNode[sceneId])
  const records = useRecordStore((s) => s.byId)
  const details = useSceneDetailStore((s) => s.docs[sceneId])
  const labels = useLabelStore((s) => s.byNode[sceneId])
  const labelKinds = useLabelStore((s) => s.labels)
  useEffect(() => {
    if (!open) return
    let live = true
    const read = async (): Promise<void> => {
      const answer = await ipc().invoke('storyNotes:get', { nodeId: sceneId })
      if (live) setText(answer.text)
    }
    read().catch((err: unknown) => {
      if (live) toast.error(describeError(err))
    })
    return () => {
      live = false
    }
  }, [open, sceneId, mentions, records, details, labels, labelKinds])
  return (
    <details
      className="mt-3"
      data-testid="what-the-ai-is-told"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs font-medium tracking-wide text-fg-muted uppercase">
        What the AI is told
      </summary>
      {text === undefined ? (
        <p className="m-0 mt-1 text-xs text-fg-muted">Reading…</p>
      ) : text === null ? (
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Nothing yet: name a record, set the POV, or give the scene a tone, content or theme label.
        </p>
      ) : (
        <pre
          className="m-0 mt-1 text-xs whitespace-pre-wrap text-fg-muted"
          data-testid="story-notes-block"
        >
          {text}
        </pre>
      )}
    </details>
  )
}
