import { isValidElement } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  BookOpen,
  CalendarRange,
  FilePenLine,
  ListTree,
  NotebookPen,
  Sparkles,
  Tag,
  Users
} from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALL_BUILTIN_CATEGORIES, BUILTIN_CATEGORIES, categoryFromInput } from '@shared/categories'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetCategoryStore, useCategoryStore } from '@renderer/features/entities/categoryStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { defaultEditorSettings } from '@shared/editorSettings'
import {
  resetEditorSettingsStore,
  useEditorSettingsStore
} from '@renderer/features/editor/settingsStore'
import { ThreadsTab } from '@renderer/features/threads/ThreadsTab'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetLayoutStore, useLayoutStore } from './layoutStore'
import { SidebarSections } from './SidebarSections'
import { RecordTab } from '@renderer/features/records/RecordTab'
import { ResearchTab } from '@renderer/features/research/ResearchTab'
import { NotesTab } from '@renderer/features/notebook/NotesTab'
import { buildSections, type SidebarSection } from './sectionList'

const section = (
  over: Partial<SidebarSection> & Pick<SidebarSection, 'id' | 'label' | 'group'>
): SidebarSection => ({
  icon: BookOpen,
  count: 0,
  used: true,
  render: () => <p>{over.label} here</p>,
  ...over
})

const sections: readonly SidebarSection[] = [
  section({ id: 'manuscript', label: 'Manuscript', group: 'manuscript', count: 12 }),
  section({ id: 'character', label: 'Characters', group: 'bible', icon: Users, count: 3 }),
  section({ id: 'magic', label: 'Magic Systems', group: 'bible', icon: Sparkles, count: 2 }),
  section({ id: 'religion', label: 'Religions', group: 'bible', used: false }),
  section({ id: 'tags', label: 'Tags', group: 'tools', icon: Tag, count: 9 }),
  section({ id: 'library', label: 'Library', group: 'tools', used: false })
]

const current = (): string => useLayoutStore.getState().layout.sidebar.tab
const picker = (): HTMLElement => screen.getByRole('button', { name: /^Section: / })
const listbox = (): HTMLElement => screen.getByRole('listbox', { name: 'Sections' })
const optionNames = (): string[] =>
  within(listbox())
    .getAllByRole('option')
    .map((o) => o.getAttribute('aria-label') ?? o.textContent ?? '')

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    if (channel === 'layout:set') return input as Output<C>
    throw new Error(`unexpected ${channel}`)
  },
  on: () => () => {}
}

describe('SidebarSections (F-9.11)', () => {
  beforeEach(() => {
    resetPendingSaves()
    resetLayoutStore()
    resetCategoryStore()
    setIpcClient(client)
  })

  afterEach(() => {
    resetLayoutStore()
    resetCategoryStore()
  })

  it('shows the current section by name on the button and its panel below', () => {
    render(<SidebarSections format="novel" sections={sections} />)
    expect(picker()).toHaveAccessibleName('Section: Manuscript')
    expect(picker()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('region', { name: 'Manuscript section' })).toHaveTextContent(
      'Manuscript here'
    )
  })

  it("puts the controls on the picker button's row", () => {
    render(
      <SidebarSections
        format="novel"
        sections={sections}
        controls={<button type="button">Move sidebar</button>}
      />
    )
    const picker = screen.getByRole('button', { name: /^Section:/ })
    expect(picker.parentElement).toContainElement(
      screen.getByRole('button', { name: 'Move sidebar' })
    )
  })

  it('lists the used sections by name with their counts, grouped, the unused behind a toggle', async () => {
    const user = userEvent.setup()
    render(<SidebarSections format="novel" sections={sections} />)
    await user.click(picker())
    expect(picker()).toHaveAttribute('aria-expanded', 'true')
    expect(optionNames()).toEqual([
      'Manuscript',
      'Characters',
      'Magic Systems',
      'Tags',
      'Show unused sections (2)',
      'New category…'
    ])
    expect(within(listbox()).getByRole('group', { name: 'Story bible' })).toHaveTextContent(
      'Characters3Magic Systems2'
    )
    expect(within(listbox()).getByRole('group', { name: 'Tools' })).toHaveTextContent('Tags9')
    await user.click(within(listbox()).getByRole('option', { name: /^Show unused/ }))
    expect(optionNames()).toEqual([
      'Manuscript',
      'Characters',
      'Magic Systems',
      'Tags',
      'Hide unused sections',
      'Religions',
      'Library',
      'New category…'
    ])
    // Reopened, the list starts folded again.
    await user.keyboard('{Escape}')
    await user.click(picker())
    expect(optionNames()).toContain('Show unused sections (2)')
  })

  it('picks a section with the mouse, closes, and shows its panel', async () => {
    const user = userEvent.setup()
    render(<SidebarSections format="novel" sections={sections} />)
    await user.click(picker())
    await user.click(within(listbox()).getByRole('option', { name: 'Magic Systems' }))
    expect(current()).toBe('magic')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(picker()).toHaveAccessibleName('Section: Magic Systems')
    expect(screen.getByRole('region', { name: 'Magic Systems section' })).toBeInTheDocument()
  })

  it('works from the keyboard: arrows move and wrap, Enter picks, Escape closes', async () => {
    const user = userEvent.setup()
    render(<SidebarSections format="novel" sections={sections} />)
    picker().focus()
    await user.keyboard('{ArrowDown}')
    expect(listbox()).toHaveFocus()
    const active = (): string | null =>
      document.getElementById(listbox().getAttribute('aria-activedescendant') ?? '')?.textContent ??
      null
    expect(active()).toContain('Manuscript')
    await user.keyboard('{ArrowUp}')
    expect(active()).toBe('New category…')
    await user.keyboard('{Home}{ArrowDown}{ArrowDown}')
    expect(active()).toContain('Magic Systems')
    await user.keyboard('{Enter}')
    expect(current()).toBe('magic')
    expect(picker()).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(current()).toBe('magic')
  })

  it('keeps the current section listed even while it is unused', async () => {
    const user = userEvent.setup()
    useLayoutStore.getState().setSidebarTab('religion')
    render(<SidebarSections format="novel" sections={sections} />)
    expect(picker()).toHaveAccessibleName('Section: Religions')
    await user.click(picker())
    expect(optionNames()).toContain('Religions')
    expect(optionNames()).toContain('Show unused sections (1)')
  })

  it('reads F-9.2’s stored tab ids as their category sections, and an unknown id as the first', () => {
    useLayoutStore.getState().setSidebarTab('characters')
    const { unmount } = render(<SidebarSections format="novel" sections={sections} />)
    expect(picker()).toHaveAccessibleName('Section: Characters')
    unmount()
    useLayoutStore.getState().setSidebarTab('c-gone')
    render(<SidebarSections format="novel" sections={sections} />)
    expect(picker()).toHaveAccessibleName('Section: Manuscript')
  })

  it('opens the New category dialog from its item', async () => {
    const user = userEvent.setup()
    render(<SidebarSections format="novel" sections={sections} />)
    await user.click(picker())
    await user.click(within(listbox()).getByRole('option', { name: 'New category…' }))
    expect(useCategoryStore.getState().creating).toBe(true)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('SidebarSections with the old story bible archived (fresh start)', () => {
  beforeEach(() => {
    resetPendingSaves()
    resetLayoutStore()
    resetCategoryStore()
    resetEditorSettingsStore()
    setIpcClient(client)
  })

  afterEach(() => {
    resetLayoutStore()
    resetCategoryStore()
    resetEditorSettingsStore()
  })

  const fresh: readonly SidebarSection[] = [
    section({ id: 'manuscript', label: 'Manuscript', group: 'manuscript', count: 12 }),
    section({ id: 'notes', label: 'Notes', group: 'manuscript', icon: NotebookPen }),
    section({ id: 'outline', label: 'Outline', group: 'tools', icon: ListTree, under: 'notes' }),
    section({
      id: 'timeline',
      label: 'Timeline',
      group: 'tools',
      icon: CalendarRange,
      under: 'notes'
    }),
    section({ id: 'edits', label: 'Edits', group: 'tools', icon: FilePenLine, under: 'notes' })
  ]
  const archived = (): void => {
    useEditorSettingsStore.setState({ settings: defaultEditorSettings('novel') })
  }
  const tabs = (): HTMLElement => screen.getByRole('tablist', { name: 'Sections' })
  const tab = (name: string): HTMLElement => within(tabs()).getByRole('tab', { name })
  const panel = (): HTMLElement => screen.getByRole('tabpanel')

  it('shows Manuscript and Notes as two tabs on the controls’ row, and the picker once switched back on', async () => {
    const user = userEvent.setup()
    archived()
    const { unmount } = render(
      <SidebarSections
        format="novel"
        sections={fresh}
        controls={<button type="button">Move sidebar</button>}
      />
    )
    expect(
      within(tabs())
        .getAllByRole('tab')
        .map((t) => t.textContent)
    ).toEqual(['Manuscript', 'Notes'])
    expect(tabs().parentElement).toContainElement(
      screen.getByRole('button', { name: 'Move sidebar' })
    )
    expect(screen.queryByRole('button', { name: /^Section: / })).not.toBeInTheDocument()
    expect(tab('Manuscript')).toHaveAttribute('aria-selected', 'true')
    expect(panel()).toHaveAccessibleName('Manuscript')
    expect(panel()).toHaveTextContent('Manuscript here')
    await user.click(tab('Notes'))
    expect(current()).toBe('notes')
    expect(tab('Notes')).toHaveAttribute('aria-selected', 'true')
    expect(panel()).toHaveTextContent('Notes here')
    unmount()

    // The story bible switched back on: the picker as before, New category included.
    useEditorSettingsStore.setState({
      settings: { ...defaultEditorSettings('novel'), unarchived: ['storyBible'] }
    })
    render(<SidebarSections format="novel" sections={sections} />)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await user.click(picker())
    expect(optionNames()).toContain('New category…')
  })

  it('opens a view under Notes from its stored id, with a back row to the tree', async () => {
    const user = userEvent.setup()
    archived()
    useLayoutStore.getState().setSidebarTab('edits')
    render(<SidebarSections format="novel" sections={fresh} />)
    expect(tab('Notes')).toHaveAttribute('aria-selected', 'true')
    expect(panel()).toHaveAccessibleName('Notes')
    expect(within(panel()).getByRole('region', { name: 'Edits section' })).toHaveTextContent(
      'Edits here'
    )
    expect(panel()).not.toHaveTextContent('Notes here')
    await user.click(within(panel()).getByRole('button', { name: 'Back to Notes' }))
    expect(current()).toBe('notes')
    expect(panel()).toHaveTextContent('Notes here')
    expect(within(panel()).queryByRole('button', { name: 'Back to Notes' })).not.toBeInTheDocument()

    // The selected tab clicked while a view is open goes back to the tree as well.
    useLayoutStore.getState().setSidebarTab('timeline')
    expect(await within(panel()).findByText('Timeline here')).toBeInTheDocument()
    await user.click(tab('Notes'))
    expect(current()).toBe('notes')
  })

  it('moves between the tabs from the keyboard: Left/Right wrap, Home/End jump', async () => {
    const user = userEvent.setup()
    archived()
    useLayoutStore.getState().setSidebarTab('outline')
    render(<SidebarSections format="novel" sections={fresh} />)
    expect(tab('Notes')).toHaveAttribute('tabindex', '0')
    expect(tab('Manuscript')).toHaveAttribute('tabindex', '-1')
    tab('Notes').focus()
    await user.keyboard('{ArrowRight}')
    expect(current()).toBe('manuscript')
    expect(tab('Manuscript')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(current()).toBe('notes')
    expect(tab('Notes')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(current()).toBe('manuscript')
    await user.keyboard('{End}')
    expect(current()).toBe('notes')
  })

  it('opens a section for an id it lists in its aliases (the notes binder: old views archived)', () => {
    archived()
    useLayoutStore.getState().setSidebarTab('timeline')
    render(
      <SidebarSections
        format="novel"
        sections={[
          section({ id: 'manuscript', label: 'Manuscript', group: 'manuscript' }),
          section({
            id: 'notes',
            label: 'Notes',
            group: 'manuscript',
            icon: NotebookPen,
            aliases: ['outline', 'timeline']
          })
        ]}
      />
    )
    expect(tab('Notes')).toHaveAttribute('aria-selected', 'true')
    expect(panel()).toHaveTextContent('Notes here')
    expect(within(panel()).queryByRole('button', { name: 'Back to Notes' })).not.toBeInTheDocument()
  })

  it('opens an id with no section in the fresh start on the first tab', () => {
    archived()
    useLayoutStore.getState().setSidebarTab('character')
    render(<SidebarSections format="novel" sections={fresh} />)
    expect(tab('Manuscript')).toHaveAttribute('aria-selected', 'true')
    expect(panel()).toHaveTextContent('Manuscript here')
  })
})

describe('buildSections (F-9.11)', () => {
  const counts = {
    documents: 0,
    tags: 0,
    timeline: 0,
    edits: 0,
    library: 0,
    changes: 0,
    todo: 0,
    sheets: {},
    research: 0,
    records: {},
    notes: 0
  }
  const used = (built: SidebarSection[]): string[] => built.filter((s) => s.used).map((s) => s.id)

  it('lists Manuscript, Notes and Edits as tabs while the old story bible is archived (fresh start); the old views come back after Edits', () => {
    const busy = {
      ...counts,
      documents: 4,
      tags: 3,
      timeline: 1,
      edits: 1,
      library: 2,
      changes: 5,
      todo: 2,
      sheets: { character: 2, thread: 1 }
    }
    const built = buildSections(ALL_BUILTIN_CATEGORIES, busy, 'v1', { storyBibleArchived: true })
    // The notes binder (2026-10-16): the old Outline and Timeline views archived by default; their
    // stored ids open Notes.
    expect(built.map((s) => [s.id, s.used, s.under, s.aliases])).toEqual([
      ['manuscript', true, undefined, undefined],
      ['notes', true, undefined, ['outline', 'timeline']],
      ['edits', true, undefined, undefined]
    ])
    const empty = buildSections(ALL_BUILTIN_CATEGORIES, counts, 'v1', { storyBibleArchived: true })
    expect(empty.map((s) => s.used)).toEqual([true, true, true])
    const notes = empty.find((s) => s.id === 'notes')?.render('novel')
    expect(isValidElement(notes) ? notes.type : null).toBe(NotesTab)
    // Switched back on, they are tabs after Edits, always listed.
    const views = buildSections(ALL_BUILTIN_CATEGORIES, counts, 'v1', {
      storyBibleArchived: true,
      oldViewsArchived: false
    })
    expect(views.map((s) => [s.id, s.used, s.under, s.aliases, s.icon])).toEqual([
      ['manuscript', true, undefined, undefined, BookOpen],
      ['notes', true, undefined, undefined, NotebookPen],
      ['edits', true, undefined, undefined, FilePenLine],
      ['outline', true, undefined, undefined, ListTree],
      ['timeline', true, undefined, undefined, CalendarRange]
    ])
    // Switched back on, the list is v1's as it was; v2 never archives it.
    const ids = (built: SidebarSection[]): string[] => built.map((s) => s.id)
    expect(
      ids(buildSections(ALL_BUILTIN_CATEGORIES, busy, 'v1', { storyBibleArchived: false }))
    ).toEqual(ids(buildSections(ALL_BUILTIN_CATEGORIES, busy, 'v1')))
    expect(
      buildSections(ALL_BUILTIN_CATEGORIES, busy, 'v2', { storyBibleArchived: true }).map(
        (s) => s.id
      )
    ).toEqual(buildSections(ALL_BUILTIN_CATEGORIES, busy, 'v2').map((s) => s.id))
  })

  it('always uses Manuscript, Characters, Places, the Index, and To do; the rest once they hold something', () => {
    expect(used(buildSections(BUILTIN_CATEGORIES, counts, 'v1'))).toEqual([
      'manuscript',
      'notes',
      'character',
      'setting',
      'tags',
      'todo'
    ])
    const busy = buildSections(
      BUILTIN_CATEGORIES,
      {
        documents: 4,
        tags: 2,
        timeline: 1,
        edits: 1,
        library: 3,
        changes: 2,
        todo: 3,
        sheets: { magic: 2, world: 1 },
        research: 0,
        records: {},
        notes: 0
      },
      'v1'
    )
    expect(used(busy)).toEqual([
      'manuscript',
      'notes',
      'character',
      'setting',
      'world',
      'magic',
      'tags',
      'outline',
      'timeline',
      'library',
      'todo',
      'edits',
      'changes'
    ])
    expect(busy.find((s) => s.id === 'magic')).toMatchObject({
      label: 'Magic Systems',
      group: 'bible',
      count: 2
    })
    expect(busy.find((s) => s.id === 'manuscript')?.count).toBe(4)
  })

  it('lists a project category after the library, and a stray kind a sheet names', () => {
    const ships = categoryFromInput('c-ships', { name: 'Ships', fields: [] }, 'author')
    const built = buildSections(
      [...BUILTIN_CATEGORIES, ships],
      { ...counts, sheets: { 'c-ships': 1, 'c-gone': 1 } },
      'v1'
    )
    const bible = built.filter((s) => s.group === 'bible').map((s) => s.label)
    expect(bible.slice(-3)).toEqual(['Ships', 'c-gone', 'Index'])
    expect(used(built)).toEqual([
      'manuscript',
      'notes',
      'character',
      'setting',
      'c-ships',
      'c-gone',
      'tags',
      'todo'
    ])
  })

  it('shows Threads first of the tools once it has a thread, through the Threads section (F-9.14, F-9.15)', () => {
    const quiet = buildSections(ALL_BUILTIN_CATEGORIES, counts, 'v1')
    expect(quiet.find((s) => s.id === 'thread')).toMatchObject({ label: 'Threads', used: false })
    const built = buildSections(ALL_BUILTIN_CATEGORIES, { ...counts, sheets: { thread: 2 } }, 'v1')
    const threads = built.find((s) => s.id === 'thread')
    expect(threads).toMatchObject({ used: true, count: 2, group: 'tools' })
    const tools = built.filter((s) => s.group === 'tools').map((s) => s.id)
    expect(tools).toEqual(['thread', 'outline', 'timeline', 'library', 'todo', 'edits', 'changes'])
    const panel = threads?.render('novel')
    expect(isValidElement(panel) ? panel.type : null).toBe(ThreadsTab)
  })

  it('closes the story bible with the tags as its Index (F-9.15)', () => {
    const built = buildSections(ALL_BUILTIN_CATEGORIES, counts, 'v1')
    const bible = built.filter((s) => s.group === 'bible')
    expect(bible.at(-1)).toMatchObject({ id: 'tags', label: 'Index', used: true })
    expect(bible.map((s) => s.id)).not.toContain('thread')
    expect(built.map((s) => s.group)).toEqual(
      [...built.map((s) => s.group)].sort(
        (a, b) =>
          ['manuscript', 'bible', 'tools'].indexOf(a) - ['manuscript', 'bible', 'tools'].indexOf(b)
      )
    )
  })

  it('pins the v1 list: story memory v2 never changes it (P1 §0)', () => {
    const busy = { ...counts, sheets: { thread: 1, magic: 2 }, research: 3, records: { lore: 4 } }
    expect(
      buildSections(ALL_BUILTIN_CATEGORIES, busy, 'v1').map((s) => [
        s.id,
        s.label,
        s.group,
        s.count,
        s.used
      ])
    ).toMatchSnapshot()
  })

  it('lists story memory v2’s sections: Manuscript, record lists, Research, Outline, Edits (F-16.6)', () => {
    const ships = categoryFromInput('c-ships', { name: 'Ships', fields: [] }, 'author')
    const v2 = buildSections(
      [...ALL_BUILTIN_CATEGORIES, ships],
      { ...counts, research: 3, edits: 1, records: { character: 2, thread: 1, 'c-gone': 1 } },
      'v2'
    )
    const ids = v2.map((s) => s.id)
    expect(ids[0]).toBe('manuscript')
    expect(ids.slice(-3)).toEqual(['research', 'outline', 'edits'])
    for (const gone of ['tags', 'timeline', 'library', 'todo', 'changes']) {
      expect(ids).not.toContain(gone)
    }
    // Every category is a record list in the story bible, Threads included, then the strays,
    // then Secrets (F-16.22).
    const bible = v2.filter((s) => s.group === 'bible')
    expect(bible.map((s) => s.id)).toEqual([
      ...ALL_BUILTIN_CATEGORIES.map((c) => c.id),
      'c-ships',
      'c-gone',
      'secret'
    ])
    expect(v2.find((s) => s.id === 'character')).toMatchObject({ count: 2, used: true })
    expect(v2.find((s) => s.id === 'thread')).toMatchObject({ count: 1, used: true })
    expect(v2.find((s) => s.id === 'magic')).toMatchObject({ count: 0, used: false })
    const panel = v2.find((s) => s.id === 'thread')?.render('novel')
    expect(isValidElement(panel) ? panel.type : null).toBe(RecordTab)
    expect(isValidElement(panel) ? panel.props : null).toEqual({ categoryId: 'thread' })
    const research = v2.find((s) => s.id === 'research')
    expect(research).toMatchObject({ label: 'Research', used: true, count: 3, group: 'tools' })
    const page = research?.render('novel')
    expect(isValidElement(page) ? page.type : null).toBe(ResearchTab)
    expect(used(v2)).toEqual([
      'manuscript',
      'notes',
      'character',
      'setting',
      'thread',
      'c-gone',
      'research',
      'edits'
    ])
  })

  it('F-16.22: lists Secrets after the categories once a secret exists, never as a stray', () => {
    const row = (sections: SidebarSection[]): (string | number | boolean | null)[][] =>
      sections.map((s) => [s.id, s.label, s.group, s.count, s.used])
    const without = buildSections(ALL_BUILTIN_CATEGORIES, { ...counts, research: 1 }, 'v2')
    const withSecrets = buildSections(
      ALL_BUILTIN_CATEGORIES,
      { ...counts, research: 1, records: { character: 3, secret: 2 } },
      'v2'
    )
    expect(row(without)).toMatchSnapshot('v2 without secrets')
    expect(row(withSecrets)).toMatchSnapshot('v2 with secrets')
    const secrets = withSecrets.find((s) => s.id === 'secret')
    expect(secrets).toMatchObject({ label: 'Secrets', count: 2, used: true, group: 'bible' })
    expect(without.find((s) => s.id === 'secret')).toMatchObject({ count: 0, used: false })
    expect(withSecrets.filter((s) => s.id === 'secret')).toHaveLength(1)
    const ids = withSecrets.map((s) => s.id)
    expect(ids.indexOf('secret')).toBe(ids.indexOf('research') - 1)
    const panel = secrets?.render('novel')
    expect(isValidElement(panel) ? panel.type : null).toBe(RecordTab)
    expect(isValidElement(panel) ? panel.props : null).toEqual({ categoryId: 'secret' })
  })
})
