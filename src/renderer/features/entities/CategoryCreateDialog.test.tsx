import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALL_BUILTIN_CATEGORIES,
  BUILTIN_CATEGORIES,
  categoryFromInput,
  fieldLabelsOf,
  type NewCategoryInput
} from '@shared/categories'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { CategoryCreateDialog } from './CategoryCreateDialog'
import { getCategory, resetCategoryStore, useCategoryStore } from './categoryStore'

let created: NewCategoryInput[] = []
let refuse = false

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    if (channel === 'layout:set') return input as Output<C>
    if (channel === 'category:list') {
      const ships = categoryFromInput('c-ships', { name: 'Ships', fields: ['Crew'] }, 'author')
      return [...BUILTIN_CATEGORIES, ships] as Output<C>
    }
    if (channel === 'category:create') {
      const value = input as Input<'category:create'>
      created.push(value)
      if (refuse)
        throw new IpcRequestError({
          code: 'ALREADY_EXISTS',
          message: 'A category named "Ships" already exists'
        })
      return categoryFromInput('c-guilds', value, 'author') as Output<C>
    }
    if (channel === 'category:update') {
      const value = input as Input<'category:update'>
      return { ...getCategory(value.id), name: value.name ?? '' } as Output<C>
    }
    throw new Error(`unexpected ${channel}`)
  },
  on: () => () => {}
}

beforeEach(() => {
  resetPendingSaves()
  resetLayoutStore()
  resetCategoryStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  created = []
  refuse = false
  setIpcClient(client)
})
afterEach(() => {
  resetLayoutStore()
  resetCategoryStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('categoryStore (F-9.11)', () => {
  it('stands in with the library, loads the project’s list, renames in place, and clears', async () => {
    expect(useCategoryStore.getState().categories).toBe(ALL_BUILTIN_CATEGORIES)
    await useCategoryStore.getState().load()
    expect(getCategory('c-ships').name).toBe('Ships')
    await useCategoryStore.getState().update('setting', { name: 'Locations' })
    expect(getCategory('setting').name).toBe('Locations')
    useCategoryStore.getState().clear()
    expect(getCategory('setting').name).toBe('Places')
    expect(getCategory('c-ships').name).toBe('c-ships')
  })
})

describe('CategoryCreateDialog (F-9.11)', () => {
  it('reads one field per line, blank lines dropped', () => {
    expect(fieldLabelsOf(' Seat \n\nMotto\n')).toEqual(['Seat', 'Motto'])
  })

  it('creates the category with its fields and shows its section', async () => {
    const user = userEvent.setup()
    useCategoryStore.getState().startCreate()
    render(<CategoryCreateDialog />)
    const dialog = screen.getByRole('dialog', { name: 'New category' })
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Guilds')
    expect(screen.getByRole('textbox', { name: 'One of them is called' })).toHaveAttribute(
      'placeholder',
      'guild'
    )
    await user.click(screen.getByRole('button', { name: 'crown' }))
    await user.type(
      screen.getByRole('textbox', { name: /Fields, one per line/ }),
      'Seat{Enter}Motto'
    )
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(created).toEqual([{ name: 'Guilds', icon: 'crown', fields: ['Seat', 'Motto'] }])
    expect(dialog).not.toBeInTheDocument()
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('c-guilds')
    expect(getCategory('c-guilds').name).toBe('Guilds')
  })

  it('keeps the dialog and toasts a refusal', async () => {
    const user = userEvent.setup()
    refuse = true
    useCategoryStore.getState().startCreate()
    render(<CategoryCreateDialog />)
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ships')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('dialog', { name: 'New category' })).toBeInTheDocument()
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      'A category named "Ships" already exists'
    ])
  })

  it('closes on Escape without creating anything', async () => {
    const user = userEvent.setup()
    useCategoryStore.getState().startCreate()
    render(<CategoryCreateDialog />)
    await user.keyboard('{Escape}')
    expect(useCategoryStore.getState().creating).toBe(false)
    expect(created).toEqual([])
  })
})
