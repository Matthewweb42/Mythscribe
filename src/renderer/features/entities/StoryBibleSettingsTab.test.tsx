import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinCategory } from '@shared/categories'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { defaultStoryBibleSettings } from '@shared/storyBibleSettings'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetCategoryStore, useCategoryStore } from './categoryStore'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'
import { resetStoryBibleSettingsStore, useStoryBibleSettingsStore } from './storyBibleSettingsStore'
import { StoryBibleSettingsTab } from './StoryBibleSettingsTab'

function install(): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'storyBible:get') return defaultStoryBibleSettings() as Output<C>
      if (channel === 'entity:list') return entityFixture as Output<C>
      if (channel === 'category:setFields') {
        const { id, fields } = input as Input<'category:setFields'>
        const current = builtinCategory(id)
        if (current === undefined) throw new Error('unknown category')
        return {
          category: {
            ...current,
            fields: [
              ...fields.map((field) => ({ ...field, id: field.id ?? 'weapon' })),
              { id: 'notes', label: 'Notes', multiline: true }
            ]
          },
          entities: []
        } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

async function renderTab(): Promise<[Channel, unknown][]> {
  const calls = install()
  await act(async () => {
    await useStoryBibleSettingsStore.getState().load()
    await useEntityStore.getState().load()
  })
  render(<StoryBibleSettingsTab />)
  return calls
}

const settings = () => useStoryBibleSettingsStore.getState().settings

describe('StoryBibleSettingsTab (F-9.19)', () => {
  beforeEach(() => {
    resetStoryBibleSettingsStore()
    resetCategoryStore()
    resetEntityStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(() => {
    cleanup()
    resetStoryBibleSettingsStore()
  })

  it('sets the view new sheets open in', async () => {
    const user = userEvent.setup()
    await renderTab()
    expect(screen.getByRole('radio', { name: 'Structured' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'Blank page' }))
    expect(settings()?.defaultTemplate).toBe('blank')
  })

  it('sets the write-up style of the category: the length and each field’s role', async () => {
    const user = userEvent.setup()
    await renderTab()
    expect(screen.getByRole('combobox', { name: 'How Age shows on the page' })).toHaveValue(
      'paragraph'
    )
    expect(screen.getByRole('combobox', { name: 'How Appearance shows on the page' })).toHaveValue(
      'heading'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'How Age shows on the page' }),
      'heading'
    )
    await user.click(screen.getByRole('radio', { name: 'Long' }))
    expect(settings()?.writeUp.character).toEqual({ length: 'long', roles: { age: 'heading' } })
    // Another category has its own style.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'setting')
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked()
  })

  it('renames, reorders, and adds fields, and saves them to the category', async () => {
    const user = userEvent.setup()
    const calls = await renderTab()
    const age = screen.getByRole('textbox', { name: 'Field 1 name' })
    await user.clear(age)
    await user.type(age, 'Years')
    await user.click(screen.getByRole('button', { name: 'Move Born (story year) up' }))
    await user.type(screen.getByRole('textbox', { name: 'New field name' }), 'Weapon')
    await user.click(screen.getByRole('button', { name: 'Add field' }))
    await user.click(screen.getByRole('button', { name: 'Save fields' }))
    const [, input] = calls.find(([channel]) => channel === 'category:setFields') ?? []
    const sent = input as Input<'category:setFields'>
    expect(sent.id).toBe('character')
    expect(sent.fields.slice(0, 2)).toEqual([
      { id: 'born', label: 'Born (story year)', multiline: false },
      { id: 'age', label: 'Years', multiline: false }
    ])
    expect(sent.fields.at(-1)).toEqual({ label: 'Weapon', multiline: true })
    expect(
      useCategoryStore.getState().categories.find((c) => c.id === 'character')?.fields[1]
    ).toEqual({ id: 'age', label: 'Years', multiline: false })
  })

  it('asks before removing a field that sheets have text in, naming where it goes', async () => {
    const user = userEvent.setup()
    const calls = await renderTab()
    await user.click(screen.getByRole('button', { name: 'Remove Age' }))
    await user.click(screen.getByRole('button', { name: 'Save fields' }))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
    expect(modal.options.message).toContain('moves into each sheet')
    act(() => useDialogStore.getState().resolveConfirm(modal.id, false))
    expect(calls.some(([channel]) => channel === 'category:setFields')).toBe(false)
  })
})
