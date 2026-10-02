import { beforeEach, describe, expect, it } from 'vitest'
import { addWord, removeWord, type ProjectDictionary } from '@shared/dictionary'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDictionaryStore, useDictionaryStore } from './dictionaryStore'

let stored: ProjectDictionary
/** When set, the next `dictionary:*` write is refused with this message. */
let failWith: string | null
/** When set, `dictionary:get` waits for the test to call it. */
let releaseGet: (() => void) | null
let holdGet: boolean

/** A main that keeps the dictionary the way the real handlers do. */
function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'dictionary:get') {
        const answer = stored
        if (holdGet) await new Promise<void>((resolve) => (releaseGet = resolve))
        return answer as Output<C>
      }
      if (channel === 'dictionary:add' || channel === 'dictionary:remove') {
        if (failWith !== null) throw new Error(failWith)
        const { word } = input as Input<'dictionary:add'>
        stored = channel === 'dictionary:add' ? addWord(stored, word) : removeWord(stored, word)
        return stored as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
}

const store = (): ReturnType<typeof useDictionaryStore.getState> => useDictionaryStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  resetDictionaryStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  stored = { words: [] }
  failWith = null
  holdGet = false
  releaseGet = null
  setIpcClient(client())
})

describe('dictionaryStore (F-3.11)', () => {
  it('starts unloaded and loads the stored words', async () => {
    stored = { words: ['Mara', 'Zorvath'] }
    expect(store().words).toBeNull()
    await store().load()
    expect(store().words).toEqual(['Mara', 'Zorvath'])
  })

  it('adds a word and keeps the list main answers', async () => {
    await store().load()
    expect(await store().add('Zorvath')).toBe(true)
    expect(await store().add('Mara')).toBe(true)
    expect(store().words).toEqual(['Mara', 'Zorvath'])
  })

  it('removes a word', async () => {
    stored = { words: ['Mara', 'Zorvath'] }
    await store().load()
    expect(await store().remove('Mara')).toBe(true)
    expect(store().words).toEqual(['Zorvath'])
  })

  it('toasts a refused write and leaves the list as it was', async () => {
    stored = { words: ['Mara'] }
    await store().load()
    failWith = 'No project is open'
    expect(await store().add('Zorvath')).toBe(false)
    expect(await store().remove('Mara')).toBe(false)
    expect(store().words).toEqual(['Mara'])
    expect(toasts()).toEqual(['No project is open', 'No project is open'])
  })

  it('drops a load that answers after the project closed', async () => {
    stored = { words: ['Mara'] }
    holdGet = true
    const loading = store().load()
    await Promise.resolve()
    store().clear()
    releaseGet?.()
    await loading
    expect(store().words).toBeNull()
  })

  it('clear empties the store', async () => {
    stored = { words: ['Mara'] }
    await store().load()
    store().clear()
    expect(store().words).toBeNull()
  })
})
