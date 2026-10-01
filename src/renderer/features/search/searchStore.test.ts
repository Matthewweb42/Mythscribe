import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { SEARCH_TYPES, type SearchRequest, type SearchResponse } from '@shared/search'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { SEARCH_DEBOUNCE_MS, resetSearchStore, useSearchStore } from './searchStore'

const state = (): ReturnType<typeof useSearchStore.getState> => useSearchStore.getState()

const answerFor = (title: string): SearchResponse => ({
  results: [
    {
      type: 'document',
      id: title,
      title,
      location: 'Chapter 1',
      field: null,
      snippet: { text: title, highlights: [] },
      titleHighlights: [],
      count: 1
    }
  ],
  total: 1,
  truncated: false
})

let requests: SearchRequest[]
/** One resolver per request, in order, so a test decides which answer lands first. */
let pending: ((response: SearchResponse | Error) => void)[]

function install(): void {
  requests = []
  pending = []
  const client: IpcClient = {
    invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel !== 'search:query') return Promise.reject(new Error(`unexpected ${channel}`))
      requests.push(input as SearchRequest)
      return new Promise<Output<C>>((resolve, reject) => {
        pending.push((response) => {
          if (response instanceof Error) reject(response)
          else resolve(response as Output<C>)
        })
      })
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const rest = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetSearchStore()
  install()
})
afterEach(() => {
  // A debounce left pending by a file's last test would fire into the next file's IPC fake.
  resetSearchStore()
  setIpcClient(null)
  vi.useRealTimers()
})

describe('searchStore (F-10.1)', () => {
  it('starts closed and idle with every type on; open and close keep the query', () => {
    expect(state()).toMatchObject({
      open: false,
      query: '',
      types: [...SEARCH_TYPES],
      tagId: null,
      response: null,
      status: 'idle'
    })
    state().openSearch()
    state().openSearch()
    expect(state().open).toBe(true)
    state().setQuery('lantern')
    state().close()
    expect(state()).toMatchObject({ open: false, query: 'lantern' })
  })

  it('debounces typing into one request with the normalized query', async () => {
    state().setQuery('la')
    state().setQuery('lan')
    state().setQuery('  The   Lantern ')
    expect(state().status).toBe('searching')
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1)
    expect(requests).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(requests).toEqual([{ query: 'The Lantern', types: [...SEARCH_TYPES], tagId: null }])
    pending[0]?.(answerFor('one'))
    await rest()
    expect(state()).toMatchObject({
      status: 'done',
      answeredQuery: 'The Lantern',
      response: answerFor('one')
    })
  })

  it('asks nothing for a query under the minimum, and clears the last answer', async () => {
    state().setQuery('lantern')
    await rest()
    pending[0]?.(answerFor('one'))
    await rest()
    expect(state().response).not.toBeNull()
    state().setQuery('l')
    expect(state()).toMatchObject({ status: 'idle', response: null, answeredQuery: '' })
    await rest()
    expect(requests).toHaveLength(1)
  })

  it('drops a slow answer that a newer request has overtaken', async () => {
    state().setQuery('lantern')
    await rest()
    state().setQuery('lantern light')
    await rest()
    expect(requests.map((r) => r.query)).toEqual(['lantern', 'lantern light'])
    pending[1]?.(answerFor('new'))
    await rest()
    pending[0]?.(answerFor('old'))
    await rest()
    expect(state().response).toEqual(answerFor('new'))
    expect(state().answeredQuery).toBe('lantern light')
  })

  it('drops an answer that arrives while a newer query is still resting', async () => {
    state().setQuery('lantern')
    await rest()
    state().setQuery('lantern light')
    pending[0]?.(answerFor('old'))
    await vi.advanceTimersByTimeAsync(1)
    expect(state()).toMatchObject({ response: null, status: 'searching' })
  })

  it('asks again at once when a filter changes, in SEARCH_TYPES order', async () => {
    state().setQuery('lantern')
    await rest()
    pending[0]?.(answerFor('one'))
    await rest()
    state().toggleType('document')
    state().toggleType('world')
    state().toggleType('document')
    expect(state().types).toEqual(['document', 'notes', 'character', 'setting'])
    state().setTagId('t-1')
    expect(requests.slice(1).map((r) => [r.types.length, r.tagId])).toEqual([
      [4, null],
      [3, null],
      [4, null],
      [4, 't-1']
    ])
    pending[4]?.(answerFor('tagged'))
    pending[2]?.(answerFor('stale'))
    await rest()
    expect(state().response).toEqual(answerFor('tagged'))
  })

  it('asks nothing with every type off', async () => {
    state().setQuery('lantern')
    await rest()
    for (const type of SEARCH_TYPES) state().toggleType(type)
    expect(state()).toMatchObject({ types: [], status: 'idle', response: null })
    expect(requests).toHaveLength(SEARCH_TYPES.length)
  })

  it('reports a failed request with its cause', async () => {
    state().setQuery('lantern')
    await rest()
    pending[0]?.(new Error('No project is open'))
    await rest()
    expect(state()).toMatchObject({ status: 'error', error: 'No project is open', response: null })
  })

  it('reset closes, forgets, and drops what is in flight or resting', async () => {
    state().openSearch()
    state().setQuery('lantern')
    await rest()
    state().toggleType('notes')
    state().setQuery('lantern light')
    state().reset()
    pending[0]?.(answerFor('late'))
    pending[1]?.(answerFor('late'))
    await rest()
    expect(requests).toHaveLength(2)
    expect(state()).toMatchObject({
      open: false,
      query: '',
      types: [...SEARCH_TYPES],
      response: null,
      status: 'idle'
    })
  })
})
