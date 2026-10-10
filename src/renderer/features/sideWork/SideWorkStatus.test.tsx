import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetFocusStore } from '@renderer/features/focus/focusStore'
import { contextReviewFixture } from '@renderer/features/library/libraryFixture'
import { resetLibraryStore, useLibraryStore } from '@renderer/features/library/libraryStore'
import { resetOrganiseStore, useOrganiseStore } from '@renderer/features/organise/organiseStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { SideWorkBar, SideWorkStatus } from './SideWorkStatus'

beforeEach(() => {
  setIpcClient({
    async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
      // Opening the assistant column writes the layout (debounced).
      if (channel === 'layout:set') return null as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
  resetOrganiseStore()
  resetLibraryStore()
  resetLayoutStore()
  resetFocusStore()
})
afterEach(() => {
  resetLayoutStore()
  resetOrganiseStore()
  resetLibraryStore()
})

const closeAssistant = (): void => {
  const layout = useLayoutStore.getState().layout
  useLayoutStore.setState({
    layout: { ...layout, assistant: { ...layout.assistant, open: false } }
  })
}

describe('SideWorkStatus (2026-10-10, side work)', () => {
  it('shows nothing while no run is under way', () => {
    const { container } = render(
      <>
        <SideWorkStatus />
        <SideWorkBar />
      </>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('says Organising… while the plan is worked out, then Ready to review, and a click shows it in the assistant column', async () => {
    useOrganiseStore.setState({ open: true, phase: 'running' })
    closeAssistant()
    render(<SideWorkStatus />)
    const item = screen.getByTestId('side-work-organise')
    expect(item).toHaveTextContent('Organising…')
    expect(item).toHaveAttribute('aria-pressed', 'false')
    act(() => useOrganiseStore.setState({ phase: 'ready' }))
    expect(item).toHaveTextContent('Organise: ready to review')
    await userEvent.click(item)
    expect(useOrganiseStore.getState().shown).toBe(true)
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
    expect(item).toHaveAttribute('aria-pressed', 'true')
    // A second click goes back to the conversation; the plan stays.
    await userEvent.click(item)
    expect(useOrganiseStore.getState()).toMatchObject({ shown: false, open: true })
  })

  it('shows the upload’s progress and failure, and one piece of side work at a time', async () => {
    useOrganiseStore.setState({ open: true, phase: 'failed', shown: true })
    useLibraryStore.setState({
      flow: {
        stage: 'running',
        fileIds: ['f1'],
        requestId: 'lib-1',
        estimate: {
          files: 1,
          chunks: 2,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          priced: true,
          model: 'm'
        },
        progress: { done: 1, total: 2, costUsd: 0.01 }
      }
    })
    render(<SideWorkBar />)
    expect(screen.getByTestId('side-work-bar')).toBeInTheDocument()
    expect(screen.getByTestId('side-work-organise')).toHaveTextContent('Organise failed')
    const upload = screen.getByTestId('side-work-upload')
    expect(upload).toHaveTextContent('Sorting uploads · 1 of 2')
    await userEvent.click(upload)
    expect(useLibraryStore.getState().shown).toBe(true)
    expect(useOrganiseStore.getState().shown).toBe(false)
    act(() =>
      useLibraryStore.setState({
        flow: { stage: 'review', review: contextReviewFixture(), busy: false, decisions: {} }
      })
    )
    expect(upload).toHaveTextContent('Upload: ready to review')
  })
})
