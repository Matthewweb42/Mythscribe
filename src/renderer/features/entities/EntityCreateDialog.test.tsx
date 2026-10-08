import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import type { EntityKind } from '@shared/entities'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EntityCreateDialog } from './EntityCreateDialog'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'

type Handler = (input: unknown) => unknown

/** `entity:create` answers with a stored row, like main does. */
function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'entity:list') return entityFixture as Output<C>
      if (channel === 'layout:set') return input as Output<C>
      if (channel === 'entity:create') {
        const value = input as Input<'entity:create'>
        const entity: Entity = {
          id: 'e-new',
          kind: value.kind,
          name: value.name.trim(),
          template: value.template ?? 'structured',
          fields: {},
          body: null,
          image: null,
          tagId: null,
          aliases: [],
          origin: 'author',
          created: '2026-09-23T08:00:00.000Z',
          modified: '2026-09-23T08:00:00.000Z'
        }
        return entity as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name })

/** Loads the bank, opens the dialog for `kind`, and renders it. */
async function open(
  kind: EntityKind,
  overrides: Partial<Record<Channel, Handler>> = {}
): Promise<[Channel, unknown][]> {
  const calls = install(overrides)
  await act(async () => {
    await useEntityStore.getState().load()
  })
  render(<EntityCreateDialog />)
  act(() => {
    useEntityStore.getState().startCreate(kind)
  })
  return calls
}

describe('EntityCreateDialog (F-9.3)', () => {
  beforeEach(() => {
    resetEntityStore()
    resetLayoutStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(() => {
    cleanup()
    resetLayoutStore()
  })

  it('is closed until a kind is being created, then asks for a name and a template', async () => {
    install()
    render(<EntityCreateDialog />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => {
      useEntityStore.getState().startCreate('character')
    })
    const form = dialog('New character')
    const name = within(form).getByRole('textbox', { name: 'Name' })
    expect(name).toHaveFocus()
    const structured = within(form).getByRole('radio', { name: /Structured/ })
    expect(structured).toBeChecked()
    expect(structured).toHaveAccessibleName(/One field for each part of the template/)
    expect(within(form).getByRole('radio', { name: /Blank page/ })).toHaveAccessibleName(
      /One free page/
    )
    expect(within(form).getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('creates the entity, opens its page, and shows the kind´s sidebar tab', async () => {
    const user = userEvent.setup()
    const calls = await open('world')
    const form = dialog('New world-building item')
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), '  Tides ')
    await user.click(within(form).getByRole('radio', { name: /Blank page/ }))
    await user.click(within(form).getByRole('button', { name: 'Create' }))
    expect(calls.at(-1)).toEqual([
      'entity:create',
      { kind: 'world', name: 'Tides', template: 'blank' }
    ])
    expect(useEntityStore.getState().selectedId).toBe('e-new')
    expect(useLayoutStore.getState().layout.sidebar).toMatchObject({ open: true, tab: 'world' })
    expect(useEntityStore.getState().creating).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the sidebar when it was closed, on the created kind´s tab', async () => {
    const user = userEvent.setup()
    await open('setting')
    act(() => {
      useLayoutStore.getState().toggle('sidebar')
    })
    expect(useLayoutStore.getState().layout.sidebar.open).toBe(false)
    const form = dialog('New setting')
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'The Harbour{Enter}')
    expect(useLayoutStore.getState().layout.sidebar).toMatchObject({
      open: true,
      tab: 'settings'
    })
  })

  it('a refused name toasts and keeps the dialog with what was typed', async () => {
    const user = userEvent.setup()
    await open('character', {
      'entity:create': () => {
        throw new IpcRequestError({
          code: 'ALREADY_EXISTS',
          message: 'A character named "Mara" already exists'
        })
      }
    })
    const form = dialog('New character')
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Mara{Enter}')
    expect(toasts()).toEqual(['A character named "Mara" already exists'])
    expect(dialog('New character')).toBeInTheDocument()
    expect(within(form).getByRole('textbox', { name: 'Name' })).toHaveValue('Mara')
    expect(useEntityStore.getState().selectedId).toBeNull()
  })

  it('Cancel, Escape, and a click on the backdrop close it without creating anything', async () => {
    const user = userEvent.setup()
    const calls = await open('character')
    await user.click(within(dialog('New character')).getByRole('button', { name: 'Cancel' }))
    expect(useEntityStore.getState().creating).toBeNull()

    act(() => {
      useEntityStore.getState().startCreate('character')
    })
    await user.type(within(dialog('New character')).getByRole('textbox', { name: 'Name' }), 'x')
    await user.keyboard('{Escape}')
    expect(useEntityStore.getState().creating).toBeNull()

    act(() => {
      useEntityStore.getState().startCreate('character')
    })
    const backdrop = dialog('New character').parentElement
    if (!backdrop) throw new Error('no backdrop')
    await user.click(backdrop)
    expect(useEntityStore.getState().creating).toBeNull()
    expect(calls.some(([channel]) => channel === 'entity:create')).toBe(false)
    // A reopened dialog starts empty, not on the abandoned name.
    act(() => {
      useEntityStore.getState().startCreate('character')
    })
    expect(within(dialog('New character')).getByRole('textbox', { name: 'Name' })).toHaveValue('')
  })
})
