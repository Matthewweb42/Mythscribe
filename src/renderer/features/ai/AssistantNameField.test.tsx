import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeAssistantName } from '@shared/assistantName'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { defaultViewSettings, type ViewSettings } from '@shared/zoom'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetViewStore, useViewStore } from '@renderer/features/shell/viewStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { AssistantNameField } from './AssistantNameField'

let view: ViewSettings
let calls: { channel: Channel; input: unknown }[]

beforeEach(async () => {
  view = defaultViewSettings()
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push({ channel, input })
      if (channel === 'view:setAssistantName') {
        const { name } = input as { name: string }
        view = { ...view, assistantName: normalizeAssistantName(name) }
      }
      return view as Output<C>
    },
    on: () => () => {}
  })
  resetViewStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  await useViewStore.getState().load()
})

afterEach(() => {
  resetViewStore()
})

const field = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Assistant name' })

describe('AssistantNameField (F-7.12)', () => {
  it('shows Ms Scribe, renames on Enter, and goes back to Ms Scribe when cleared', async () => {
    render(<AssistantNameField />)
    expect(field()).toHaveValue('Ms Scribe')
    expect(field()).toHaveAttribute('maxLength', '24')
    await userEvent.clear(field())
    await userEvent.type(field(), 'Quill{Enter}')
    expect(calls.at(-1)).toEqual({ channel: 'view:setAssistantName', input: { name: 'Quill' } })
    expect(field()).toHaveValue('Quill')
    expect(useViewStore.getState().assistantName).toBe('Quill')
    await userEvent.clear(field())
    await userEvent.tab()
    expect(field()).toHaveValue('Ms Scribe')
  })

  it('writes nothing for an unchanged name', async () => {
    render(<AssistantNameField />)
    await userEvent.type(field(), ' {Enter}')
    expect(calls.filter((c) => c.channel === 'view:setAssistantName')).toEqual([])
    expect(field()).toHaveValue('Ms Scribe')
  })
})
