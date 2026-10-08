import { vi } from 'vitest'
import type { ExportProgress } from '@shared/bookExport'
import { defaultBookDetails, type BookDetails } from '@shared/bookDetails'
import {
  copyName,
  defaultCompileProjectState,
  duplicateFormat,
  findCompileFormat,
  type CompileFormat,
  type CompileProjectState
} from '@shared/compileFormat'
import type { CompileSource } from '@shared/compileModel'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'

/**
 * A fake main for the compile window's tests (Compile v2, CV3): the compile state, the format
 * library, Book details, the source, and `compile:run`, all in memory; every call is recorded
 * in `calls`. A test may hold `compile:run` open (`holdRun`) to see the window while it runs.
 */
export interface FakeCompileMain {
  state: CompileProjectState
  library: CompileFormat[]
  details: BookDetails
  source: CompileSource
  calls: { channel: string; input: unknown }[]
  /** The path `compile:run` answers; null as when the save dialog is cancelled. */
  runPath: string | null
  /** Pushes a progress step to the window's listener. */
  pushProgress: ((progress: ExportProgress) => void) | null
  /** Settles a held `compile:run`. */
  finishRun: (() => void) | null
  holdRun: boolean
}

const emptySource = (): CompileSource => ({
  front: [],
  manuscript: [
    {
      id: 'ch-1',
      kind: 'folder',
      level: 'chapter',
      depth: 0,
      title: 'Chapter 1',
      meta: null,
      tags: [],
      content: null,
      synopsis: '',
      notes: null
    },
    {
      id: 'sc-1',
      kind: 'document',
      level: 'scene',
      depth: 1,
      title: 'Scene 1',
      meta: null,
      tags: [],
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The storm broke.' }] }]
      },
      synopsis: '',
      notes: null
    }
  ],
  end: []
})

export function installFakeCompileMain(): FakeCompileMain {
  const fake: FakeCompileMain = {
    state: defaultCompileProjectState(),
    library: [],
    details: defaultBookDetails(),
    source: emptySource(),
    calls: [],
    runPath: '/books/Book.docx',
    pushProgress: null,
    finishRun: null,
    holdRun: false
  }
  let ids = 0
  const answer = async (channel: string, input: unknown): Promise<unknown> => {
    switch (channel) {
      case 'compileState:get':
        return structuredClone(fake.state)
      case 'compileState:set':
        fake.state = structuredClone(input as CompileProjectState)
        return fake.state
      case 'compileFormat:list':
        return structuredClone(fake.library)
      case 'compileFormat:create': {
        const { fromId, name } = input as { fromId: string; name?: string }
        const from = findCompileFormat(fake.library, fromId)
        if (!from) throw new Error('NOT_FOUND')
        const created = duplicateFormat(
          from,
          `user:${++ids}`,
          name ?? copyName(fake.library, from.name)
        )
        fake.library.push(created)
        return created
      }
      case 'compileFormat:save': {
        const format = input as CompileFormat
        fake.library = fake.library.map((f) => (f.id === format.id ? format : f))
        return format
      }
      case 'compileFormat:delete':
        fake.library = fake.library.filter((f) => f.id !== (input as { id: string }).id)
        return null
      case 'compile:source':
        return fake.source
      case 'bookDetails:get':
        return fake.details
      case 'bookDetails:set':
        fake.details = { ...(input as BookDetails), cover: fake.details.cover }
        return fake.details
      case 'bookDetails:setCover':
        fake.details = { ...fake.details, cover: 'cover.0a1b2c3d.png' }
        return fake.details
      case 'bookDetails:removeCover':
        fake.details = { ...fake.details, cover: null }
        return fake.details
      case 'compile:run': {
        const { output } = input as { output: string }
        if (fake.holdRun) await new Promise<void>((resolve) => (fake.finishRun = resolve))
        return fake.runPath === null ? null : { path: fake.runPath, output, words: 3 }
      }
      default:
        throw new Error(`unexpected ${channel}`)
    }
  }
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    fake.calls.push({ channel, input })
    return answer(channel, input)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: <E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) => {
      if (event !== 'export:progress') return () => undefined
      fake.pushProgress = (progress) => listener(progress as EventPayload<E>)
      return () => {
        fake.pushProgress = null
      }
    }
  }
  setIpcClient(client)
  return fake
}

/** The inputs a channel was called with, in order. */
export function callsTo(fake: FakeCompileMain, channel: string): unknown[] {
  return fake.calls.filter((c) => c.channel === channel).map((c) => c.input)
}
