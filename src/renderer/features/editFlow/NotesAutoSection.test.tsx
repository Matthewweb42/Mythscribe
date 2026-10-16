import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import type { NotesAutoSettings } from '@shared/editFlow'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetAccountStore } from '@renderer/features/account/accountStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetAiStore } from '@renderer/features/ai/aiStore'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { NotesAutoSection } from './NotesAutoSection'
import { resetEditFlowStore } from './editFlowStore'

/** Settings › AI's automatic notes update (notes redesign phase 3): the switch, its price, the cap. */

let stored: NotesAutoSettings
let writes: NotesAutoSettings[]
let requests: number

beforeEach(() => {
  stored = { on: false, dailyCap: 10 }
  writes = []
  requests = 4
  resetEditFlowStore()
  resetAiSettingsStore()
  resetAiStore()
  resetAccountStore()
  useProjectStore.setState({ current: null })
  useDialogStore.setState({ modals: [], toasts: [] })
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
  setIpcClient({
    invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      switch (channel) {
        case 'editFlow:autoSettings':
          return Promise.resolve(stored as Output<C>)
        case 'editFlow:setAutoSettings':
          writes.push(input as NotesAutoSettings)
          stored = input as NotesAutoSettings
          return Promise.resolve(stored as Output<C>)
        case 'editFlow:plan':
          return Promise.resolve({
            scopeTitle: 'the whole book',
            scenes: 8,
            words: 23_000,
            requests,
            tokensIn: 160_000,
            tokensOut: 4_000
          } as Output<C>)
        default:
          return Promise.reject(new Error(`unexpected ${channel}`))
      }
    },
    on: () => () => {}
  })
})

afterEach(() => {
  resetEditFlowStore()
  resetAiSettingsStore()
  resetAiStore()
  resetAccountStore()
  setIpcClient(null)
})

describe('NotesAutoSection', () => {
  it('shows the switch off by default with the price of one chapter, and turns it on', async () => {
    render(<NotesAutoSection />)
    const toggle = await screen.findByRole('switch', {
      name: 'Update my notes after I finish a chapter'
    })
    expect(toggle).not.toBeChecked()
    await waitFor(() =>
      expect(screen.getByTestId('notes-auto-price').textContent).toMatch(/^About .+ a chapter on /)
    )
    await userEvent.click(toggle)
    expect(writes).toEqual([{ on: true, dailyCap: 10 }])
    await waitFor(() => expect(toggle).toBeChecked())
  })

  it('commits a cap from 1 to 50 and puts anything else back', async () => {
    render(<NotesAutoSection />)
    const cap = await screen.findByRole('spinbutton', { name: 'Updates a day, at most' })
    expect(cap).toHaveValue(10)
    fireEvent.change(cap, { target: { value: '60' } })
    fireEvent.blur(cap)
    expect(writes).toEqual([])
    expect(cap).toHaveValue(10)
    fireEvent.change(cap, { target: { value: '3' } })
    fireEvent.keyDown(cap, { key: 'Enter' })
    expect(writes).toEqual([{ on: false, dailyCap: 3 }])
    await waitFor(() => expect(cap).toHaveValue(3))
  })

  it('says when the book has no text to price yet', async () => {
    requests = 0
    render(<NotesAutoSection />)
    expect(
      await screen.findByText('The price per chapter shows once the book has text.')
    ).toBeTruthy()
  })
})
