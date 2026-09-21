import { beforeEach, describe, expect, it } from 'vitest'
import type { CrashKind } from '@shared/diagnostics'
import {
  CRASH_DIALOG_TITLE,
  installCrashHandlers,
  processGoneError,
  type CrashProcessLike
} from './crashHandlers'

type Listener = (value: never) => void

let listeners: Map<string, Listener>
let reported: { kind: CrashKind; error: unknown }[]
let boxes: { title: string; content: string }[]

const fakeProcess: CrashProcessLike = {
  on(event: string, listener: Listener) {
    listeners.set(event, listener)
    return fakeProcess
  }
}

const install = (): void =>
  installCrashHandlers({
    process: fakeProcess,
    report: (kind, error) => void reported.push({ kind, error }),
    showErrorBox: (title, content) => void boxes.push({ title, content })
  })

const raise = (event: string, value: unknown): void => {
  const listener = listeners.get(event)
  if (!listener) throw new Error(`Nothing listens for ${event}`)
  listener(value as never)
}

beforeEach(() => {
  listeners = new Map()
  reported = []
  boxes = []
})

describe('installCrashHandlers (F-15.8)', () => {
  it('reports an uncaught exception and still shows the box Electron would have shown', () => {
    install()
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at run (/app/out/main/index.js:1:1)'

    raise('uncaughtException', error)

    expect(reported).toEqual([{ kind: 'main', error }])
    expect(boxes).toEqual([
      { title: CRASH_DIALOG_TITLE, content: `Uncaught Exception:\n${error.stack}` }
    ])
  })

  it('does the same for an unhandled rejection, whatever was rejected with', () => {
    install()

    raise('unhandledRejection', 'no such file')

    expect(reported).toEqual([{ kind: 'main', error: 'no such file' }])
    expect(boxes[0]).toEqual({
      title: CRASH_DIALOG_TITLE,
      content: 'Unhandled Promise Rejection:\nno such file'
    })
  })

  it('shows an error without a stack by name and message', () => {
    install()
    const error = new Error('nope')
    error.stack = undefined

    raise('uncaughtException', error)

    expect(boxes[0]?.content).toBe('Uncaught Exception:\nError: nope')
  })

  // `reportError` writes app-state.json synchronously, which can throw (disk full, EPERM). A
  // throw escaping the listener would end the process before the box is raised.
  it('still shows the crash box when the report itself fails', () => {
    installCrashHandlers({
      process: fakeProcess,
      report: () => {
        throw new Error('app-state.json: ENOSPC')
      },
      showErrorBox: (title, content) => void boxes.push({ title, content })
    })
    const error = new Error('boom')

    expect(() => raise('uncaughtException', error)).not.toThrow()
    expect(boxes).toEqual([
      { title: CRASH_DIALOG_TITLE, content: `Uncaught Exception:\n${error.stack}` }
    ])
  })
})

describe('processGoneError (F-15.8)', () => {
  it('carries the event’s own words and nothing from the dead process', () => {
    expect(processGoneError('renderer', { reason: 'crashed', exitCode: 133 })).toEqual({
      name: 'RenderProcessGone',
      message: 'reason=crashed exitCode=133',
      stack: null
    })
    expect(
      processGoneError('child', { reason: 'abnormal-exit', exitCode: 1, type: 'GPU' })
    ).toEqual({
      name: 'ChildProcessGone',
      message: 'reason=abnormal-exit exitCode=1 type=GPU',
      stack: null
    })
  })
})
