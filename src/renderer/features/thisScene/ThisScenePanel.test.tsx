import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { AuthorTodo } from '@shared/memory/authorTodo'
import type { Dismissed } from '@shared/memory/dismissed'
import type { FiledConflict } from '@shared/filing'
import type { NameQuestion } from '@shared/memory/nameQuestions'
import type { MemoryNotice, SceneMemory } from '@shared/memory/views'
import type { NamedInRow, NameMentionView } from '@shared/memory/nameScan'
import { emptySceneDetails } from '@shared/memory/sceneDetails'
import { defaultAiSettings } from '@shared/aiSettings'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetAiStore } from '@renderer/features/ai/aiStore'
import { resetDocumentStore, useDocumentStore } from '@renderer/features/editor/documentStore'
import { resetSceneDetailStore } from '@renderer/features/editor/sceneDetailStore'
import { resetCategoryStore } from '@renderer/features/entities/categoryStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import {
  resetNameMentionStore,
  useNameMentionStore
} from '@renderer/features/records/nameMentionStore'
import {
  findingSideFixture,
  findingsViewFixture,
  findingViewFixture,
  knowsCellFixture,
  knowsGridFixture,
  looseEndFixture,
  looseEndsFixture,
  memoryStatusFixture,
  noteFindingFixture,
  sceneMemoryFixture,
  secretViewFixture,
  suggestionViewFixture,
  threadsMemoryFixture,
  threadViewFixture,
  timelineFixture,
  timelineRowFixture
} from '@renderer/features/memory/memoryFixture'
import { resetMemoryStore, useMemoryStore } from '@renderer/features/memory/memoryStore'
import { recordFixture } from '@renderer/features/records/recordFixture'
import { resetRecordStore, useRecordStore } from '@renderer/features/records/recordStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { resetAuthorTodoStore, useAuthorTodoStore } from './authorTodoStore'
import { DismissedDialog } from './DismissedDialog'
import { resetDismissedStore, useDismissedStore } from './dismissedStore'
import { resetQuestionStore, useQuestionStore } from './questionStore'
import { resetFiledConflictStore, useFiledConflictStore } from './filedConflictStore'
import { ThisScenePanel } from './ThisScenePanel'
import {
  INLINE_TAGS_NOTICE,
  ambiguousLabel,
  castOf,
  conflictCount,
  conflictLine,
  dismissedRow,
  namedChips,
  namedWhy,
  needsALookBadge,
  needsALookGroups,
  questionLine
} from './thisSceneView'

/**
 * F-16.12, F-16.10 (plan P1 §4.1): the This scene | Book panel of story memory v2. Needs a look
 * draws a group only when it holds something (My to-dos, then Questions, then Notices) and its
 * badge counts conflicts only; *Named in this scene* says why each chip is there and takes *Not a
 * mention*, which lands on the one Dismissed list, whose rows each have *Undo*.
 */

type Handler = (input: unknown) => unknown
let calls: [Channel, unknown][]
let listeners: Partial<Record<EventName, ((payload: unknown) => void)[]>>

const MARA = recordFixture('r-mara', 'character', ['Mara Vell', 'Mara'])
const TOMAS = recordFixture('r-tomas', 'character', [
  'Tomas Harrow',
  { text: 'Harrow', shared: true }
])
const ELLA = recordFixture('r-ella', 'character', ['Ella Harrow', { text: 'Harrow', shared: true }])
const QUAY = recordFixture('r-quay', 'setting', ['North Quay'])

const mention = (
  id: string,
  recordId: string,
  para: number,
  from: number,
  text: string,
  ambiguous = false
): NameMentionView => ({
  id,
  recordId,
  para,
  from,
  to: from + text.length,
  text,
  ambiguous,
  spanKey: `${para}:${from}`
})

const MENTIONS: NameMentionView[] = [
  mention('m1', 'r-mara', 0, 1, 'Mara'),
  mention('m2', 'r-tomas', 1, 20, 'Harrow', true),
  mention('m3', 'r-ella', 1, 20, 'Harrow', true),
  mention('m4', 'r-mara', 2, 40, 'Mara Vell'),
  mention('m5', 'r-quay', 2, 60, 'North Quay')
]

const NAMED_IN: NamedInRow[] = [
  { recordId: 'r-tomas', nodeId: 'sc-1', count: 1 },
  { recordId: 'r-mara', nodeId: 'sc-1', count: 2 },
  { recordId: 'r-mara', nodeId: 'sc-2', count: 1 },
  { recordId: 'r-ella', nodeId: 'sc-2', count: 1 }
]

const HESK: NameQuestion = {
  kind: 'newName',
  name: 'Hesk',
  norm: 'hesk',
  count: 3,
  nodeIds: ['sc-1', 'sc-2'],
  recordId: null,
  recordName: null
}
const RY: NameQuestion = {
  kind: 'nickname',
  name: 'Ry',
  norm: 'ry',
  count: 2,
  nodeIds: ['sc-1'],
  recordId: 'r-mara',
  recordName: 'Mara Vell'
}

const todo = (id: string, text: string, position: number, done = false): AuthorTodo => ({
  id,
  text,
  nodeId: null,
  recordId: null,
  done,
  position,
  created: '2026-10-12T09:00:00.000Z',
  doneAt: null
})

const tombstone = (id: string, label: string): Dismissed => ({
  id,
  kind: 'notMention',
  key: `r-mara|${label}`,
  recordId: 'r-mara',
  nodeId: 'sc-1',
  label,
  quote: 'Mara walked',
  created: '2026-10-12T10:00:00.000Z'
})

let mentions: NameMentionView[]
let todos: AuthorTodo[]
/** What main's Dismissed list holds. */
let dismissedRows: Dismissed[]

function install(overrides: Partial<Record<Channel, Handler>> = {}): void {
  calls = []
  listeners = {}
  mentions = MENTIONS
  todos = []
  dismissedRows = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return (await override(input)) as Output<C>
      switch (channel) {
        case 'record:list':
          return [ELLA, MARA, QUAY, TOMAS] as Output<C>
        case 'names:byRecord':
          return NAMED_IN as Output<C>
        case 'names:forNode':
          return mentions as Output<C>
        case 'sceneDetail:get':
          return { ...emptySceneDetails(), povRecordId: 'r-mara', gone: [] } as Output<C>
        case 'names:questions':
          return [] as Output<C>
        case 'dismissed:list':
          return { items: dismissedRows, count: dismissedRows.length } as Output<C>
        case 'authorTodo:list':
          return todos as Output<C>
        case 'layout:set':
          return input as Output<C>
        // F-16.18: a scene nothing has read yet (the AI-off form of the panel).
        case 'memory:scene':
          return sceneMemoryFixture((input as Input<'memory:scene'>).nodeId) as Output<C>
        // F-16.20: the card lines the memory store reads with the status and the notices.
        case 'memory:cardLines':
          return {} as Output<C>
        // F-16.22: the Book tab's who-knows-what grid, empty until a test says otherwise.
        case 'memory:knows':
          return knowsGridFixture({
            asOf: (input as Input<'memory:knows'>).asOf
          }) as Output<C>
        // F-16.30: no Check the book has run yet.
        case 'memory:checkReport':
          return null as Output<C>
        // F-16.23: the Book tab's Threads and Timeline, empty until a test says otherwise.
        case 'memory:threads':
          return threadsMemoryFixture({
            asOf: (input as Input<'memory:threads'>).asOf
          }) as Output<C>
        case 'memory:timeline':
          return timelineFixture({
            recordId: (input as Input<'memory:timeline'>).recordId
          }) as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      const list: ((payload: unknown) => void)[] = listeners[event] ?? []
      list.push(listener as (payload: unknown) => void)
      listeners[event] = list
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((each) => each !== listener)
      }
    }
  })
}

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)

async function open(sceneId: string | null = 'sc-1'): Promise<void> {
  await act(async () => {
    await useRecordStore.getState().load()
    await useNameMentionStore.getState().load()
  })
  render(
    <>
      <ThisScenePanel sceneId={sceneId} />
      <DismissedDialog />
    </>
  )
  if (sceneId !== null) await screen.findByTestId('named-chips')
}

function resetAll(): void {
  resetRecordStore()
  resetNameMentionStore()
  resetSceneDetailStore()
  resetQuestionStore()
  resetAuthorTodoStore()
  resetDismissedStore()
  resetFiledConflictStore()
  resetAiStore()
  resetAiSettingsStore()
  resetCategoryStore()
  resetLayoutStore()
  resetDocumentStore()
  resetMemoryStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.getState().clear()
}

beforeEach(() => {
  install()
  resetAll()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
})
afterEach(() => {
  resetAll()
  setIpcClient(null)
})

describe('the This scene panel’s rules (F-16.12)', () => {
  it('draws a Needs a look group only when it holds something, to-dos first', () => {
    expect(needsALookGroups({ todos: [], questions: [], notices: [] })).toEqual([])
    expect(
      needsALookGroups({ todos: [], questions: [HESK], notices: [] }).map((group) => group.id)
    ).toEqual(['questions'])
    expect(
      needsALookGroups({ todos: [todo('t1', 'Tide', 0)], questions: [HESK], notices: ['n'] }).map(
        (group) => group.id
      )
    ).toEqual(['todos', 'questions', 'notices'])
    // The to-do group stays drawn while the first one is being typed.
    expect(
      needsALookGroups({ todos: [], questions: [], notices: [], todosOpen: true }).map(
        (group) => group.id
      )
    ).toEqual(['todos'])
    // F-16.17 (plan Suggestions.md): the scene's suggestions right after the to-dos.
    expect(
      needsALookGroups({
        todos: [todo('t1', 'Tide', 0)],
        questions: [HESK],
        notices: [],
        suggestions: [suggestionViewFixture('s1')]
      }).map((group) => group.id)
    ).toEqual(['todos', 'suggestions', 'questions'])
    // Ticked to-dos sit apart from the open ones, and keep the group drawn.
    const [mine] = needsALookGroups({
      todos: [todo('t1', 'Tide', 0), todo('t2', 'Ferry', 1, true)],
      questions: [],
      notices: []
    })
    expect(mine).toEqual({
      id: 'todos',
      todos: [todo('t1', 'Tide', 0)],
      done: [todo('t2', 'Ferry', 1, true)]
    })
  })

  it('counts conflicts only in the badge, and shows nothing at zero', () => {
    expect(needsALookBadge(0)).toBeNull()
    expect(needsALookBadge(2)).toBe('2')
  })

  it('makes chips: the records named for certain, most named first, and the ambiguous spans', () => {
    const byId = { 'r-mara': MARA, 'r-tomas': TOMAS, 'r-ella': ELLA, 'r-quay': QUAY }
    const { named, ambiguous } = namedChips(MENTIONS, byId)
    expect(named.map((chip) => [chip.name, chip.mentions.length])).toEqual([
      ['Mara Vell', 2],
      ['North Quay', 1]
    ])
    expect(namedWhy(named[0]!)).toBe('named 2 times: ¶1, ¶3')
    expect(namedWhy(named[1]!)).toBe('named once: ¶3')
    expect(ambiguous.map(ambiguousLabel)).toEqual(['Tomas Harrow or Ella Harrow?'])
  })

  it('words the questions and orders the cast by how many scenes name each character', () => {
    expect(questionLine(HESK)).toBe('Hesk: named in 2 scenes')
    expect(questionLine(RY)).toBe('Is “Ry” Mara Vell?')
    const cast = castOf([ELLA, MARA, QUAY, TOMAS], { 'r-mara': 2, 'r-tomas': 1, 'r-ella': 1 })
    expect(cast.map((record) => record.name)).toEqual(['Mara Vell', 'Ella Harrow', 'Tomas Harrow'])
  })
})

describe('ThisScenePanel (F-16.12)', () => {
  it('shows Here, the named chips with why, a dimmed ambiguous span, and today’s reading spend', async () => {
    useMemoryStore.setState({ status: memoryStatusFixture({ todayUsd: 0.003 }) })
    await open()
    const here = screen.getByRole('region', { name: 'Here' })
    expect(within(here).getByLabelText('POV')).toHaveValue('r-mara')
    const chips = screen.getByTestId('named-chips')
    const mara = within(chips).getByRole('button', { name: /^Mara Vell/ })
    expect(mara).toHaveAttribute('title', 'named 2 times: ¶1, ¶3')
    const harrow = within(chips).getByRole('button', { name: 'Tomas Harrow or Ella Harrow?' })
    expect(harrow.className).toContain('opacity-70')
    fireEvent.click(mara)
    const card = screen.getByRole('group', { name: 'Why Mara Vell is here' })
    expect(within(card).getAllByRole('button', { name: 'Go there' })).toHaveLength(2)
    expect(await screen.findByTestId('this-scene-spend')).toHaveTextContent('today 0.3¢')
    // No card yet: the AI-off form's heading (P2a-D21).
    expect(screen.getByRole('heading', { name: 'Named in this scene' })).toBeInTheDocument()
  })

  it('Not a mention removes the chip and lands on Dismissed, whose Undo brings it back', async () => {
    const row = tombstone('d-1', '"Mara walked" is not a mention of Mara Vell')
    install({
      'names:notAMention': () => {
        mentions = MENTIONS.filter((each) => each.recordId !== 'r-quay')
        dismissedRows = [row]
        return row
      },
      'dismissed:undo': () => {
        mentions = MENTIONS
        dismissedRows = []
        return row
      }
    })
    await open()
    const chips = screen.getByTestId('named-chips')
    fireEvent.click(within(chips).getByRole('button', { name: /^North Quay/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Not a mention' }))
    await waitFor(() =>
      expect(within(chips).queryByRole('button', { name: /^North Quay/ })).toBeNull()
    )
    expect(sent('names:notAMention')).toEqual([{ mentionId: 'm5' }])
    fireEvent.click(screen.getByRole('button', { name: 'Dismissed (1)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Dismissed (1)' })
    expect(within(dialog).getByText(row.label)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: `Undo: ${row.label}` }))
    await waitFor(() => expect(useDismissedStore.getState().items).toEqual([]))
    expect(sent('dismissed:undo')).toEqual([{ id: 'd-1' }])
    expect(within(dialog).getByText('Nothing is dismissed.')).toBeInTheDocument()
  })

  it('keeps Needs a look quiet: nothing drawn but its line, and no badge for questions or to-dos', async () => {
    await open()
    const needs = screen.getByRole('region', { name: 'Needs a look' })
    expect(within(needs).getByText('Nothing needs a look.')).toBeInTheDocument()
    act(() => {
      useQuestionStore.setState({ questions: [HESK, RY], loaded: true })
      useAuthorTodoStore.setState({ todos: [todo('t1', 'Check the tide tables', 0)], loaded: true })
    })
    const groups = within(needs)
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'))
    expect(groups).toEqual(['My to-dos', 'Questions'])
    expect(screen.queryByTestId('needs-a-look-badge')).toBeNull()
  })

  it('answers a new name with Add as a category or Not a name, and a nickname with Yes or No', async () => {
    const record = { kind: 'record', record: { ...MARA, pinned: null, ideas: null } }
    install({ 'names:answer': () => record })
    await open()
    act(() => useQuestionStore.setState({ questions: [HESK, RY], loaded: true }))
    fireEvent.change(screen.getByLabelText('Add Hesk as'), { target: { value: 'character' } })
    await waitFor(() => expect(sent('names:answer')).toHaveLength(1))
    expect(sent('names:answer')[0]).toEqual({
      answer: { kind: 'addAs', name: 'Hesk', categoryId: 'character' }
    })
    await waitFor(() => expect(useQuestionStore.getState().questions).toEqual([RY]))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(sent('names:answer')).toHaveLength(2))
    expect(sent('names:answer')[1]).toEqual({
      answer: { kind: 'yes', name: 'Ry', recordId: 'r-mara' }
    })
  })

  it('adds a to-do for this scene and ticks it', async () => {
    install({
      'authorTodo:create': (input) => {
        const made = { ...todo('t1', (input as { text: string }).text, 0), nodeId: 'sc-1' }
        return made
      },
      'authorTodo:update': () => ({
        ...todo('t1', 'Check the tide tables', 0, true),
        nodeId: 'sc-1'
      })
    })
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Add a to-do' }))
    fireEvent.change(screen.getByLabelText('New to-do'), {
      target: { value: 'Check the tide tables' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const tick = await screen.findByLabelText('Done: Check the tide tables')
    expect(sent('authorTodo:create')).toEqual([
      { text: 'Check the tide tables', nodeId: 'sc-1', recordId: null }
    ])
    fireEvent.click(tick)
    await waitFor(() => expect(screen.getByLabelText('Done: Check the tide tables')).toBeChecked())
    expect(sent('authorTodo:update')).toEqual([{ id: 't1', patch: { done: true } }])
  })

  it('keeps ticked to-dos behind a collapsed line, moves open ones past them, and deletes', async () => {
    const reordered: string[][] = []
    install({
      'authorTodo:reorder': (input) => {
        const { ids } = input as { ids: string[] }
        reordered.push(ids)
        return ids.map((id) => todos.find((each) => each.id === id)!)
      },
      'authorTodo:delete': (input) => {
        const { id } = input as { id: string }
        return todos.filter((each) => each.id !== id)
      }
    })
    todos = [
      todo('t1', 'Check the tide tables', 0),
      todo('t2', 'Name the ferry', 1, true),
      todo('t3', 'Fix the lantern colour', 2)
    ]
    await act(async () => useAuthorTodoStore.getState().load())
    await open()
    const group = screen.getByRole('group', { name: 'My to-dos' })
    // The done one waits behind "1 done"; the open ones keep their order.
    expect(within(group).getByText('1 done')).toBeInTheDocument()
    expect(within(group).getByLabelText('Done: Name the ferry')).toBeChecked()
    expect(
      within(group).getByRole('button', { name: 'Move up: Check the tide tables' })
    ).toBeDisabled()
    expect(
      within(group).getByRole('button', { name: 'Move down: Fix the lantern colour' })
    ).toBeDisabled()
    fireEvent.click(within(group).getByRole('button', { name: 'Move up: Fix the lantern colour' }))
    await waitFor(() => expect(reordered).toHaveLength(1))
    // It steps past the hidden done one to the open one above.
    expect(reordered[0]).toEqual(['t3', 't1', 't2'])
    fireEvent.click(within(group).getByRole('button', { name: 'Delete to-do: Name the ferry' }))
    await waitFor(() => expect(sent('authorTodo:delete')).toEqual([{ id: 't2' }]))
    await waitFor(() => expect(within(group).queryByText('1 done')).toBeNull())
  })

  it('adds a to-do about a record, and shows both its links', async () => {
    install({
      'authorTodo:create': (input) => {
        const { text, nodeId, recordId } = input as {
          text: string
          nodeId: string | null
          recordId: string | null
        }
        return { ...todo('t9', text, 0), nodeId, recordId }
      }
    })
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Add a to-do' }))
    fireEvent.change(screen.getByLabelText('New to-do'), { target: { value: 'Her eyes' } })
    fireEvent.change(screen.getByLabelText('About a record'), { target: { value: 'r-mara' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByLabelText('Done: Her eyes')
    expect(sent('authorTodo:create')).toEqual([
      { text: 'Her eyes', nodeId: 'sc-1', recordId: 'r-mara' }
    ])
    const line = screen.getByLabelText('Done: Her eyes').closest('li')
    expect(line).toHaveTextContent(/· Mara Vell$/)
  })

  it('notices inline tags in the open scene until the switch-over', async () => {
    useDocumentStore.setState({
      docs: {
        'sc-1': {
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'The ' },
                  { type: 'inlineTag', attrs: { id: 'tag-1', name: 'storm' } }
                ]
              }
            ]
          },
          dirty: false
        }
      }
    })
    await open()
    const notices = screen.getByRole('group', { name: 'Notices' })
    expect(notices).toHaveTextContent(INLINE_TAGS_NOTICE)
  })

  it('lists the Cast on the Book tab, most-named first, and opens a sheet', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: 'Book' }))
    const cast = screen.getByRole('region', { name: 'Cast' })
    const rows = within(cast).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Mara Vellnamed in 2 scenes',
      'Ella Harrownamed in 1 scene',
      'Tomas Harrownamed in 1 scene'
    ])
    fireEvent.click(rows[0]!)
    expect(useRecordStore.getState().selectedId).toBe('r-mara')
  })

  it('orders the Book tab: Cast, Who knows what, Threads, Timeline, Check the book, Rebuild memory (F-16.23, F-16.30)', async () => {
    install({
      'memory:threads': (input) =>
        threadsMemoryFixture({
          asOf: (input as Input<'memory:threads'>).asOf,
          threads: [threadViewFixture('t-heir', 'the missing heir')]
        }),
      'memory:timeline': () => timelineFixture({ rows: [timelineRowFixture('sc-1')] })
    })
    await open()
    fireEvent.click(screen.getByRole('tab', { name: 'Book' }))
    await screen.findByRole('group', { name: 'Thread: the missing heir' })
    await screen.findAllByTestId('timeline-row')
    const panel = screen.getByRole('tabpanel')
    expect(
      within(panel)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(['Cast', 'Who knows what', 'Threads', 'Timeline', 'Contradictions', 'Memory'])
    expect(within(panel).getByRole('button', { name: 'Rebuild memory…' })).toBeVisible()
    expect(within(panel).getByRole('button', { name: 'Check the book…' })).toBeVisible()
    expect(within(panel).getByTestId('check-last')).toHaveTextContent('Not checked yet')
    // The Threads are as of the open scene, like the grid; the Timeline lists every scene.
    expect(sent('memory:threads')).toEqual([{ asOf: 'sc-1' }])
    expect(sent('memory:timeline')).toEqual([{ recordId: null }])
  })

  it('asks for a scene when none is open, and still shows Needs a look', async () => {
    await open(null)
    expect(screen.getByText('Open a scene to see who is in it.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Needs a look' })).toBeInTheDocument()
  })
})

const CONFLICT: FiledConflict = {
  key: 'filed|r-mara|abc|def',
  recordId: 'r-mara',
  recordName: 'Mara Vell',
  docId: 'r-bestiary',
  docTitle: 'Bestiary',
  para: 3,
  line: 'Eyes: grey',
  lineIndex: 0,
  quote: 'Mara Vell has grey eyes',
  nowReads: 'Mara Vell has brown eyes.',
  pageNotCanon: false
}

describe('Needs a look’s filed-line conflicts (F-16.9)', () => {
  it('puts My to-dos first, then the conflicts (P4-D20)', () => {
    expect(
      needsALookGroups({
        conflicts: [CONFLICT],
        todos: [todo('t1', 'Tide', 0)],
        questions: [],
        notices: []
      }).map((group) => group.id)
    ).toEqual(['todos', 'conflicts'])
    expect(conflictLine(CONFLICT)).toBe(
      'Filed from “Bestiary” ¶4, which now reads “Mara Vell has brown eyes.”'
    )
    expect(conflictLine({ ...CONFLICT, nowReads: null })).toBe(
      'Filed from “Bestiary” ¶4, which now has no text there'
    )
    expect(conflictLine({ ...CONFLICT, pageNotCanon: true })).toBe(
      'Filed from “Bestiary” ¶4, which is now Not canon'
    )
  })

  it('offers Go there, Update line (the page’s paragraph beside it) and Keep line', async () => {
    install({
      'research:filedConflicts': () => [CONFLICT],
      'research:keepFiledLine': () => ({
        ...tombstone('d-keep', 'Mara Vell: kept “Eyes: grey”'),
        kind: 'notProblem'
      }),
      'research:updateFiledLine': () => ({ ...MARA, pinned: null, ideas: null })
    })
    await act(async () => {
      await useFiledConflictStore.getState().load()
    })
    await open()
    expect(screen.getByTestId('needs-a-look-badge')).toHaveTextContent('1')
    const group = screen.getByRole('group', { name: 'Conflicts' })
    expect(group).toHaveTextContent('Mara Vell: “Eyes: grey”')
    expect(group).toHaveTextContent(conflictLine(CONFLICT))
    fireEvent.click(within(group).getByRole('button', { name: 'Update line' }))
    expect(within(group).getByText('“Mara Vell has brown eyes.”')).toBeInTheDocument()
    fireEvent.change(within(group).getByLabelText('The line'), { target: { value: 'Eyes: brown' } })
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Save line' }))
    })
    expect(sent('research:updateFiledLine')).toEqual([
      { recordId: 'r-mara', lineIndex: 0, line: 'Eyes: grey', text: 'Eyes: brown' }
    ])
    await waitFor(() => expect(screen.queryByTestId('needs-a-look-badge')).toBeNull())
  })

  it('Keep line sends the conflict and moves it to Dismissed', async () => {
    install({
      'research:filedConflicts': () => [CONFLICT],
      'research:keepFiledLine': () => ({
        ...tombstone('d-keep', 'Mara Vell: kept “Eyes: grey”'),
        kind: 'notProblem'
      })
    })
    await act(async () => {
      await useFiledConflictStore.getState().load()
      await useDismissedStore.getState().load()
    })
    await open()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep line' }))
    })
    expect(sent('research:keepFiledLine')).toEqual([{ conflict: CONFLICT }])
    expect(screen.queryByRole('group', { name: 'Conflicts' })).toBeNull()
    expect(useDismissedStore.getState().items.map((row) => row.id)).toContain('d-keep')
  })
})

describe('What the AI is told (F-16.14)', () => {
  it('shows exactly the Story notes block main sends, read when the section opens', async () => {
    const BLOCK =
      'Story notes (the manuscript wins: where the passage and these notes disagree, follow the passage):\nHere: Mara Vell (POV)'
    install({ 'storyNotes:get': () => ({ text: BLOCK }) })
    await open()
    expect(sent('storyNotes:get')).toEqual([])
    const section = screen.getByTestId('what-the-ai-is-told')
    await act(async () => {
      section.setAttribute('open', '')
      fireEvent(section, new Event('toggle'))
    })
    expect(await screen.findByTestId('story-notes-block')).toHaveTextContent(
      'Here: Mara Vell (POV)'
    )
    expect(sent('storyNotes:get')[0]).toEqual({ nodeId: 'sc-1' })
  })
})

describe('the reading in the panel (F-16.18, F-16.16, F-16.19)', () => {
  const READ_AT = new Date(Date.now() - 3 * 60_000).toISOString()
  const PLACE_CONFLICT: MemoryNotice = {
    id: 'detail:sc-1:place',
    kind: 'detailConflict',
    nodeId: 'sc-1',
    ref: '1.1',
    field: 'place',
    typed: 'the harbour',
    text: 'the quay',
    textRecordId: null,
    quote: 'She walked to the quay'
  }
  const read = (): SceneMemory =>
    sceneMemoryFixture('sc-1', {
      card: {
        line: 'Mara walks to the quay.',
        gist: 'Mara walks to the quay.',
        fields: {
          where: { value: 'the quay', quote: 'She walked to the quay', p: 1, verified: true },
          when: null,
          pov: { value: 'r-mara', quote: 'Mara looked out', p: 0, verified: true },
          year: null,
          flashback: null,
          elapsed: null
        },
        stale: [],
        mood: null,
        theme: null,
        readingId: 'rd-1',
        created: READ_AT
      },
      here: [
        { recordId: 'r-mara', why: 'pov', quote: 'Mara looked out', p: 0, typedPov: 'r-tomas' },
        { recordId: 'r-ella', why: 'onPage', quote: 'Ella set down the lamp', p: 1, typedPov: null }
      ],
      mentioned: [{ recordId: 'r-quay', count: 1 }],
      trueNow: [
        {
          recordId: 'r-mara',
          slot: 'location',
          label: 'Last seen at',
          objectId: null,
          value: 'the quay',
          claimId: 'c-where',
          kind: 'lastStated',
          ref: '1.1',
          nodeId: 'sc-1',
          stale: false
        },
        {
          recordId: 'r-mara',
          slot: 'hair',
          label: 'Hair',
          objectId: null,
          value: 'red',
          claimId: 'c-hair',
          kind: 'since',
          ref: '1.1',
          nodeId: 'sc-1',
          stale: true
        }
      ],
      lastRead: { readingId: 'rd-1', at: READ_AT, model: 'm', costUsd: 0.0009 }
    })

  it('shows Here from the text with the typed POV dimmed, Mentioned without them, and True now', async () => {
    install({ 'memory:scene': () => read() })
    await open()
    const here = await screen.findByRole('region', { name: 'Here' })
    expect(await within(here).findByTestId('here-pov')).toHaveTextContent('Mara Vell')
    expect(within(here).getByTestId('typed-pov')).toHaveTextContent('you typed: Tomas Harrow')
    expect(within(within(here).getByTestId('on-page')).getByText('Ella Harrow')).toHaveAttribute(
      'title',
      'on the page: ¶2 “Ella set down the lamp”'
    )
    // Mentioned: named, not here (Mara is the POV).
    const mentioned = screen.getByRole('region', { name: 'Mentioned' })
    expect(within(mentioned).queryByRole('button', { name: /^Mara Vell/ })).toBeNull()
    expect(within(mentioned).getByRole('button', { name: /^North Quay/ })).toBeInTheDocument()
    // True now: the transient line last stated, the stale one dimmed and re-checking.
    const mara = screen.getByRole('group', { name: 'True now: Mara Vell' })
    const [where, hair] = within(mara).getAllByTestId('claim-line')
    expect(where).toHaveTextContent('Last seen at the quay')
    expect(where).toHaveTextContent('last stated in 1.1')
    expect(hair).toHaveTextContent('Hair: red')
    expect(hair).toHaveTextContent('since 1.1')
    expect(hair).toHaveTextContent('re-checking after you pause')
    expect(hair).toHaveAttribute('data-stale', 'true')
    // Reading paused (AI off): the stale line says so instead.
    act(() => useMemoryStore.setState({ status: memoryStatusFixture({ paused: 'off' }) }))
    expect(within(mara).getAllByTestId('claim-line')[1]).toHaveTextContent('reading paused')
    expect(screen.getByTestId('last-read')).toHaveTextContent('Read 3 min ago')
  })

  it('opens ⓘ on a Here chip, and Not right sends the card’s POV or on-page character to Dismissed', async () => {
    const row = (field: string, value: string): Dismissed => ({
      id: `d-${field}`,
      kind: 'notRight',
      key: `${value}|card|sc-1|${field}`,
      recordId: value,
      nodeId: 'sc-1',
      label: `1.1: ${field}`,
      quote: null,
      created: READ_AT
    })
    install({
      'memory:scene': () => read(),
      'memory:cardNotRight': (input) => {
        const { field, value } = input as Input<'memory:cardNotRight'>
        return row(field, value)
      }
    })
    await open()
    const here = await screen.findByRole('region', { name: 'Here' })
    fireEvent.click(await within(here).findByTestId('here-pov'))
    const info = within(here).getByRole('group', { name: 'Where this comes from: Mara Vell' })
    expect(info).toHaveTextContent('Mara looked out')
    expect(info).toHaveTextContent('¶1 · checked by a second AI read')
    await act(async () => {
      fireEvent.click(within(info).getByRole('button', { name: 'Not right' }))
    })
    expect(sent('memory:cardNotRight')).toEqual([{ nodeId: 'sc-1', field: 'pov', value: 'r-mara' }])
    fireEvent.click(within(within(here).getByTestId('on-page')).getByText('Ella Harrow'))
    const ella = within(here).getByRole('group', { name: 'Where this comes from: Ella Harrow' })
    await act(async () => {
      fireEvent.click(within(ella).getByRole('button', { name: 'Not right' }))
    })
    expect(sent('memory:cardNotRight')[1]).toEqual({
      nodeId: 'sc-1',
      field: 'present',
      value: 'r-ella'
    })
    expect(screen.getByRole('button', { name: 'Dismissed (2)' })).toBeInTheDocument()
  })

  it('reads a scene again when main says a reading changed it', async () => {
    let memory = sceneMemoryFixture('sc-1')
    install({ 'memory:scene': () => memory })
    await open()
    expect(screen.queryByRole('region', { name: 'True now' })).toBeNull()
    memory = read()
    await act(async () => {
      useMemoryStore.getState().subscribe()
      for (const listener of listeners['memory:changed'] ?? []) {
        listener({ nodeIds: ['sc-1'], recordIds: [] })
      }
      await Promise.resolve()
    })
    expect(await screen.findByRole('region', { name: 'True now' })).toBeInTheDocument()
  })

  it('Read now flushes and reads, and says when there was nothing new', async () => {
    install({
      'memory:readNow': () => ({
        ok: true,
        read: false,
        reason: 'upToDate',
        readingId: null,
        costUsd: 0
      })
    })
    useMemoryStore.setState({
      status: memoryStatusFixture({ cloud: { spentUsd: 0.12, capUsd: 1 } })
    })
    await open()
    expect(screen.getByTestId('cloud-spend')).toHaveTextContent('Cloud 12¢ of $1')
    expect(screen.getByTestId('last-read')).toHaveTextContent('Not read yet')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read now' }))
    })
    expect(sent('memory:readNow')).toEqual([
      { nodeId: 'sc-1', requestId: expect.any(String) as string }
    ])
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toContain(
      'Nothing new to read in this scene.'
    )
  })

  it('shows the reading notices with their buttons', async () => {
    const backlog: MemoryNotice = { id: 'backlog', kind: 'backlog', scenes: 7, priceUsd: 0.03 }
    const health: MemoryNotice = {
      id: 'health:m-1',
      kind: 'health',
      model: 'm-1',
      quotes: 0.8,
      verified: 0.9,
      switchable: true
    }
    install({ 'memory:answerNotice': () => [health] })
    useMemoryStore.setState({ notices: [backlog, health] })
    await open()
    const notices = screen.getByRole('group', { name: 'Notices' })
    expect(within(notices).getByText('Read 7 changed scenes: about 3¢')).toBeInTheDocument()
    expect(
      within(notices).getByRole('button', { name: 'Switch to DeepSeek V4 Flash' })
    ).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(notices).getByRole('button', { name: 'Read them' }))
    })
    expect(sent('memory:answerNotice')).toEqual([{ id: 'backlog', action: 'read' }])
    expect(useMemoryStore.getState().notices).toEqual([health])
    // The badge counts conflicts only.
    expect(screen.queryByTestId('needs-a-look-badge')).toBeNull()
  })

  it('asks about a typed detail the text disagrees with: Update my detail, Keep mine', async () => {
    install({
      'memory:answerNotice': () => [],
      'memory:notices': () => [PLACE_CONFLICT],
      'sceneDetail:get': () => ({
        ...emptySceneDetails(),
        place: { recordId: null, text: 'the harbour' },
        gone: []
      }),
      'sceneDetail:set': (input) => ({ ...(input as Input<'sceneDetail:set'>).details, gone: [] })
    })
    useMemoryStore.setState({ notices: [PLACE_CONFLICT] })
    await open()
    expect(screen.getByTestId('needs-a-look-badge')).toHaveTextContent('1')
    const conflicts = screen.getByRole('group', { name: 'Conflicts' })
    expect(
      within(conflicts).getByText('1.1: the text says the quay; you typed the harbour')
    ).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(conflicts).getByRole('button', { name: 'Update my detail' }))
    })
    expect(sent('sceneDetail:set')).toEqual([
      {
        nodeId: 'sc-1',
        details: { ...emptySceneDetails(), place: { recordId: null, text: 'the quay' } }
      }
    ])
    await act(async () => {
      fireEvent.click(within(conflicts).getByRole('button', { name: 'Keep mine' }))
    })
    expect(sent('memory:answerNotice')).toEqual([{ id: 'detail:sc-1:place', action: 'keepMine' }])
    expect(screen.queryByRole('group', { name: 'Conflicts' })).toBeNull()
  })

  it('writes nothing when the text changed since the conflict was raised', async () => {
    install({
      'memory:notices': () => [],
      'memory:status': () => memoryStatusFixture(),
      'sceneDetail:get': () => ({
        ...emptySceneDetails(),
        place: { recordId: null, text: 'the harbour' },
        gone: []
      })
    })
    useMemoryStore.setState({ notices: [PLACE_CONFLICT] })
    await open()
    const conflicts = screen.getByRole('group', { name: 'Conflicts' })
    await act(async () => {
      fireEvent.click(within(conflicts).getByRole('button', { name: 'Update my detail' }))
    })
    expect(sent('sceneDetail:set')).toEqual([])
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toContain(
      'The text changed since: this is looked at again once the scene is read.'
    )
    expect(screen.queryByRole('group', { name: 'Conflicts' })).toBeNull()
  })
})

describe('Who knows what in the panel (F-16.22)', () => {
  /** Scene 1.1: Mara (POV), Ella and Tomas on the page; Ella overheard Tomas, who knew before. */
  const touched = (): SceneMemory =>
    sceneMemoryFixture('sc-1', {
      card: {
        line: 'Tomas sells the map.',
        gist: 'Tomas sells the map.',
        fields: {
          where: null,
          when: null,
          pov: null,
          year: null,
          flashback: null,
          elapsed: null
        },
        stale: [],
        mood: null,
        theme: null,
        readingId: 'rd-1',
        created: '2026-10-13T10:00:00.000Z'
      },
      here: [
        { recordId: 'r-mara', why: 'pov', quote: null, p: null, typedPov: null },
        { recordId: 'r-ella', why: 'onPage', quote: 'Ella heard', p: 1, typedPov: null },
        { recordId: 'r-tomas', why: 'onPage', quote: 'Tomas sold', p: 0, typedPov: null }
      ],
      secrets: {
        touched: [
          {
            secret: secretViewFixture('s-map', 'the sold map', {
              cells: [
                knowsCellFixture('r-tomas', { how: 'knewBefore' }),
                knowsCellFixture('r-ella', { fromId: 'r-tomas' }),
                // Not Here: not a holder line in this scene.
                knowsCellFixture('r-quay', { how: 'saw' })
              ]
            }),
            without: ['r-mara']
          }
        ],
        tension: [],
        more: 0,
        checkedUpTo: { nodeId: 'sc-1', ref: '1.1' }
      }
    })

  it('shows the secret, its holders Here with ⓘ, and the muted scoped line for Mara', async () => {
    install({
      'memory:scene': () => touched(),
      'memory:topicNotRight': () => ({ dismissed: [tombstone('d-topic', 'Not a secret')] })
    })
    await open()
    const section = await screen.findByRole('region', { name: 'Who knows what' })
    const secret = within(section).getByRole('group', { name: 'Who knows the sold map' })
    expect(within(secret).getByTestId('readers-since')).toHaveTextContent('readers since 1.1')
    expect(
      within(secret)
        .getAllByTestId('claim-line')
        .map((line) => line.firstChild?.textContent)
    ).toEqual(['Tomas Harrow: knew before (1.1)', 'Ella Harrow: overheard from Tomas Harrow (1.1)'])
    expect(within(secret).getByTestId('absence-line')).toHaveTextContent(
      'No scene shows Mara Vell learning this (checked up to 1.1)'
    )
    expect(within(secret).queryByText(/North Quay/)).toBeNull()
    // ⓘ on the secret: its reveal, how it was checked, and Not a secret.
    fireEvent.click(
      within(secret).getByRole('button', { name: 'Where this comes from: the sold map' })
    )
    const info = within(secret).getByTestId('topic-info')
    expect(info).toHaveTextContent('Tomas sold the map')
    expect(info).toHaveTextContent('checked by a second AI read')
    fireEvent.click(within(info).getByRole('button', { name: 'Not a secret' }))
    await waitFor(() => expect(sent('memory:topicNotRight')).toEqual([{ recordId: 's-map' }]))
    await waitFor(() =>
      expect(useDismissedStore.getState().items.map((row) => row.id)).toContain('d-topic')
    )
  })

  it('shows tension lines and "+ N more in Book", which opens the grid as of the scene', async () => {
    const since = { nodeId: 'sc-1', ref: '1.1', stale: false }
    install({
      'memory:scene': () =>
        sceneMemoryFixture('sc-1', {
          here: [{ recordId: 'r-mara', why: 'pov', quote: null, p: null, typedPov: null }],
          secrets: {
            touched: [],
            tension: [
              {
                kind: 'readersKnow',
                secretId: 's-map',
                label: 'the sold map',
                since,
                recordId: 'r-mara',
                stale: false
              },
              {
                kind: 'hereKnows',
                secretId: 's-debts',
                label: 'the debts',
                since,
                holderId: 'r-tomas',
                recordId: 'r-mara',
                stale: true
              }
            ],
            more: 2,
            checkedUpTo: { nodeId: 'sc-1', ref: '1.2' }
          }
        })
    })
    await open()
    const section = await screen.findByRole('region', { name: 'Who knows what' })
    const lines = within(section).getAllByTestId('tension-line')
    expect(lines.map((line) => line.textContent)).toEqual([
      'Readers know the sold map (since 1.1); no scene shows Mara Vell (POV) learning it (checked up to 1.2)',
      'Tomas Harrow knows the debts; no scene shows Mara Vell learning it (checked up to 1.2)'
    ])
    expect(lines[1]).toHaveAttribute('data-stale', 'true')
    fireEvent.click(within(section).getByRole('button', { name: '+ 2 more in Book' }))
    expect(screen.getByRole('tab', { name: 'Book' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('region', { name: 'Who knows what' })).toHaveAttribute(
      'data-testid',
      'knows-grid'
    )
    expect(sent('memory:knows')).toEqual([{ asOf: 'sc-1' }])
  })

  it('shows nothing when the scene touches no secret and has no tension', async () => {
    install({
      'memory:scene': () =>
        sceneMemoryFixture('sc-1', {
          secrets: { touched: [], tension: [], more: 4, checkedUpTo: null }
        })
    })
    await open()
    await waitFor(() => expect(sent('memory:scene')).toHaveLength(1))
    expect(screen.queryByRole('region', { name: 'Who knows what' })).toBeNull()
  })
})

describe('Needs a look’s contradictions, loose ends and notices (F-16.27, F-16.29; P4 slice 4)', () => {
  const OPEN = findingViewFixture('f-1')
  const NOTE = noteFindingFixture('f-6')
  const UNCLEAR = findingViewFixture('f-3', {
    state: 'unclear',
    slot: 'hair',
    slotLabel: 'Hair',
    a: findingSideFixture('dark', '1.4', 'sc-4'),
    b: findingSideFixture('fair', '1.5', 'sc-5')
  })

  it('orders the groups with My to-dos on top, and counts conflicts only', () => {
    const groups = needsALookGroups({
      conflicts: [],
      todos: [todo('t1', 'Tide', 0)],
      questions: [HESK],
      notices: ['n'],
      findings: [OPEN],
      unclear: [UNCLEAR],
      looseEnds: { items: [looseEndFixture()], more: 0 }
    })
    expect(groups.map((group) => group.id)).toEqual([
      'todos',
      'conflicts',
      'questions',
      'looseEnds',
      'notices'
    ])
    // Unclear ones alone still draw the group, never the badge.
    expect(
      needsALookGroups({ todos: [], questions: [], notices: [], unclear: [UNCLEAR] }).map(
        (group) => group.id
      )
    ).toEqual(['conflicts'])
    expect(conflictCount({ filed: 1, details: 1, findings: 2 })).toBe(4)
  })

  it('shows to-dos first, then the conflicts with the badge counting open findings only', async () => {
    todos = [todo('t1', 'Check the tide tables', 0)]
    install({
      'authorTodo:list': () => [todo('t1', 'Check the tide tables', 0)],
      'memory:findings': () => findingsViewFixture({ open: [OPEN, NOTE], unclear: [UNCLEAR] }),
      'memory:looseEnds': () => looseEndsFixture({ items: [looseEndFixture()] })
    })
    await act(async () => {
      await useAuthorTodoStore.getState().load()
      await useMemoryStore.getState().loadFindings()
      await useMemoryStore.getState().loadLooseEnds()
    })
    useMemoryStore.setState({
      notices: [
        {
          id: 'rebuildDone:a',
          kind: 'rebuildDone',
          startedAt: 'a',
          lines: 2,
          sheets: 1,
          names: 0,
          findings: 1
        },
        { id: 'findingsWaiting:d', kind: 'findingsWaiting', pairs: 3, priceUsd: 0.001 }
      ]
    })
    await open()
    const needs = screen.getByRole('region', { name: 'Needs a look' })
    expect(
      within(needs)
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent)
    ).toEqual(['My to-dos', 'Conflicts', 'Loose ends', 'Notices'])
    // Two open findings (one book against book, one against a note); the unclear one and the
    // loose end are not counted.
    expect(screen.getByTestId('needs-a-look-badge')).toHaveTextContent('2')
    const conflicts = within(needs).getByRole('group', { name: 'Conflicts' })
    expect(within(conflicts).getByRole('group', { name: 'In this scene' })).toHaveTextContent(
      'Mara Vell’s eyes: grey (1.1) · brown (1.2)'
    )
    expect(within(conflicts).getByTestId('note-conflict')).toHaveTextContent(
      'Your note on Orrin says born 1790; the book says 1792 (1.1)'
    )
    expect(within(conflicts).getByTestId('unclear-findings')).toHaveTextContent('Unclear (1)')
    expect(within(needs).getByTestId('loose-end')).toHaveTextContent(
      'Planned “The duel at dawn” sits before 1.2 and is not drafted'
    )
    // The rebuild's notice opens its grouped summary; pairs waiting open Check the book.
    fireEvent.click(within(needs).getByRole('button', { name: 'Review' }))
    expect(useMemoryStore.getState().rebuildOpen).toBe('summary')
    fireEvent.click(within(needs).getByRole('button', { name: 'Check the book…' }))
    expect(useMemoryStore.getState().checkOpen).toBe('start')
  })

  it('shows the switch-over’s notice: Rebuild… opens the rebuild dialog at its price, Later answers later (F-16.31)', async () => {
    install({ 'memory:answerNotice': () => [] })
    useMemoryStore.setState({
      notices: [
        {
          id: 'switchoverRebuild',
          kind: 'switchoverRebuild',
          switchedAt: '2026-10-14T09:00:00.000Z',
          scenes: 1,
          priceUsd: 0.0004,
          priced: true
        }
      ]
    })
    await open()
    const needs = screen.getByRole('region', { name: 'Needs a look' })
    const notices = within(needs).getByRole('group', { name: 'Notices' })
    expect(within(notices).getByTestId('reading-notice')).toHaveTextContent(
      'Rebuild memory has not run since the switch-over: it reads 1 scene, about 0.04¢'
    )
    // Rebuild… asks main nothing: the dialog prices it and asks.
    fireEvent.click(within(notices).getByRole('button', { name: 'Rebuild…' }))
    expect(useMemoryStore.getState().rebuildOpen).toBe('start')
    expect(sent('memory:answerNotice')).toEqual([])
    await act(async () => {
      fireEvent.click(within(notices).getByRole('button', { name: 'Later' }))
    })
    expect(sent('memory:answerNotice')).toEqual([{ id: 'switchoverRebuild', action: 'later' }])
    expect(useMemoryStore.getState().notices).toEqual([])
  })

  it('asks once to show contradictions in the panel only, and opens This scene for a hover card’s Update my note (F-16.28)', async () => {
    install({ 'memory:answerNotice': () => [] })
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
    useMemoryStore.setState({
      notices: [
        { id: 'underlinePrecision', kind: 'underlinePrecision', counted: 20, notProblems: 8 }
      ]
    })
    await open()
    const needs = screen.getByRole('region', { name: 'Needs a look' })
    expect(within(needs).getByTestId('reading-notice')).toHaveTextContent(
      'Of the last 20 underlined contradictions, 8 were not problems. Show contradictions in the panel only?'
    )
    expect(within(needs).getByRole('button', { name: 'Keep underlines' })).toBeInTheDocument()
    fireEvent.click(within(needs).getByRole('button', { name: 'Panel only' }))
    await waitFor(() =>
      expect(useAiSettingsStore.getState().settings?.reading.underlines).toBe('panel')
    )
    expect(sent('memory:answerNotice')).toEqual([{ id: 'underlinePrecision', action: 'panelOnly' }])
    // On the Book tab, a hover card's Update my note brings This scene back.
    fireEvent.click(screen.getByRole('tab', { name: 'Book' }))
    expect(screen.getByRole('tab', { name: 'Book' })).toHaveAttribute('aria-selected', 'true')
    act(() => {
      useMemoryStore.setState({
        noteEdit: {
          findingId: 'f-6',
          patch: {
            findingId: 'f-6',
            owner: { kind: 'record', id: 'r-orrin', name: 'Orrin' },
            page: 'pinned',
            index: 0,
            before: 'Born: 1790',
            after: 'Born: 1792',
            sentence: 'Born: 1790',
            value: '1792'
          }
        }
      })
    })
    expect(screen.getByRole('tab', { name: 'This scene' })).toHaveAttribute('aria-selected', 'true')
  })

  it('says a contradiction’s or a loose end’s Not a problem in Dismissed', () => {
    const base: Dismissed = tombstone('d-1', 'x')
    expect(
      dismissedRow({
        ...base,
        kind: 'notProblem',
        key: 'finding|r-mara|eyes|sc-1|grey|sc-2|brown',
        label: 'Mara Vell: eyes grey (1.1) and brown (1.2): not a problem'
      })
    ).toEqual({
      kind: 'Contradiction',
      label: 'Not a problem: Mara Vell, eyes grey (1.1) and brown (1.2)'
    })
    expect(
      dismissedRow({
        ...base,
        kind: 'notProblem',
        key: 'loose|planned|sc-plan|',
        label: 'Loose end: planned scene “The duel at dawn”: not a problem'
      })
    ).toEqual({ kind: 'Loose end', label: 'Not a problem: planned scene “The duel at dawn”' })
    expect(dismissedRow(base)).toEqual({ kind: 'Not a mention', label: 'x' })
  })
})
