import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
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

beforeEach(() => {
  useProjectStore.setState({ current: null, ready: false, busy: false })
  useDialogStore.setState({ modals: [], toasts: [] })
})

function install(overrides: Partial<Record<string, unknown>> = {}): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string) => {
    if (channel in overrides) {
      const v = overrides[channel]
      if (v instanceof Error) throw v
      return v
    }
    return null
  })
  setIpcClient({ invoke, on: () => () => {} } as unknown as IpcClient)
  return invoke
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

  it('surfaces create errors as toasts and keeps the wizard open', async () => {
    install({ 'project:create': new Error('Folder is not empty: /x') })
    render(<App />)
    await fillWizard('Smoke', /^novel/i)
    expect(await screen.findByRole('status')).toHaveTextContent('Folder is not empty: /x')
    expect(screen.getByRole('dialog', { name: 'Choose a format' })).toBeInTheDocument()
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
})
