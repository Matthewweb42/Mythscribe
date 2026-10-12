import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { NamedInRow } from '@shared/memory/nameScan'
import type { StoryRecordSummary } from '@shared/memory/records'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetCategoryStore } from '@renderer/features/entities/categoryStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { pageKey, resetPageStore, usePageStore } from '@renderer/features/research/pageStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { IpcRequestError, setIpcClient } from '@renderer/lib/ipc'
import { resetNameMentionStore, useNameMentionStore } from './nameMentionStore'
import { GATE_DEBOUNCE_MS, RecordCreateDialog } from './RecordCreateDialog'
import { recordFixture, withPages } from './recordFixture'
import { RecordList } from './RecordList'
import { RecordSheet } from './RecordSheet'
import { resetRecordStore, useRecordStore } from './recordStore'
import {
  aliasesInputOf,
  gateWarning,
  matchesRecordQuery,
  mergePreview,
  namedInLabel,
  sharedWith
} from './recordView'

/**
 * F-16.6 (plan P1 §3), the records UI of story memory v2: the pure view rules, the record store,
 * the record list with "named in N scenes", the creation dialog's live twin-gate warning (Same as
 * · Create anyway, decision P1-D4), and the one-view sheet (names with their case rule, shared
 * flag and removal, Same as, Split, Pinned and Ideas pages, Named in).
 */

type Handler = (input: unknown) => unknown
let calls: [Channel, unknown][]
let listeners: Partial<Record<EventName, ((payload: unknown) => void)[]>>

const MARA = recordFixture('r-mara', 'character', ['Mara Vell', 'Mara'])
const TOMAS = recordFixture('r-tomas', 'character', [
  'Tomas Harrow',
  { text: 'Harrow', shared: true }
])
const ELLA = recordFixture('r-ella', 'character', ['Ella Harrow', { text: 'Harrow', shared: true }])
const QUAY = recordFixture('r-quay', 'setting', ['North Quay'])

const NAMED_IN: NamedInRow[] = [
  { recordId: 'r-mara', nodeId: 'sc-4', count: 1 },
  { recordId: 'r-mara', nodeId: 'sc-1', count: 3 },
  { recordId: 'r-tomas', nodeId: 'sc-2', count: 2 }
]

const page = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function install(overrides: Partial<Record<Channel, Handler>> = {}): void {
  calls = []
  listeners = {}
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return (await override(input)) as Output<C>
      if (channel === 'record:list') return [ELLA, MARA, QUAY, TOMAS] as Output<C>
      if (channel === 'record:get') {
        const { id } = input as Input<'record:get'>
        const found = [MARA, TOMAS, ELLA, QUAY].find((record) => record.id === id)
        if (found === undefined) {
          throw new IpcRequestError({ code: 'NOT_FOUND', message: 'gone' })
        }
        return {
          ...withPages(found),
          pinned: id === 'r-mara' ? page('Eyes: grey.') : null
        } as Output<C>
      }
      if (channel === 'names:byRecord') return NAMED_IN as Output<C>
      if (channel === 'record:savePage') {
        const { id } = input as Input<'record:savePage'>
        return withPages(id === 'r-mara' ? MARA : TOMAS) as Output<C>
      }
      if (channel === 'layout:set') return input as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      const list: ((payload: unknown) => void)[] = listeners[event] ?? []
      list.push(listener as (payload: unknown) => void)
      listeners[event] = list
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((each) => each !== listener)
      }
    }
  })
}

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)

const toasts = (): string[] => useDialogStore.getState().toasts.map((toast) => toast.message)

async function loaded(): Promise<void> {
  await act(async () => {
    await useRecordStore.getState().load()
    await useNameMentionStore.getState().load()
  })
}

beforeEach(() => {
  install()
  resetRecordStore()
  resetNameMentionStore()
  resetPageStore()
  resetPendingSaves()
  resetCategoryStore()
  resetLayoutStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.getState().clear()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
})
afterEach(() => {
  vi.useRealTimers()
  resetRecordStore()
  resetNameMentionStore()
  resetPageStore()
  resetPendingSaves()
  resetLayoutStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('the record views’ rules (F-16.6)', () => {
  it('words the twin gate’s warning per rule, and a dismissed name apart', () => {
    expect(
      gateWarning(
        { outcome: 'blocked', rule: 'alias', recordId: 'r-mara', matched: 'Mara' },
        'Mara Vell'
      )
    ).toBe('Looks like Mara Vell (already called “Mara”).')
    expect(
      gateWarning(
        { outcome: 'blocked', rule: 'prefix', recordId: 'r-mara', matched: 'Mara' },
        'Mara Vell'
      )
    ).toBe('Looks like Mara Vell (starts the same as “Mara”).')
    expect(
      gateWarning(
        { outcome: 'blocked', rule: 'dismissed', recordId: null, matched: 'Hesk' },
        undefined
      )
    ).toBe('“Hesk” is on your Dismissed list as not a name.')
  })

  it('searches names and nicknames, says who shares a name, and previews a merge', () => {
    expect(matchesRecordQuery(MARA, 'mara')).toBe(true)
    expect(matchesRecordQuery(TOMAS, 'harr')).toBe(true)
    expect(matchesRecordQuery(QUAY, 'mara')).toBe(false)
    const harrow = TOMAS.aliases[1]
    if (harrow === undefined) throw new Error('fixture')
    expect(sharedWith(harrow, [MARA, TOMAS, ELLA]).map((record) => record.id)).toEqual(['r-ella'])
    // Tomas brings two names Mara lacks and the mentions of one scene.
    expect(mergePreview(MARA, TOMAS, NAMED_IN)).toEqual({ names: 2, scenes: 1 })
    expect(namedInLabel(0)).toBe('not named yet')
    expect(namedInLabel(1)).toBe('named in 1 scene')
    expect(namedInLabel(4)).toBe('named in 4 scenes')
    expect(aliasesInputOf(TOMAS)).toEqual({
      name: { text: 'Tomas Harrow', caseRule: 'auto', shared: false },
      aliases: [{ text: 'Harrow', caseRule: 'auto', shared: true }]
    })
  })
})

describe('recordStore (F-16.6)', () => {
  it('loads by name, refetches what main says changed, and drops a record that is gone', async () => {
    await loaded()
    expect(useRecordStore.getState().ids).toEqual(['r-ella', 'r-mara', 'r-quay', 'r-tomas'])
    act(() => useRecordStore.getState().select('r-tomas'))
    install({
      'record:get': (input) => {
        const { id } = input as Input<'record:get'>
        if (id === 'r-tomas') throw new IpcRequestError({ code: 'NOT_FOUND', message: 'gone' })
        return withPages({ ...MARA, name: 'Mara Vell-Orrin' })
      }
    })
    useRecordStore.getState().subscribe()
    await act(async () => {
      for (const listener of listeners['record:changed'] ?? []) {
        listener({ recordIds: ['r-mara', 'r-tomas'] })
      }
      await Promise.resolve()
    })
    await waitFor(() => expect(useRecordStore.getState().byId['r-tomas']).toBeUndefined())
    expect(useRecordStore.getState().byId['r-mara']?.name).toBe('Mara Vell-Orrin')
    // The open sheet was the gone record's: the pane lets go of it.
    expect(useRecordStore.getState().selectedId).toBeNull()
  })
})

describe('RecordList (F-16.6)', () => {
  it('lists a category’s records with nicknames and how many scenes name each', async () => {
    await loaded()
    render(<RecordList categoryId="character" ids={['r-ella', 'r-mara', 'r-tomas']} filtered />)
    const mara = screen.getByRole('button', { name: /Mara Vell/ })
    expect(mara).toHaveTextContent('Mara')
    expect(mara).toHaveTextContent('named in 2 scenes')
    expect(screen.getByRole('button', { name: /Ella Harrow/ })).toHaveTextContent('not named yet')
    fireEvent.click(mara)
    expect(useRecordStore.getState().selectedId).toBe('r-mara')
    expect(mara).toHaveAttribute('aria-current', 'true')
  })
})

describe('RecordCreateDialog (F-16.4, P1-D4)', () => {
  const typeName = async (text: string): Promise<void> => {
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: text } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATE_DEBOUNCE_MS + 1)
    })
  }

  it('warns as the name is typed, and Create anyway makes the record and opens it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await loaded()
    const made = recordFixture('r-new', 'character', ['Mara'])
    install({
      'record:gate': (input) =>
        (input as Input<'record:gate'>).name === 'Mara'
          ? { outcome: 'blocked', rule: 'alias', recordId: 'r-mara', matched: 'Mara' }
          : { outcome: 'clear' },
      'record:create': () => ({ record: withPages(made) })
    })
    act(() => useRecordStore.getState().startCreate('character'))
    render(<RecordCreateDialog />)
    await typeName('Mara')
    const warning = await screen.findByTestId('record-gate-warning')
    expect(warning).toHaveTextContent('Looks like Mara Vell (already called “Mara”).')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(within(warning).getByRole('button', { name: 'Same as Mara Vell' })).toBeEnabled()
    // A clear name drops the warning.
    await typeName('Orrin')
    await waitFor(() => expect(screen.queryByTestId('record-gate-warning')).toBeNull())
    await typeName('Mara')
    fireEvent.click(await screen.findByRole('button', { name: 'Create anyway' }))
    await waitFor(() => expect(useRecordStore.getState().creating).toBeNull())
    expect(sent('record:create')).toEqual([
      { name: 'Mara', categoryId: 'character', aliases: [], force: true }
    ])
    expect(useRecordStore.getState().selectedId).toBe('r-new')
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('character')
  })

  it('Same as adds the typed name to that record as a nickname and opens it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await loaded()
    install({
      'record:gate': () => ({
        outcome: 'blocked',
        rule: 'prefix',
        recordId: 'r-mara',
        matched: 'Mara'
      }),
      'record:setAliases': () =>
        withPages(recordFixture('r-mara', 'character', ['Mara Vell', 'Mara', 'Mar']))
    })
    act(() => useRecordStore.getState().startCreate('character'))
    render(<RecordCreateDialog />)
    await typeName('Mar')
    fireEvent.click(await screen.findByRole('button', { name: 'Same as Mara Vell' }))
    await waitFor(() => expect(useRecordStore.getState().creating).toBeNull())
    expect(sent('record:setAliases')).toEqual([
      {
        id: 'r-mara',
        name: { text: 'Mara Vell', caseRule: 'auto', shared: false },
        aliases: [{ text: 'Mara', caseRule: 'auto', shared: false }, { text: 'Mar' }]
      }
    ])
    expect(sent('record:create')).toEqual([])
    expect(useRecordStore.getState().selectedId).toBe('r-mara')
  })

  it('creates a clear name at once, and a gate answer from main shows the warning instead', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await loaded()
    install({
      'record:gate': () => ({ outcome: 'clear' }),
      'record:create': () => ({
        gate: { outcome: 'blocked', rule: 'edit', recordId: 'r-mara', matched: 'Mara Vell' }
      })
    })
    act(() => useRecordStore.getState().startCreate('character'))
    render(<RecordCreateDialog />)
    await typeName('Mara Vel')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByTestId('record-gate-warning')).toHaveTextContent(
      'Looks like Mara Vell (spelled almost like “Mara Vell”).'
    )
    expect(useRecordStore.getState().creating).toBe('character')
  })
})

describe('RecordSheet (F-16.6)', () => {
  const sheet = async (id = 'r-mara'): Promise<void> => {
    await loaded()
    act(() => useRecordStore.getState().select(id))
    render(<RecordSheet id={id} />)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Pinned' })).toHaveTextContent('Eyes: grey.')
    )
  }

  it('changes a nickname’s case rule and shared flag, adds one and removes one (to Dismissed)', async () => {
    const answers: StoryRecordSummary[] = []
    install({
      'record:setAliases': (input) => {
        const { aliases } = input as Input<'record:setAliases'>
        const next = recordFixture('r-mara', 'character', [
          'Mara Vell',
          ...aliases.map((entry) => ({
            text: entry.text,
            caseRule: entry.caseRule,
            shared: entry.shared
          }))
        ])
        answers.push(next)
        return withPages(next)
      }
    })
    await sheet()
    const nicknames = screen.getByRole('list', { name: 'Nicknames' })
    const mara = within(nicknames).getByRole('listitem', { name: 'Mara' })
    fireEvent.change(within(mara).getByRole('combobox', { name: 'Case for Mara' }), {
      target: { value: 'exact' }
    })
    await waitFor(() => expect(answers).toHaveLength(1))
    expect(sent('record:setAliases')[0]).toEqual({
      id: 'r-mara',
      name: { text: 'Mara Vell', caseRule: 'auto', shared: false },
      aliases: [{ text: 'Mara', caseRule: 'exact', shared: false }]
    })
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Case for Mara' })).toHaveValue('exact')
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /Shared/ }))
    await waitFor(() => expect(answers).toHaveLength(2))
    expect(sent('record:setAliases')[1]).toMatchObject({
      aliases: [{ text: 'Mara', caseRule: 'exact', shared: true }]
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'New nickname' }), {
      target: { value: 'Little Wren' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(answers).toHaveLength(3))
    expect(sent('record:setAliases')[2]).toMatchObject({
      aliases: [{ text: 'Mara' }, { text: 'Little Wren' }]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Mara' }))
    await waitFor(() => expect(answers).toHaveLength(4))
    expect(sent('record:setAliases')[3]).toMatchObject({ aliases: [{ text: 'Little Wren' }] })
  })

  it('Same as previews the merge, flushes and reloads the pages, and keeps this sheet open', async () => {
    const merged = recordFixture('r-mara', 'character', [
      'Mara Vell',
      'Mara',
      'Tomas Harrow',
      'Harrow'
    ])
    install({ 'record:sameAs': () => withPages(merged) })
    await sheet()
    usePageStore.getState().edit(pageKey({ kind: 'pinned', id: 'r-mara' }), page('Eyes: green.'))
    fireEvent.click(screen.getByRole('button', { name: 'Same as…' }))
    fireEvent.change(screen.getByRole('combobox', { name: /Which record is the same/ }), {
      target: { value: 'r-tomas' }
    })
    expect(screen.getByText(/Tomas Harrow becomes part of Mara Vell: 2 names/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Merge into Mara Vell' }))
    await waitFor(() =>
      expect(sent('record:sameAs')).toEqual([{ keepId: 'r-mara', mergeId: 'r-tomas' }])
    )
    // The typed Pinned line was written before the merge read the pages.
    const order = calls.map(([channel]) => channel)
    expect(order.indexOf('record:savePage')).toBeLessThan(order.indexOf('record:sameAs'))
    await waitFor(() => expect(useRecordStore.getState().byId['r-tomas']).toBeUndefined())
    expect(useRecordStore.getState().selectedId).toBe('r-mara')
    expect(toasts()).toContain('Tomas Harrow is now part of Mara Vell')
  })

  it('Split moves the picked nicknames to a new record', async () => {
    const into = recordFixture('r-split', 'character', ['Mara'])
    install({
      'record:split': () => ({
        from: withPages(recordFixture('r-mara', 'character', ['Mara Vell'])),
        into: withPages(into)
      })
    })
    await sheet()
    fireEvent.click(screen.getByRole('button', { name: 'Split…' }))
    const split = screen.getByRole('button', { name: 'Split into a new record' })
    expect(split).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mara' }))
    fireEvent.click(split)
    await waitFor(() =>
      expect(sent('record:split')).toEqual([
        { id: 'r-mara', aliasIds: ['r-mara-a1'], intoId: null }
      ])
    )
    await waitFor(() => expect(useRecordStore.getState().byId['r-split']?.name).toBe('Mara'))
    expect(toasts()).toContain('Mara is a record of its own')
  })

  it('saves Pinned and Ideas through the record’s own pages, and lists Named in by reading order', async () => {
    await sheet()
    expect(screen.getByText(/never treats them as true/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Ideas' })).toBeInTheDocument()
    usePageStore
      .getState()
      .edit(pageKey({ kind: 'pinned', id: 'r-mara' }), page('Eyes: grey as rain.'))
    usePageStore.getState().edit(pageKey({ kind: 'ideas', id: 'r-mara' }), page('Maybe a twin.'))
    await act(() => usePageStore.getState().flush())
    expect(sent('record:savePage')).toEqual([
      { id: 'r-mara', page: 'pinned', doc: page('Eyes: grey as rain.') },
      { id: 'r-mara', page: 'ideas', doc: page('Maybe a twin.') }
    ])
    const named = screen.getByRole('region', { name: 'Named in' })
    expect(
      within(named)
        .getAllByRole('button')
        .map((row) => row.textContent)
    ).toEqual(['Scene 1×3', 'Scene 4×1'])
  })
})
