import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CreateProjectWizard } from './CreateProjectWizard'

function setup(signedInEmail: string | null = null): {
  onCancel: ReturnType<typeof vi.fn>
  onCreate: ReturnType<typeof vi.fn>
} {
  const onCancel = vi.fn()
  const onCreate = vi.fn(async () => {})
  render(
    <CreateProjectWizard
      busy={false}
      signedInEmail={signedInEmail}
      onCancel={onCancel}
      onCreate={onCreate}
    />
  )
  return { onCancel, onCreate }
}

async function goToFormatStep(name: string): Promise<void> {
  await userEvent.type(screen.getByRole('textbox', { name: 'Project name' }), name)
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('dialog', { name: 'Choose a format' })
}

async function goToSourceStep(name: string): Promise<void> {
  await goToFormatStep(name)
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('dialog', { name: 'Choose an AI source' })
}

describe('CreateProjectWizard', () => {
  it('rejects an empty or whitespace name', async () => {
    const { onCreate } = setup()
    expect(screen.getByRole('dialog', { name: 'New project' })).toHaveTextContent('Step 1 of 3')
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
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 2 of 3')
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: /^novel/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^epic/i })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /^web novel/i })).not.toBeChecked()
    const webnovel = screen.getByRole('radio', { name: /^web novel/i })
    expect(webnovel.closest('label')).toHaveTextContent('Arc')
    expect(webnovel.closest('label')).toHaveTextContent('Volume 1')
  })

  it('creates with the trimmed name, the chosen format, and the own-key default', async () => {
    const { onCreate } = setup()
    await goToFormatStep('  My Book  ')
    await userEvent.click(screen.getByRole('radio', { name: /^web novel/i }))
    expect(screen.getByRole('radio', { name: /^web novel/i })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith('My Book', 'webnovel', 'ownKey')
  })

  it('offers both AI sources on step 3, own key first, and creates with the chosen one (F-15.11)', async () => {
    const { onCreate } = setup()
    await goToSourceStep('My Book')
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 3 of 3')
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByRole('radio', { name: /^my own key/i })).toBeChecked()
    expect(screen.getByTestId('wizard-source-hint')).toHaveTextContent('Settings › AI')
    await userEvent.click(screen.getByRole('radio', { name: /^mythscribe cloud/i }))
    expect(screen.getByTestId('wizard-source-hint')).toHaveTextContent(
      'Sign in and buy credits under Settings › Account'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith('My Book', 'novel', 'cloud')
  })

  it('names the signed-in account under the Cloud option', async () => {
    setup('ada@example.com')
    await goToSourceStep('My Book')
    await userEvent.click(screen.getByRole('radio', { name: /^mythscribe cloud/i }))
    expect(screen.getByTestId('wizard-source-hint')).toHaveTextContent(
      'Signed in as ada@example.com'
    )
  })

  it('moves on with Enter from the format step and submits with Enter from the source step', async () => {
    const { onCreate } = setup()
    await goToFormatStep('My Book')
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'Choose an AI source' })
    expect(onCreate).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onCreate).toHaveBeenCalledWith('My Book', 'novel', 'ownKey')
  })

  it('Back returns a step at a time with the format and the name preserved', async () => {
    setup()
    await goToFormatStep('My Book')
    await userEvent.click(screen.getByRole('radio', { name: /^epic/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('radio', { name: /^epic/i })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('My Book')
  })

  it('Escape and Cancel call onCancel on every step', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('dialog', { name: 'Choose an AI source' })
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(5)
  })

  it('shows a failed create inline and clears it on Back', async () => {
    const { onCreate } = setup()
    onCreate.mockRejectedValueOnce(new Error('A project already exists at /x'))
    await goToSourceStep('My Book')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A project already exists at /x')
    expect(screen.getByRole('dialog', { name: 'Choose an AI source' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('disables the last step and Escape while busy', async () => {
    const onCancel = vi.fn()
    const props = { signedInEmail: null, onCancel, onCreate: vi.fn(async () => {}) }
    const { rerender } = render(<CreateProjectWizard busy={false} {...props} />)
    await goToSourceStep('My Book')
    rerender(<CreateProjectWizard busy {...props} />)
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
  })
})
