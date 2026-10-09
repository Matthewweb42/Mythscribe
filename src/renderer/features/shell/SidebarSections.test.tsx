import { isValidElement } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BookOpen, Sparkles, Tag, Users } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALL_BUILTIN_CATEGORIES, BUILTIN_CATEGORIES, categoryFromInput } from '@shared/categories'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetCategoryStore, useCategoryStore } from '@renderer/features/entities/categoryStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { ThreadsTab } from '@renderer/features/threads/ThreadsTab'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetLayoutStore, useLayoutStore } from './layoutStore'
import { SidebarSections } from './SidebarSections'
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

describe('buildSections (F-9.11)', () => {
  const counts = {
    documents: 0,
    tags: 0,
    timeline: 0,
    edits: 0,
    library: 0,
    changes: 0,
    todo: 0,
    sheets: {}
  }
  const used = (built: SidebarSection[]): string[] => built.filter((s) => s.used).map((s) => s.id)

  it('always uses Manuscript, Characters, Places, Tags, and To do; the rest once they hold something', () => {
    expect(used(buildSections(BUILTIN_CATEGORIES, counts))).toEqual([
      'manuscript',
      'character',
      'setting',
      'tags',
      'todo'
    ])
    const busy = buildSections(BUILTIN_CATEGORIES, {
      documents: 4,
      tags: 2,
      timeline: 1,
      edits: 1,
      library: 3,
      changes: 2,
      todo: 3,
      sheets: { magic: 2, world: 1 }
    })
    expect(used(busy)).toEqual([
      'manuscript',
      'character',
      'setting',
      'world',
      'magic',
      'tags',
      'timeline',
      'outline',
      'edits',
      'library',
      'todo',
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
    const built = buildSections([...BUILTIN_CATEGORIES, ships], {
      ...counts,
      sheets: { 'c-ships': 1, 'c-gone': 1 }
    })
    const bible = built.filter((s) => s.group === 'bible').map((s) => s.label)
    expect(bible.slice(-2)).toEqual(['Ships', 'c-gone'])
    expect(used(built)).toEqual([
      'manuscript',
      'character',
      'setting',
      'c-ships',
      'c-gone',
      'tags',
      'todo'
    ])
  })

  it('shows Threads after the library once it has a thread, through the Threads section (F-9.14)', () => {
    const quiet = buildSections(ALL_BUILTIN_CATEGORIES, counts)
    expect(quiet.find((s) => s.id === 'thread')).toMatchObject({ label: 'Threads', used: false })
    const built = buildSections(ALL_BUILTIN_CATEGORIES, { ...counts, sheets: { thread: 2 } })
    const threads = built.find((s) => s.id === 'thread')
    expect(threads).toMatchObject({ used: true, count: 2, group: 'bible' })
    const bible = built.filter((s) => s.group === 'bible').map((s) => s.id)
    expect(bible.at(-1)).toBe('thread')
    const panel = threads?.render('novel')
    expect(isValidElement(panel) ? panel.type : null).toBe(ThreadsTab)
  })
})
