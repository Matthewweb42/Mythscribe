import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BookOpen, Tag, Users } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetLayoutStore, useLayoutStore } from './layoutStore'
import { SidebarTabs } from './SidebarTabs'
import type { SidebarTab } from './sidebarTabs'

const tabs: readonly [SidebarTab, ...SidebarTab[]] = [
  { id: 'manuscript', label: 'Manuscript', icon: BookOpen, render: () => <p>tree here</p> },
  { id: 'characters', label: 'Characters', icon: Users, render: () => <p>cast here</p> },
  { id: 'tags', label: 'Tags', icon: Tag, render: () => <p>bank here</p> }
]

const tab = (name: string): HTMLElement => screen.getByRole('tab', { name })
const panel = (): HTMLElement => screen.getByRole('tabpanel')
const activeTab = (): string => useLayoutStore.getState().layout.sidebar.tab

/** Accepts every `layout:set` as written and counts it; anything else is unexpected here. */
let writes = 0
const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    if (channel === 'layout:set') {
      writes++
      const value = input as Input<'layout:set'>
      return value as Output<C>
    }
    throw new Error(`unexpected ${channel}`)
  },
  on: () => () => {}
}

describe('SidebarTabs (F-7.3)', () => {
  beforeEach(() => {
    resetPendingSaves()
    resetLayoutStore()
    writes = 0
    setIpcClient(client)
  })

  afterEach(() => {
    resetLayoutStore()
    vi.useRealTimers()
  })

  it('renders the tabs as an ARIA tablist with the stored tab selected and its panel shown', () => {
    render(<SidebarTabs format="novel" tabs={tabs} />)
    expect(screen.getByRole('tablist', { name: 'Sidebar' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Manuscript',
      'Characters',
      'Tags'
    ])
    expect(tab('Manuscript')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Manuscript')).toHaveAttribute('tabindex', '0')
    expect(tab('Characters')).toHaveAttribute('aria-selected', 'false')
    expect(tab('Characters')).toHaveAttribute('tabindex', '-1')
    expect(panel()).toHaveAccessibleName('Manuscript')
    expect(panel()).toHaveTextContent('tree here')
    expect(tab('Manuscript')).toHaveAttribute('aria-controls', panel().id)
  })

  it('ships only the Manuscript tab by default, so there is no placeholder to click', () => {
    render(<SidebarTabs format="novel" />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Manuscript'])
    expect(panel()).toHaveAccessibleName('Manuscript')
  })

  it('clicking a tab shows its panel and records the tab in the layout', async () => {
    const user = userEvent.setup()
    render(<SidebarTabs format="novel" tabs={tabs} />)
    await user.click(tab('Tags'))
    expect(tab('Tags')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Manuscript')).toHaveAttribute('aria-selected', 'false')
    expect(panel()).toHaveTextContent('bank here')
    expect(panel()).toHaveAccessibleName('Tags')
    expect(activeTab()).toBe('tags')
  })

  it('the arrow keys wrap, Home and End jump, and focus follows the selection', async () => {
    const user = userEvent.setup()
    render(<SidebarTabs format="novel" tabs={tabs} />)
    tab('Manuscript').focus()
    await user.keyboard('{ArrowRight}')
    expect(activeTab()).toBe('characters')
    expect(tab('Characters')).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(activeTab()).toBe('manuscript')
    expect(tab('Manuscript')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(activeTab()).toBe('tags')
    expect(tab('Tags')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(activeTab()).toBe('manuscript')
    await user.keyboard('{End}')
    expect(activeTab()).toBe('tags')
    expect(panel()).toHaveTextContent('bank here')
  })

  it('a stored tab that is not registered falls back to the first tab without writing', () => {
    vi.useFakeTimers()
    useLayoutStore.setState((s) => ({
      layout: { ...s.layout, sidebar: { ...s.layout.sidebar, tab: 'timeline' } }
    }))
    render(<SidebarTabs format="novel" tabs={tabs} />)
    expect(tab('Manuscript')).toHaveAttribute('aria-selected', 'true')
    expect(panel()).toHaveTextContent('tree here')
    expect(activeTab()).toBe('timeline')
    vi.advanceTimersByTime(5000)
    expect(writes).toBe(0)
  })
})
