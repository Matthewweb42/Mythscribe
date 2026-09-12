import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { TAG_TEMPLATES } from '@shared/tagTemplates'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { tagFixture } from './tagFixture'
import { resetTagStore, useTagStore } from './tagStore'
import { TemplateLoader } from './TemplateLoader'

type Handler = (input: unknown) => unknown

function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'tag:list') return tagFixture as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const fantasy = TAG_TEMPLATES.find((t) => t.id === 'fantasy')!

/** Answers like main would for the fantasy template: every tag created, none skipped. */
const fullLoad = (): { created: Tag[]; skipped: string[] } => ({
  created: fantasy.tags.map((entry, index) => ({
    ...tagFixture[2]!,
    id: `t-tpl-${index}`,
    name: entry.name,
    category: entry.category,
    usageCount: 0
  })),
  skipped: []
})

const toasts = (): { kind: string; message: string }[] =>
  useDialogStore.getState().toasts.map((t) => ({ kind: t.kind, message: t.message }))

function currentConfirm(): Extract<
  ReturnType<typeof useDialogStore.getState>['modals'][number],
  { kind: 'confirm' }
> {
  const modal = useDialogStore.getState().modals[0]
  if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
  return modal
}

async function renderLoaded(
  overrides: Partial<Record<Channel, Handler>> = {}
): Promise<[Channel, unknown][]> {
  const calls = install(overrides)
  await act(async () => {
    await useTagStore.getState().load()
  })
  render(<TemplateLoader />)
  return calls
}

describe('TemplateLoader (F-4.3)', () => {
  beforeEach(() => {
    resetTagStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })

  it('lists the four templates and asks before loading the chosen one', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    const select = screen.getByRole('combobox', { name: 'Template' })
    expect(
      screen
        .getAllByRole('option')
        .map((option) => [option.getAttribute('value'), option.textContent])
    ).toEqual([
      ['standard-fiction', 'Standard Fiction'],
      ['mystery', 'Mystery'],
      ['fantasy', 'Fantasy'],
      ['sci-fi', 'Sci-Fi']
    ])
    await user.selectOptions(select, 'fantasy')
    await user.click(screen.getByRole('button', { name: 'Load' }))
    expect(currentConfirm().options).toEqual({
      title: 'Load the Fantasy template?',
      message: `Adds ${fantasy.tags.length} tags across every category. Tags already in the bank are skipped.`,
      confirmLabel: 'Load'
    })
    expect(calls.filter(([channel]) => channel === 'tag:loadTemplate')).toHaveLength(0)
  })

  it('confirming loads the template, merges the new tags, and toasts the counts', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded({ 'tag:loadTemplate': fullLoad })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Template' }), 'fantasy')
    await user.click(screen.getByRole('button', { name: 'Load' }))
    await act(async () => {
      useDialogStore.getState().resolveConfirm(currentConfirm().id, true)
    })
    expect(calls.at(-1)).toEqual(['tag:loadTemplate', { template: 'fantasy' }])
    expect(useTagStore.getState().ids).toHaveLength(tagFixture.length + fantasy.tags.length)
    expect(useTagStore.getState().byId['t-tpl-0']?.name).toBe('hero')
    expect(toasts()).toEqual([{ kind: 'success', message: `Added ${fantasy.tags.length} tags` }])
    expect(screen.getByRole('button', { name: 'Load' })).toBeEnabled()
  })

  it('reports the skipped names and uses an info toast when nothing was added', async () => {
    const user = userEvent.setup()
    const partial = fullLoad()
    const skipped = partial.created.slice(0, 3).map((t) => t.name)
    let answer = { created: partial.created.slice(3), skipped }
    await renderLoaded({ 'tag:loadTemplate': () => answer })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Template' }), 'fantasy')
    await user.click(screen.getByRole('button', { name: 'Load' }))
    await act(async () => {
      useDialogStore.getState().resolveConfirm(currentConfirm().id, true)
    })
    expect(toasts()).toEqual([
      {
        kind: 'success',
        message: `Added ${fantasy.tags.length - 3} tags, skipped 3 already in the bank`
      }
    ])

    answer = { created: [], skipped: fantasy.tags.map((t) => t.name) }
    const idsBefore = useTagStore.getState().ids
    await user.click(screen.getByRole('button', { name: 'Load' }))
    await act(async () => {
      useDialogStore.getState().resolveConfirm(currentConfirm().id, true)
    })
    expect(toasts().at(-1)).toEqual({
      kind: 'info',
      message: `All ${fantasy.tags.length} tags are already in the bank`
    })
    expect(useTagStore.getState().ids).toBe(idsBefore)
  })

  it('cancelling the confirm loads nothing', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded({ 'tag:loadTemplate': fullLoad })
    await user.click(screen.getByRole('button', { name: 'Load' }))
    await act(async () => {
      useDialogStore.getState().resolveConfirm(currentConfirm().id, false)
    })
    expect(calls.filter(([channel]) => channel === 'tag:loadTemplate')).toHaveLength(0)
    expect(useTagStore.getState().ids).toEqual(['t-forest', 't-mara', 't-moody'])
    expect(toasts()).toEqual([])
  })

  it('a failed load toasts the error and leaves the store alone', async () => {
    const user = userEvent.setup()
    await renderLoaded({
      'tag:loadTemplate': () => {
        throw new IpcRequestError({ code: 'INTERNAL', message: 'Database is locked' })
      }
    })
    const before = useTagStore.getState()
    await user.click(screen.getByRole('button', { name: 'Load' }))
    await act(async () => {
      useDialogStore.getState().resolveConfirm(currentConfirm().id, true)
    })
    expect(toasts()).toEqual([{ kind: 'error', message: 'Database is locked' }])
    expect(useTagStore.getState().byId).toBe(before.byId)
    expect(useTagStore.getState().ids).toBe(before.ids)
    expect(screen.getByRole('button', { name: 'Load' })).toBeEnabled()
  })
})
