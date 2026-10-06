import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { TAG_TEMPLATES, type CustomTagTemplate } from '@shared/tagTemplates'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetCustomTemplateStore, useCustomTemplateStore } from './customTemplateStore'
import { tagFixture } from './tagFixture'
import { resetTagStore, useTagStore } from './tagStore'
import { TemplateLoader } from './TemplateLoader'

type Handler = (input: unknown) => unknown

/** The author's saved templates `tagTemplate:list` answers with (F-4.11). */
let saved: CustomTagTemplate[] = []

const VILLAGE: CustomTagTemplate = {
  id: 'ct-1',
  name: 'Village saga',
  tags: [
    { name: 'mara', category: 'character', color: '#aa0000', parent: null, trackMentions: true },
    { name: 'the-mill', category: 'setting', color: '#00aa00', parent: null, trackMentions: true }
  ],
  created: '2026-10-06T00:00:00.000Z',
  modified: '2026-10-06T00:00:00.000Z'
}

function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'tag:list') return tagFixture as Output<C>
      if (channel === 'tag:aliases') return {} as Output<C>
      if (channel === 'tagTemplate:list') return saved as Output<C>
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
  render(<TemplateLoader bankEmpty={false} />)
  await act(async () => {
    await useCustomTemplateStore.getState().ensureLoaded()
  })
  return calls
}

describe('TemplateLoader (F-4.3)', () => {
  beforeEach(() => {
    resetTagStore()
    resetCustomTemplateStore()
    saved = []
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
      ['builtin:standard-fiction', 'Standard Fiction'],
      ['builtin:mystery', 'Mystery'],
      ['builtin:fantasy', 'Fantasy'],
      ['builtin:sci-fi', 'Sci-Fi']
    ])
    await user.selectOptions(select, 'Fantasy')
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
    await user.selectOptions(screen.getByRole('combobox', { name: 'Template' }), 'Fantasy')
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
    await user.selectOptions(screen.getByRole('combobox', { name: 'Template' }), 'Fantasy')
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

describe('TemplateLoader, custom templates (F-4.11)', () => {
  beforeEach(() => {
    resetTagStore()
    resetCustomTemplateStore()
    saved = [VILLAGE]
    useDialogStore.setState({ modals: [], toasts: [] })
  })

  const currentPrompt = (): { id: string; options: { title: string; initialValue?: string } } => {
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'prompt') throw new Error('expected a prompt')
    return modal
  }

  it('lists the saved templates under their own group and loads one on confirm', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded({
      'tag:loadCustomTemplate': () => ({ created: [], skipped: ['mara', 'the-mill'] })
    })
    expect(screen.getByRole('group', { name: 'Your templates' })).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Template' }), 'Village saga')
    await user.click(screen.getByRole('button', { name: 'Load' }))
    expect(currentConfirm().options).toEqual({
      title: 'Load the Village saga template?',
      message: 'Adds up to 2 tags. Tags already in the bank are skipped.',
      confirmLabel: 'Load'
    })
    await act(async () => {
      useDialogStore.getState().resolveConfirm(currentConfirm().id, true)
    })
    expect(calls.at(-1)).toEqual(['tag:loadCustomTemplate', { id: 'ct-1' }])
    expect(toasts()).toEqual([{ kind: 'info', message: 'All 2 tags are already in the bank' }])
  })

  it('saves the whole bank under a name and selects the new template', async () => {
    const user = userEvent.setup()
    const made: CustomTagTemplate = { ...VILLAGE, id: 'ct-2', name: 'Book two' }
    const calls = await renderLoaded({ 'tagTemplate:save': () => made })
    await user.click(screen.getByRole('button', { name: 'Save bank as template…' }))
    expect(currentPrompt().options.title).toBe('Save as tag template')
    await act(async () => {
      useDialogStore.getState().resolvePrompt(currentPrompt().id, '  Book two ')
    })
    expect(calls.at(-1)).toEqual(['tagTemplate:save', { name: 'Book two' }])
    expect(toasts()).toEqual([{ kind: 'success', message: 'Saved "Book two" with 2 tags' }])
    expect(screen.getByRole('combobox', { name: 'Template' })).toHaveValue('custom:ct-2')
    expect(useCustomTemplateStore.getState().templates.map((t) => t.name)).toEqual([
      'Book two',
      'Village saga'
    ])
  })

  it('toasts a taken name and keeps the list as it was', async () => {
    const user = userEvent.setup()
    await renderLoaded({
      'tagTemplate:save': () => {
        throw new IpcRequestError({
          code: 'ALREADY_EXISTS',
          message: 'A template named "Village saga" already exists'
        })
      }
    })
    await user.click(screen.getByRole('button', { name: 'Save bank as template…' }))
    await act(async () => {
      useDialogStore.getState().resolvePrompt(currentPrompt().id, 'village saga')
    })
    expect(toasts()).toEqual([
      { kind: 'error', message: 'A template named "Village saga" already exists' }
    ])
    expect(useCustomTemplateStore.getState().templates).toEqual([VILLAGE])
  })

  it('manages saved templates: rename, remove a tag, and delete after a confirm', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded({
      'tagTemplate:update': (input) => {
        const { name, keep } = input as { name?: string; keep?: string[] }
        return {
          ...VILLAGE,
          name: name ?? VILLAGE.name,
          tags:
            keep === undefined ? VILLAGE.tags : VILLAGE.tags.filter((t) => keep.includes(t.name))
        }
      },
      'tagTemplate:delete': () => null
    })
    await user.click(screen.getByRole('button', { name: 'Manage…' }))
    const dialog = screen.getByRole('dialog', { name: 'Tag templates' })
    expect(dialog).toHaveTextContent('Village saga2 tags')

    await user.click(screen.getByRole('button', { name: 'Rename…' }))
    expect(currentPrompt().options).toMatchObject({
      title: 'Rename "Village saga"',
      initialValue: 'Village saga'
    })
    await act(async () => {
      useDialogStore.getState().resolvePrompt(currentPrompt().id, 'Village')
    })
    expect(calls.at(-1)).toEqual(['tagTemplate:update', { id: 'ct-1', name: 'Village' }])

    await user.click(screen.getByRole('button', { name: 'Edit tags' }))
    await user.click(screen.getByRole('button', { name: 'Remove the-mill from Village' }))
    expect(calls.at(-1)).toEqual(['tagTemplate:update', { id: 'ct-1', keep: ['mara'] }])
    // The last tag stays: a template with none is deleted instead.
    expect(screen.getByRole('button', { name: 'Remove mara from Village saga' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(currentConfirm().options.title).toBe('Delete "Village saga"?')
    await act(async () => {
      useDialogStore.getState().resolveConfirm(currentConfirm().id, true)
    })
    expect(calls.at(-1)).toEqual(['tagTemplate:delete', { id: 'ct-1' }])
    expect(screen.getByText('No saved templates.')).toBeInTheDocument()
  })
})
