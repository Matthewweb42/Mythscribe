import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { NamedInRow } from '@shared/memory/nameScan'
import type { StoryRecordSummary } from '@shared/memory/records'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { locateText } from '@renderer/features/editor/locateText'
import { resetCategoryStore } from '@renderer/features/entities/categoryStore'
import { sheetMemoryFixture } from '@renderer/features/memory/memoryFixture'
import { resetMemoryStore } from '@renderer/features/memory/memoryStore'
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
      // F-16.18: a sheet's From the book (empty: nothing read yet).
      if (channel === 'memory:sheet') {
        const { recordId, asOf } = input as Input<'memory:sheet'>
        return sheetMemoryFixture(recordId, { asOf }) as Output<C>
      }
      if (channel === 'record:savePage') {
        const { id } = input as Input<'record:savePage'>
        return withPages(id === 'r-mara' ? MARA : TOMAS) as Output<C>
      }
      if (channel === 'layout:set') return input as Output<C>
      if (channel === 'recovery:stash' || channel === 'recovery:clear') return null as Output<C>
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
  resetMemoryStore()
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
  resetActiveEditorStore()
  resetMemoryStore()
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
        listener({ recordIds: ['r-mara', 'r-tomas'], roster: true })
      }
      await Promise.resolve()
    })
    await waitFor(() => expect(useRecordStore.getState().byId['r-tomas']).toBeUndefined())
    expect(useRecordStore.getState().byId['r-mara']?.name).toBe('Mara Vell-Orrin')
    // The open sheet was the gone record's: the pane lets go of it.
    expect(useRecordStore.getState().selectedId).toBeNull()
  })

  it('keeps byId as it was when a refetch answers the same, and toasts a refetch that fails', async () => {
    let failing = false
    install({
      'record:get': () => {
        if (failing) throw new IpcRequestError({ code: 'INTERNAL', message: 'The disk is full' })
        return withPages(MARA)
      }
    })
    await loaded()
    useRecordStore.getState().subscribe()
    const before = useRecordStore.getState().byId
    const fire = async (recordIds: string[]): Promise<void> => {
      await act(async () => {
        for (const listener of listeners['record:changed'] ?? []) {
          listener({ recordIds, roster: false })
        }
        await Promise.resolve()
      })
    }
    await fire(['r-mara'])
    await waitFor(() => expect(sent('record:get')).toHaveLength(1))
    // Same summary: the name index built from byId is not rebuilt.
    expect(useRecordStore.getState().byId).toBe(before)
    failing = true
    await fire(['r-mara'])
    await waitFor(() => expect(toasts()).toContain('The disk is full'))
  })
})

describe('nameMentionStore (F-16.5, F-16.6)', () => {
  it('reads again what a scan or a roster change touched, never the world', async () => {
    const mention = (nodeId: string, recordId: string): Output<'names:forNode'>[number] => ({
      id: `m-${nodeId}-${recordId}`,
      recordId,
      para: 0,
      from: 1,
      to: 5,
      text: 'Mara',
      ambiguous: false,
      spanKey: 'k'
    })
    install({
      'names:forNode': (input) => {
        const { nodeId } = input as Input<'names:forNode'>
        return nodeId === 'sc-1' ? [mention('sc-1', 'r-mara')] : [mention(nodeId, 'r-tomas')]
      }
    })
    await loaded()
    const store = useNameMentionStore.getState()
    await act(async () => {
      await store.loadNode('sc-1')
      await store.loadNode('sc-2')
    })
    store.subscribe()
    const fire = async (event: 'names:changed' | 'record:changed', payload: unknown) => {
      calls = []
      await act(async () => {
        for (const listener of listeners[event] ?? []) listener(payload)
        await Promise.resolve()
      })
    }
    // A scan of sc-1 and sc-3: the counts and the loaded scene among them.
    await fire('names:changed', { nodeIds: ['sc-1', 'sc-3'] })
    await waitFor(() => expect(sent('names:forNode')).toEqual([{ nodeId: 'sc-1' }]))
    expect(sent('names:byRecord')).toHaveLength(1)
    // An image change, and a record nothing names yet: nothing is read.
    await fire('record:changed', { recordIds: ['r-mara'], roster: false })
    await fire('record:changed', { recordIds: ['r-new'], roster: true })
    expect(calls).toEqual([])
    // Tomas merged away: the counts and the scene naming him.
    await fire('record:changed', { recordIds: ['r-mara', 'r-tomas'], roster: true })
    await waitFor(() => expect(sent('names:byRecord')).toHaveLength(1))
    expect(sent('names:forNode')).toEqual([{ nodeId: 'sc-1' }, { nodeId: 'sc-2' }])
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
      expect(screen.getByRole('textbox', { name: 'Pinned' })).toHaveTextContent(
        id === 'r-mara' ? 'Eyes: grey.' : ''
      )
    )
    // F-16.18: the sheet's From the book reads its memory without an error.
    await waitFor(() => expect(sent('memory:sheet')).toContainEqual({ recordId: id, asOf: null }))
    expect(toasts().filter((message) => message.includes('unexpected'))).toEqual([])
  }

  /** `record:setAliases` answering the record as sent, the fixture's other fields kept. */
  const echoAliases = (input: unknown): Output<'record:setAliases'> => {
    const { id, name, aliases } = input as Input<'record:setAliases'>
    const held = [MARA, TOMAS, ELLA, QUAY].find((record) => record.id === id) ?? MARA
    return withPages(
      recordFixture(id, held.categoryId, [
        { text: name.text, caseRule: name.caseRule, shared: name.shared },
        ...aliases.map((entry) => ({
          text: entry.text,
          caseRule: entry.caseRule,
          shared: entry.shared
        }))
      ])
    )
  }

  const confirmOpen = async (): Promise<{ id: string; title: string }> =>
    waitFor(() => {
      const open = useDialogStore.getState().modals[0]
      if (open?.kind !== 'confirm') throw new Error('no confirm yet')
      return { id: open.id, title: open.options.title }
    })

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

  it('offers a nickname another record has as shared, marking it shared there first', async () => {
    install({ 'record:setAliases': echoAliases })
    await sheet('r-ella')
    const field = screen.getByRole('textbox', { name: 'New nickname' })
    // Declined: nothing is written and the typed name stays.
    fireEvent.change(field, { target: { value: 'Mara' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const declined = await confirmOpen()
    expect(declined.title).toBe('Share “Mara”?')
    act(() => useDialogStore.getState().resolveConfirm(declined.id, false))
    await waitFor(() => expect(useDialogStore.getState().modals).toEqual([]))
    expect(sent('record:setAliases')).toEqual([])
    expect(field).toHaveValue('Mara')
    // Shared: Mara Vell's "Mara" is marked shared, then Ella gets it shared too.
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    act(() =>
      useDialogStore.getState().resolveConfirm(useDialogStore.getState().modals[0]?.id ?? '', true)
    )
    await waitFor(() => expect(sent('record:setAliases')).toHaveLength(2))
    expect(sent('record:setAliases')).toEqual([
      {
        id: 'r-mara',
        name: { text: 'Mara Vell', caseRule: 'auto', shared: false },
        aliases: [{ text: 'Mara', caseRule: 'auto', shared: true }]
      },
      {
        id: 'r-ella',
        name: { text: 'Ella Harrow', caseRule: 'auto', shared: false },
        aliases: [
          { text: 'Harrow', caseRule: 'auto', shared: true },
          { text: 'Mara', shared: true }
        ]
      }
    ])
    await waitFor(() => expect(field).toHaveValue(''))
    // Both now say who they share it with.
    expect(screen.getByRole('listitem', { name: 'Mara' })).toHaveTextContent(
      'Shared with Mara Vell'
    )
  })

  it('keeps a refused nickname in its field and puts a refused rename back', async () => {
    install({
      'record:setAliases': () => {
        throw new IpcRequestError({
          code: 'VALIDATION',
          message: '"Harrow" is already a name of Tomas Harrow.'
        })
      }
    })
    await sheet()
    const field = screen.getByRole('textbox', { name: 'New nickname' })
    fireEvent.change(field, { target: { value: 'Wren' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(toasts()).toContain('"Harrow" is already a name of Tomas Harrow.'))
    expect(field).toHaveValue('Wren')
    const name = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(name, { target: { value: 'Mara Orrin' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(sent('record:setAliases')).toHaveLength(2))
    await waitFor(() => expect(name).toHaveValue('Mara Vell'))
  })

  it('Named in jumps to the recorded mention in the scene', async () => {
    const editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Later, Mara left.' }] }]
      }
    })
    try {
      const at = locateText(editor.state.doc, 'Mara')
      if (at === null) throw new Error('fixture')
      install({
        'names:forNode': () => [
          {
            id: 'm-1',
            recordId: 'r-mara',
            para: 0,
            from: at.from,
            to: at.to,
            text: 'Mara',
            ambiguous: false,
            spanKey: 'k'
          }
        ]
      })
      await sheet()
      useActiveEditorStore.getState().set('sc-1', editor)
      const named = screen.getByRole('region', { name: 'Named in' })
      fireEvent.click(within(named).getByRole('button', { name: /Scene 1/ }))
      await waitFor(() => {
        const { from, to } = editor.state.selection
        expect(editor.state.doc.textBetween(from, to)).toBe('Mara')
      })
      expect(sent('names:forNode')).toEqual([{ nodeId: 'sc-1' }])
      expect(useTreeStore.getState().selectedId).toBe('sc-1')
      expect(useRecordStore.getState().selectedId).toBeNull()
    } finally {
      editor.destroy()
    }
  })

  it('adds, changes and removes the image, moves the record to another category, and deletes it', async () => {
    let current = MARA
    install({
      'record:update': (input) => {
        const { image, categoryId } = input as Input<'record:update'>
        current = {
          ...current,
          ...(categoryId === undefined ? {} : { categoryId, kind: 'place' as const }),
          ...(image === 'choose' ? { image: 'mara.0a1b2c3d.png' } : {}),
          ...(image === 'remove' ? { image: null } : {})
        }
        return withPages(current)
      },
      'record:delete': () => null
    })
    await sheet()
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }))
    await waitFor(() => expect(screen.getByRole('img', { name: 'Mara Vell' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    await waitFor(() => expect(sent('record:update')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add image' })).toBeEnabled())
    expect(sent('record:update')).toEqual([
      { id: 'r-mara', image: 'choose' },
      { id: 'r-mara', image: 'choose' },
      { id: 'r-mara', image: 'remove' }
    ])
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), {
      target: { value: 'setting' }
    })
    await waitFor(() =>
      expect(useRecordStore.getState().byId['r-mara']?.categoryId).toBe('setting')
    )
    expect(sent('record:update')[3]).toEqual({ id: 'r-mara', categoryId: 'setting' })
    // Delete asks first, writes the open pages, then removes the record and lets go of its sheet.
    usePageStore.getState().edit(pageKey({ kind: 'pinned', id: 'r-mara' }), page('Last line.'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Mara Vell' }))
    const asked = await confirmOpen()
    expect(asked.title).toBe('Delete "Mara Vell"?')
    act(() => useDialogStore.getState().resolveConfirm(asked.id, true))
    await waitFor(() => expect(useRecordStore.getState().byId['r-mara']).toBeUndefined())
    const order = calls.map(([channel]) => channel)
    expect(order.indexOf('record:savePage')).toBeGreaterThan(-1)
    expect(order.indexOf('record:savePage')).toBeLessThan(order.indexOf('record:delete'))
    expect(useRecordStore.getState().selectedId).toBeNull()
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
    // Pinned offers Not canon; Ideas is never canon, so it offers nothing to mark.
    expect(screen.getByRole('toolbar', { name: 'Pinned page' })).toBeInTheDocument()
    expect(screen.queryByRole('toolbar', { name: 'Ideas page' })).toBeNull()
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
