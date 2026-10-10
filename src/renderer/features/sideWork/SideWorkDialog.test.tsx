import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetOrganiseStore, useOrganiseStore } from '@renderer/features/organise/organiseStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { SideWorkDialog } from './SideWorkDialog'
import { resetSideWorkPlace, showSideWork, useShownSideWork } from './sideWork'

beforeEach(() => {
  setIpcClient({
    async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
  resetOrganiseStore()
  resetSideWorkPlace()
})
afterEach(() => {
  resetOrganiseStore()
  resetSideWorkPlace()
})

function ColumnProbe(): React.JSX.Element {
  const work = useShownSideWork()
  return <span data-testid="column">{work ?? 'conversation'}</span>
}

describe('SideWorkDialog (F-7.12)', () => {
  it('shows the run in the big dialog, not in the column, and Escape only hides it', async () => {
    useOrganiseStore.setState({ open: true, phase: 'failed', error: 'No key.' })
    const editor = document.createElement('button')
    document.body.append(editor)
    editor.focus()
    render(
      <>
        <SideWorkDialog />
        <ColumnProbe />
      </>
    )
    expect(screen.queryByTestId('side-work-dialog')).toBeNull()
    act(() => showSideWork('organise', 'dialog'))
    const dialog = screen.getByTestId('side-work-dialog')
    expect(within(dialog).getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByTestId('organise-error')).toHaveTextContent('No key.')
    expect(screen.getByTestId('column')).toHaveTextContent('conversation')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('side-work-dialog')).toBeNull()
    // The run stays under its status-bar item; the focus is back where the author was.
    expect(useOrganiseStore.getState()).toMatchObject({ open: true, shown: false, phase: 'failed' })
    expect(document.activeElement).toBe(editor)
    editor.remove()
  })

  it('goes back to writing from its button, and the status bar shows the same run in the column', async () => {
    useOrganiseStore.setState({ open: true, phase: 'failed', error: 'No key.' })
    render(
      <>
        <SideWorkDialog />
        <ColumnProbe />
      </>
    )
    act(() => showSideWork('organise', 'dialog'))
    await userEvent.click(screen.getByRole('button', { name: /Back to writing/ }))
    expect(screen.queryByTestId('side-work-dialog')).toBeNull()
    act(() => showSideWork('organise'))
    expect(screen.queryByTestId('side-work-dialog')).toBeNull()
    expect(screen.getByTestId('column')).toHaveTextContent('organise')
  })
})
