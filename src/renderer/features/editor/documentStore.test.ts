import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'

const hello: TiptapNodeT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]
}

interface Pending {
  id: string
  resolve: (content: TiptapNodeT | null) => void
  reject: (err: Error) => void
}

/** A client whose `document:get` calls resolve only when the test says so, in any order. */
function deferredClient(): { client: IpcClient; pending: Pending[] } {
  const pending: Pending[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel !== 'document:get') throw new Error(`unexpected ${channel}`)
      const { id } = input as Input<'document:get'>
      return new Promise<Output<C>>((resolve, reject) => {
        pending.push({
          id,
          resolve: (content) => resolve({ id, content } as Output<C>),
          reject
        })
      })
    },
    on: () => () => {}
  }
  return { client, pending }
}

let pending: Pending[]

beforeEach(() => {
  useDocumentStore.getState().clear()
  const deferred = deferredClient()
  pending = deferred.pending
  setIpcClient(deferred.client)
})

describe('useDocumentStore', () => {
  it('sets the id at once and the content when document:get resolves', async () => {
    const loading = useDocumentStore.getState().load('scene-1')
    expect(useDocumentStore.getState()).toMatchObject({ id: 'scene-1', content: null })
    pending[0]?.resolve(hello)
    await loading
    expect(useDocumentStore.getState()).toMatchObject({
      id: 'scene-1',
      content: hello,
      dirty: false
    })
  })

  it('loads a never-written document as the empty document', async () => {
    const loading = useDocumentStore.getState().load('scene-1')
    pending[0]?.resolve(null)
    await loading
    expect(useDocumentStore.getState().content).toEqual(EMPTY_DOC)
  })

  it('drops a response from a superseded load', async () => {
    const first = useDocumentStore.getState().load('scene-1')
    const second = useDocumentStore.getState().load('scene-2')
    pending[1]?.resolve(hello)
    await second
    pending[0]?.resolve({ type: 'doc', content: [{ type: 'paragraph' }] })
    await first
    expect(useDocumentStore.getState()).toMatchObject({ id: 'scene-2', content: hello })
  })

  it('drops a response that arrives after clear()', async () => {
    const loading = useDocumentStore.getState().load('scene-1')
    useDocumentStore.getState().clear()
    pending[0]?.resolve(hello)
    await loading
    expect(useDocumentStore.getState()).toMatchObject({ id: null, content: null })
  })

  it('resets dirty on load and clear, and propagates load errors', async () => {
    useDocumentStore.getState().setDirty(true)
    expect(useDocumentStore.getState().dirty).toBe(true)
    const loading = useDocumentStore.getState().load('scene-1')
    expect(useDocumentStore.getState().dirty).toBe(false)
    pending[0]?.reject(new Error('Database is locked'))
    await expect(loading).rejects.toThrow('Database is locked')
    useDocumentStore.getState().setDirty(true)
    useDocumentStore.getState().clear()
    expect(useDocumentStore.getState().dirty).toBe(false)
  })
})
