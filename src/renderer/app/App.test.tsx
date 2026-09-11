import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, RecentProject } from '@shared/ipc/contract'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { App } from './App'

const info: ProjectInfo = {
  id: '1',
  name: 'Smoke',
  format: 'novel',
  path: '/tmp/Smoke.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 1
}

const recent: RecentProject = {
  path: '/tmp/Smoke Novel.mythscribe',
  name: 'Smoke Novel',
  format: 'novel',
  lastOpened: '2026-09-10T12:00:00.000Z',
  exists: true
}

/** Main→renderer event listeners captured by `install()`, keyed by event name. */
const listeners = new Map<string, (payload: unknown) => void>()

beforeEach(() => {
  listeners.clear()
  resetPendingSaves()
  useProjectStore.setState({ current: null, ready: false, busy: false, recents: [] })
  useDialogStore.setState({ modals: [], toasts: [] })
  document.title = ''
})

function install(overrides: Partial<Record<string, unknown>> = {}): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string) => {
    if (channel in overrides) {
      const v = overrides[channel]
      if (v instanceof Error) throw v
      return v
    }
    if (channel === 'recents:list') return []
    return null
  })
  const on = (event: string, listener: (payload: unknown) => void): (() => void) => {
    listeners.set(event, listener)
    return () => {
      listeners.delete(event)
    }
  }
  setIpcClient({ invoke, on } as unknown as IpcClient)
  return invoke
}

/** Delivers a main→renderer event to the listener the app registered for it. */
function fire(event: string, payload: unknown): void {
  const listener = listeners.get(event)
  if (!listener) throw new Error(`No listener registered for ${event}`)
  act(() => listener(payload))
}

async function fillWizard(name: string, format: RegExp): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
  await userEvent.type(await screen.findByRole('textbox', { name: 'Project name' }), name)
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(await screen.findByRole('radio', { name: format }))
  await userEvent.click(screen.getByRole('button', { name: 'Create' }))
}

describe('App', () => {
  it('shows the welcome screen, creates a project through the wizard, then closes it', async () => {
    const invoke = install({ 'project:create': { ...info, format: 'epic' } })
    render(<App />)
    await fillWizard('Smoke', /^epic/i)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    expect(invoke).toHaveBeenCalledWith('project:create', {
      name: 'Smoke',
      format: 'epic',
      directory: undefined
    })
    expect(screen.getByRole('status')).toHaveTextContent('Created "Smoke"')

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect(await screen.findByRole('button', { name: /new project/i })).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('project:close', undefined)
  })

  it('shows the project name and format in the shell header, window title, and card (F-1.5)', async () => {
    install({ 'project:create': { ...info, name: 'Serial', format: 'webnovel' } })
    render(<App />)
    await fillWizard('Serial', /^web novel/i)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Serial')
    expect(screen.getByRole('banner')).toHaveTextContent('/ Serial · Web novel')
    expect(document.title).toBe('Serial — MythScribe')
    const card = within(screen.getByTestId('project-card'))
    expect(card.getByText('Web novel')).toBeInTheDocument()
    expect(card.getByText('Volume 1')).toBeInTheDocument()
    expect(card.getByText('Arc')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(document.title).toBe('MythScribe')
    expect(screen.getByRole('banner')).toHaveTextContent(/^MythScribe$/)
  })

  it('Cancel in the close confirmation keeps the project open', async () => {
    const invoke = install({ 'project:current': info })
    render(<App />)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-name')).toHaveTextContent('Smoke')
    expect(invoke).not.toHaveBeenCalledWith('project:close', undefined)
  })

  it('shows create errors inline in the wizard and keeps it open', async () => {
    install({ 'project:create': new Error('Folder is not empty: /x') })
    render(<App />)
    await fillWizard('Smoke', /^novel/i)
    const wizard = screen.getByRole('dialog', { name: 'Choose a format' })
    expect(await within(wizard).findByRole('alert')).toHaveTextContent('Folder is not empty: /x')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('keeps the wizard open without a toast when the save dialog is cancelled', async () => {
    const invoke = install({ 'project:create': null })
    render(<App />)
    await fillWizard('Smoke', /^novel/i)
    expect(invoke).toHaveBeenCalledWith('project:create', {
      name: 'Smoke',
      format: 'novel',
      directory: undefined
    })
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('dialog', { name: 'Choose a format' })).toBeInTheDocument()
  })

  it('Cancel in the wizard returns to the welcome buttons', async () => {
    install()
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
    await screen.findByRole('dialog', { name: 'New project' })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument()
  })

  it('surfaces open errors as toasts', async () => {
    install({ 'project:open': new Error('No MythScribe project at /x') })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /open project/i }))
    expect(await screen.findByRole('status')).toHaveTextContent('No MythScribe project at /x')
  })

  it('shows the logo and opens a recent project from the list', async () => {
    const invoke = install({
      'recents:list': [recent],
      'project:open': { ...info, name: 'Smoke Novel', path: recent.path }
    })
    render(<App />)
    expect(await screen.findByRole('img', { name: 'MythScribe' })).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Smoke Novel' }))
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke Novel')
    expect(invoke).toHaveBeenCalledWith('project:open', { path: recent.path })
    expect(screen.getByRole('status')).toHaveTextContent('Opened "Smoke Novel"')
  })

  it('surfaces a failed recent open as a toast and refreshes the list', async () => {
    const invoke = install({
      'recents:list': [recent],
      'project:open': new IpcRequestError({
        code: 'NOT_FOUND',
        message: 'No MythScribe project at /x'
      })
    })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Smoke Novel' }))
    expect(await screen.findByRole('status')).toHaveTextContent('No MythScribe project at /x')
    const listCalls = invoke.mock.calls.filter(([c]) => c === 'recents:list')
    expect(listCalls.length).toBeGreaterThanOrEqual(2)
    expect(screen.getByRole('button', { name: 'Smoke Novel' })).toBeInTheDocument()
  })

  it('removes a recent project from the list', async () => {
    const invoke = install({ 'recents:list': [recent], 'recents:remove': [] })
    render(<App />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove Smoke Novel from recent projects' })
    )
    expect(invoke).toHaveBeenCalledWith('recents:remove', { path: recent.path })
    expect(screen.queryByRole('button', { name: 'Smoke Novel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Recent projects' })).not.toBeInTheDocument()
  })

  it('flushes pending saves and closes the window when the OS asks to close it', async () => {
    const invoke = install({ 'project:current': info })
    render(<App />)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    const flush = vi.fn(async () => {})
    registerPendingSave(flush)
    fire('window:close-requested', null)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('window:close', undefined))
    expect(flush).toHaveBeenCalledTimes(1)
    const closeCall = invoke.mock.calls.findIndex(([c]) => c === 'window:close')
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      invoke.mock.invocationCallOrder[closeCall] ?? -1
    )
  })

  it('keeps the window open with an error toast when a pending save fails', async () => {
    const invoke = install({ 'project:current': info })
    render(<App />)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    registerPendingSave(async () => {
      throw new Error('Could not save Chapter 1')
    })
    fire('window:close-requested', null)
    expect(await screen.findByRole('status')).toHaveTextContent('Could not save Chapter 1')
    expect(invoke).not.toHaveBeenCalledWith('window:close', undefined)
    expect(screen.getByTestId('project-name')).toHaveTextContent('Smoke')
  })
})
