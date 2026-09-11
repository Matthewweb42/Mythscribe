import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RecentProject } from '@shared/ipc/contract'
import { RecentProjects } from './RecentProjects'

const recents: RecentProject[] = [
  {
    path: '/tmp/Smoke Novel.mythscribe',
    name: 'Smoke Novel',
    format: 'webnovel',
    lastOpened: '2026-09-10T12:00:00.000Z',
    exists: true
  },
  {
    path: '/tmp/Gone.mythscribe',
    name: 'Gone',
    format: 'novel',
    lastOpened: '2026-09-09T12:00:00.000Z',
    exists: false
  }
]

describe('RecentProjects', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(
      <RecentProjects recents={[]} busy={false} onOpen={() => {}} onRemove={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders name, format label, path, and a Not found badge for missing rows', () => {
    render(<RecentProjects recents={recents} busy={false} onOpen={() => {}} onRemove={() => {}} />)
    const list = screen.getByRole('list', { name: 'Recent projects' })
    expect(list).toBeInTheDocument()
    const row = screen.getByRole('button', { name: 'Smoke Novel' })
    expect(row).toHaveTextContent('Web novel')
    expect(row).toHaveTextContent('/tmp/Smoke Novel.mythscribe')
    expect(row).not.toHaveTextContent('Not found')
    expect(screen.getByRole('button', { name: 'Gone' })).toHaveTextContent('Not found')
  })

  it('calls onOpen and onRemove with the row path', async () => {
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    render(<RecentProjects recents={recents} busy={false} onOpen={onOpen} onRemove={onRemove} />)
    await userEvent.click(screen.getByRole('button', { name: 'Smoke Novel' }))
    expect(onOpen).toHaveBeenCalledWith('/tmp/Smoke Novel.mythscribe')
    await userEvent.click(screen.getByRole('button', { name: 'Remove Gone from recent projects' }))
    expect(onRemove).toHaveBeenCalledWith('/tmp/Gone.mythscribe')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('disables every button while busy', () => {
    render(<RecentProjects recents={recents} busy onOpen={() => {}} onRemove={() => {}} />)
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })
})
