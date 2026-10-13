import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEdit } from '@shared/agent'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { StoryRecord } from '@shared/memory/records'
import type { TiptapNodeT } from '@shared/tiptap'
import { pageKey, resetPageStore, usePageStore } from '@renderer/features/research/pageStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { AgentEditError } from '@renderer/features/editor/agentEditing'
import { applyAgentEdit, SHEET_BUSY, SHEET_PLACE_FIRST, SHEET_WRITE_TRIES } from './agentApply'

/**
 * F-16.26 (decision 3 as the author changed it): a sheet line Ms Scribe offers lands on the
 * record's Pinned or Ideas page through `record:addLine`, after the page store is flushed, and an
 * open page is read again; its Undo is `record:removeLine` under the same flush and reload; a
 * Pinned line that contradicts the sheet says so on the change.
 */

const RUN = { source: 'chat', run: 'm-1' } as const
const KEY = pageKey({ kind: 'pinned', id: 'r-mara' })

let calls: Channel[]
let pinned: string[]
let conflict: { index: number; text: string } | null
let editedSince: boolean
/** Runs while `record:addLine` is on the wire: the author typing on the open page meanwhile. */
let duringAdd: (() => void) | null
let adds: number

const page = (lines: readonly string[]): TiptapNodeT => ({
  type: 'doc',
  content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const record = (): StoryRecord => ({
  id: 'r-mara',
  categoryId: 'character',
  kind: 'character',
  name: 'Mara',
  image: null,
  origin: 'author',
  aliases: [],
  created: '2026-10-13T09:00:00.000Z',
  modified: '2026-10-13T09:00:00.000Z',
  pinned: pinned.length === 0 ? null : page(pinned),
  ideas: null
})

const line = (place: 'pinned' | 'ideas' | null): Extract<AgentEdit, { kind: 'sheetLine' }> => ({
  kind: 'sheetLine',
  recordId: 'r-mara',
  name: 'Mara',
  place,
  text: 'Hates the sea',
  turn: 'r-7'
})

beforeEach(() => {
  resetPageStore()
  calls = []
  pinned = ['Eyes: grey']
  conflict = null
  editedSince = false
  duringAdd = null
  adds = 0
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push(channel)
      switch (channel) {
        case 'record:get':
          return record() as Output<C>
        case 'record:savePage': {
          const { doc } = input as Input<'record:savePage'>
          pinned = (doc?.content ?? []).map((block) =>
            (block.content ?? []).map((child) => child.text ?? '').join('')
          )
          return record() as Output<C>
        }
        case 'recovery:stash':
        case 'recovery:clear':
          return undefined as Output<C>
        case 'record:addLine': {
          const { text } = input as Input<'record:addLine'>
          adds += 1
          duringAdd?.()
          pinned = [...pinned, text]
          return { record: record(), index: pinned.length - 1, text, conflict } as Output<C>
        }
        case 'record:removeLine': {
          const { index } = input as Input<'record:removeLine'>
          if (editedSince) throw new Error('VALIDATION: Edited since; change it on the sheet.')
          pinned = pinned.filter((_, i) => i !== index)
          return record() as Output<C>
        }
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: () => () => undefined
  })
})
afterEach(() => resetPageStore())

const textOf = (doc: TiptapNodeT | null | undefined): string[] =>
  (doc?.content ?? []).map((block) => (block.content ?? []).map((child) => child.text).join(''))

describe('applyAgentEdit: sheetLine (F-16.26)', () => {
  it('flushes the page store, adds the line, reloads the open page, and its Undo takes it out', async () => {
    await usePageStore.getState().load(KEY)
    usePageStore.getState().edit(KEY, page(['Eyes: grey', 'Typed just now']))
    const undo = await applyAgentEdit(line('pinned'), 'p-1', RUN)
    // Her unsaved typing was written first, then the line after it.
    expect(calls.indexOf('record:savePage')).toBeLessThan(calls.indexOf('record:addLine'))
    expect(pinned).toEqual(['Eyes: grey', 'Typed just now', 'Hates the sea'])
    await expect
      .poll(() => textOf(usePageStore.getState().docs[KEY]?.content))
      .toEqual(['Eyes: grey', 'Typed just now', 'Hates the sea'])
    expect(undo).not.toBeNull()
    await undo?.()
    expect(calls.at(-2)).toBe('record:removeLine')
    expect(pinned).toEqual(['Eyes: grey', 'Typed just now'])
    await expect
      .poll(() => textOf(usePageStore.getState().docs[KEY]?.content))
      .toEqual(['Eyes: grey', 'Typed just now'])
  })

  it('saves what she typed on the open page while the line was written, then writes the line again after it', async () => {
    await usePageStore.getState().load(KEY)
    duringAdd = () => {
      duringAdd = null
      usePageStore.getState().edit(KEY, page(['Eyes: grey', 'Typed meanwhile']))
    }
    await applyAgentEdit(line('pinned'), 'p-1', RUN)
    expect(adds).toBe(2)
    // Her words were saved (dropping the first line, which her draft never held), then the line.
    expect(pinned).toEqual(['Eyes: grey', 'Typed meanwhile', 'Hates the sea'])
    await expect
      .poll(() => textOf(usePageStore.getState().docs[KEY]?.content))
      .toEqual(['Eyes: grey', 'Typed meanwhile', 'Hates the sea'])
  })

  it('gives the line up, never her words, when she keeps typing through every try', async () => {
    await usePageStore.getState().load(KEY)
    let n = 0
    duringAdd = () => {
      n += 1
      usePageStore.getState().edit(KEY, page(['Eyes: grey', `Typed ${n}`]))
    }
    await expect(applyAgentEdit(line('pinned'), 'p-1', RUN)).rejects.toThrow(
      new AgentEditError(SHEET_BUSY)
    )
    expect(adds).toBe(SHEET_WRITE_TRIES)
    expect(pinned).toEqual(['Eyes: grey', `Typed ${SHEET_WRITE_TRIES}`])
  })

  it('leaves a closed page closed', async () => {
    await applyAgentEdit(line('ideas'), 'p-1', RUN)
    expect(usePageStore.getState().docs[pageKey({ kind: 'ideas', id: 'r-mara' })]).toBeUndefined()
  })

  it('says which Pinned line it contradicts', async () => {
    conflict = { index: 0, text: 'Eyes: grey' }
    const notices: string[] = []
    await applyAgentEdit(line('pinned'), 'p-1', RUN, (notice) => notices.push(notice))
    expect(notices).toEqual(['It contradicts “Eyes: grey” on the sheet; both lines are there now.'])
  })

  it('refuses a line with no place, and an Undo after she edited the line', async () => {
    await expect(applyAgentEdit(line(null), 'p-1', RUN)).rejects.toThrow(
      new AgentEditError(SHEET_PLACE_FIRST)
    )
    const undo = await applyAgentEdit(line('pinned'), 'p-1', RUN)
    editedSince = true
    await expect(undo?.()).rejects.toThrow('Edited since; change it on the sheet.')
    expect(pinned).toContain('Hates the sea')
  })
})
