import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORLD_CATEGORY_SUGGESTIONS } from '@shared/entities'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EntityEditor } from './EntityEditor'
import { resetEntityDraftStore, useEntityDraftStore } from './entityDraftStore'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'

type Handler = (input: unknown) => unknown

/** Answers the mutations the page uses the way main does; records every call. */
function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'entity:list') return entityFixture as Output<C>
      if (channel === 'entity:update') {
        const patch = input as Input<'entity:update'>
        const stored = useEntityStore.getState().byId[patch.id]
        if (!stored) throw new Error('unknown entity')
        const merged: Entity = {
          ...stored,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.template === undefined ? {} : { template: patch.template }),
          ...(patch.body === undefined ? {} : { body: patch.body }),
          fields: { ...stored.fields, ...patch.fields }
        }
        return merged as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const failing = (message: string) => (): never => {
  throw new IpcRequestError({ code: 'INTERNAL', message })
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const page = (): HTMLElement => screen.getByTestId('entity-editor')
const field = (label: string): HTMLElement => screen.getByRole('textbox', { name: label })

/** Loads the bank, selects `id`, and renders its page. */
async function openPage(
  id: string,
  overrides: Partial<Record<Channel, Handler>> = {}
): Promise<[Channel, unknown][]> {
  const calls = install(overrides)
  await act(async () => {
    await useEntityStore.getState().load()
  })
  useEntityStore.getState().select(id)
  render(<EntityEditor id={id} />)
  return calls
}

/** Writes what the draft holds, without waiting for its debounce. */
async function flushDraft(): Promise<void> {
  await act(async () => {
    await useEntityDraftStore.getState().flush()
  })
}

describe('EntityEditor (F-9.3)', () => {
  beforeEach(() => {
    resetPendingSaves()
    resetEntityDraftStore()
    resetEntityStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(() => {
    cleanup()
    resetEntityDraftStore()
    resetPendingSaves()
  })

  it('shows the name, what the entity is, and the kind´s fields with their stored values', async () => {
    await openPage('e-mara')
    expect(screen.getByRole('article', { name: 'Mara' })).toBe(page())
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Mara')
    expect(page()).toHaveTextContent('Character · Structured')
    expect(field('Age')).toHaveValue('27')
    expect(field('Appearance')).toHaveValue('Tall, with a scar across her left palm.')
    expect(field('Goals / motivations')).toHaveValue('')
    expect(screen.queryByRole('textbox', { name: 'Page' })).toBeNull()
    expect(useEntityDraftStore.getState().draft?.id).toBe('e-mara')
  })

  it('an edited field is written with only what changed, and the status line says so', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    await user.type(field('Age'), '!')
    expect(useEntityDraftStore.getState().draft?.fields.age).toBe('27!')
    await flushDraft()
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-mara', fields: { age: '27!' } }])
    expect(within(page()).getByRole('status')).toHaveTextContent('Saved')
  })

  it('a rename follows into the page´s own label and the store', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    const name = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'Mara Vell')
    await flushDraft()
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-mara', name: 'Mara Vell' }])
    expect(screen.getByRole('article', { name: 'Mara Vell' })).toBeInTheDocument()
  })

  it('Close leaves the page, and the entity keeps its edits', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    await user.type(field('Age'), '!')
    await user.click(screen.getByRole('button', { name: 'Close Mara' }))
    expect(useEntityStore.getState().selectedId).toBeNull()
    cleanup() // the pane drops the page, which writes what was pending
    await act(async () => {
      await Promise.resolve()
    })
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-mara', fields: { age: '27!' } }])
  })

  it('the template toggle writes the pending edits first, then switches the page', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara')
    const toggle = within(page()).getByRole('group', { name: 'Template' })
    expect(within(toggle).getByRole('button', { name: 'Structured' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await user.type(field('Age'), '!')
    await user.click(within(toggle).getByRole('button', { name: 'Blank page' }))
    expect(calls.map(([, input]) => input).slice(-2)).toEqual([
      { id: 'e-mara', fields: { age: '27!' } },
      { id: 'e-mara', template: 'blank' }
    ])
    expect(screen.getByRole('textbox', { name: 'Page' })).toHaveValue('')
    expect(page()).toHaveTextContent('Character · Blank page')
  })

  it('a blank-page entity writes its page, not fields', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-aldous')
    const body = screen.getByRole('textbox', { name: 'Page' })
    expect(body).toHaveValue('The old cartographer who taught Mara to read the stars.')
    await user.clear(body)
    await user.type(body, 'A mapmaker.')
    await flushDraft()
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-aldous', body: 'A mapmaker.' }])
    expect(screen.queryByRole('textbox', { name: 'Age' })).toBeNull()
  })

  it('a world item offers the category suggestions and has no image block', async () => {
    await openPage('e-blood')
    // An input with a `list` is a combobox, not a plain text box.
    const category = screen.getByRole('combobox', { name: 'Category' })
    const listId = category.getAttribute('list')
    expect(listId).not.toBeNull()
    const datalist = page().querySelector(`datalist#${CSS.escape(listId ?? '')}`)
    expect([...(datalist?.querySelectorAll('option') ?? [])].map((o) => o.value)).toEqual([
      ...WORLD_CATEGORY_SUGGESTIONS
    ])
    expect(screen.queryByRole('button', { name: 'Add image…' })).toBeNull()
  })

  it('Add image… asks main for a file; a cancelled dialog changes nothing', async () => {
    const user = userEvent.setup()
    const calls = await openPage('e-mara', { 'entity:setImage': () => null })
    await user.click(screen.getByRole('button', { name: 'Add image…' }))
    expect(calls.at(-1)).toEqual(['entity:setImage', { id: 'e-mara' }])
    expect(screen.getByRole('button', { name: 'Add image…' })).toBeInTheDocument()
    expect(page().querySelector('img')).toBeNull()
  })

  it('a chosen image is shown from the project´s assets and can be replaced or removed', async () => {
    const user = userEvent.setup()
    const mara = entityFixture[1]!
    const calls = await openPage('e-mara', {
      'entity:setImage': () => ({ ...mara, image: 'mara.0a1b2c3d.png' }),
      'entity:removeImage': () => ({ ...mara, image: null })
    })
    await user.click(screen.getByRole('button', { name: 'Add image…' }))
    const image = page().querySelector('img')
    expect(image).toHaveAttribute('src', 'mythscribe-asset://entities/mara.0a1b2c3d.png')
    expect(image).toHaveAttribute('alt', '')
    expect(screen.getByRole('button', { name: 'Replace image…' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove image' }))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
    expect(modal.options).toMatchObject({ confirmLabel: 'Remove', danger: true })
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal.id, false)
    })
    expect(calls.some(([channel]) => channel === 'entity:removeImage')).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Remove image' }))
    const second = useDialogStore.getState().modals[0]
    if (!second) throw new Error('expected a confirm')
    await act(async () => {
      useDialogStore.getState().resolveConfirm(second.id, true)
    })
    expect(calls.at(-1)).toEqual(['entity:removeImage', { id: 'e-mara' }])
    expect(page().querySelector('img')).toBeNull()
  })

  it('a failed image request toasts its cause', async () => {
    const user = userEvent.setup()
    await openPage('e-mara', { 'entity:setImage': failing('That file is not an image') })
    await user.click(screen.getByRole('button', { name: 'Add image…' }))
    expect(toasts()).toEqual(['That file is not an image'])
  })

  it('an entity deleted while its page is open leaves the page', async () => {
    install()
    await act(async () => {
      await useEntityStore.getState().load()
    })
    useEntityStore.getState().select('e-mara')
    const { container } = render(<EntityEditor id="e-gone" />)
    expect(container).toBeEmptyDOMElement()
    expect(useEntityStore.getState().selectedId).toBeNull()
  })
})
