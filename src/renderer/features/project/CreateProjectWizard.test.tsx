import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CreateProjectWizard } from './CreateProjectWizard'

function setup(busy = false): {
  onCancel: ReturnType<typeof vi.fn>
  onCreate: ReturnType<typeof vi.fn>
} {
  const onCancel = vi.fn()
  const onCreate = vi.fn(async () => {})
  render(<CreateProjectWizard busy={busy} onCancel={onCancel} onCreate={onCreate} />)
  return { onCancel, onCreate }
}

async function goToFormatStep(name: string): Promise<void> {
  await userEvent.type(screen.getByRole('textbox', { name: 'Project name' }), name)
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('dialog', { name: 'Choose a format' })
}

describe('CreateProjectWizard', () => {
  it('rejects an empty or whitespace name', async () => {
    const { onCreate } = setup()
    expect(screen.getByRole('dialog', { name: 'New project' })).toHaveTextContent('Step 1 of 2')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A name is required')
    await userEvent.type(screen.getByRole('textbox', { name: 'Project name' }), '   {Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('A name is required')
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('rejects a name longer than 200 characters', async () => {
    const { onCreate } = setup()
    await userEvent.type(screen.getByRole('textbox', { name: 'Project name' }), 'a'.repeat(201))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Keep the name under 200 characters')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('shows the three format cards with Novel selected by default', async () => {
    setup()
    await goToFormatStep('My Book')
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 2 of 2')
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: /^novel/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^epic/i })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /^web novel/i })).not.toBeChecked()
    const webnovel = screen.getByRole('radio', { name: /^web novel/i })
    expect(webnovel.closest('label')).toHaveTextContent('Arc')
    expect(webnovel.closest('label')).toHaveTextContent('Volume 1')
  })

  it('creates with the trimmed name and the chosen format', async () => {
    const { onCreate } = setup()
    await goToFormatStep('  My Book  ')
    await userEvent.click(screen.getByRole('radio', { name: /^web novel/i }))
    expect(screen.getByRole('radio', { name: /^web novel/i })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith('My Book', 'webnovel')
  })

  it('submits on Enter from the format step', async () => {
    const { onCreate } = setup()
    await goToFormatStep('My Book')
    await userEvent.keyboard('{Enter}')
    expect(onCreate).toHaveBeenCalledWith('My Book', 'novel')
  })

  it('Back returns to step 1 with the name preserved', async () => {
    setup()
    await goToFormatStep('My Book')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('My Book')
  })

  it('Escape and Cancel call onCancel on both steps', async () => {
    const { onCancel } = setup()
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
    await goToFormatStep('My Book')
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(3)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(4)
  })

  it('disables the format-step buttons and Escape while busy', async () => {
    const { onCancel } = setup(true)
    await goToFormatStep('My Book')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
  })
})
