import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetLibraryStore } from '@renderer/features/library/libraryStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { CreateProjectWizard } from './CreateProjectWizard'

/** What the OS dialog answers for the worldbuilding step (F-9.8). */
let chosen: string[] = []

beforeEach(() => {
  resetLibraryStore()
  chosen = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
      if (channel === 'library:choose') return chosen as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
})

function setup(
  signedInEmail: string | null = null,
  cloudAvailable: boolean | undefined = undefined
): {
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
      {...(cloudAvailable === undefined ? {} : { cloudAvailable })}
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

async function goToDialStep(name: string): Promise<void> {
  await goToSourceStep(name)
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('dialog', { name: 'Choose whether AI helps' })
}

async function goToContextStep(name: string): Promise<void> {
  await goToDialStep(name)
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('dialog', { name: 'Have worldbuilding docs? Add them' })
}

/** From the dial step: on to the worldbuilding step, then Create with no files. */
async function nextThenCreate(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Create' }))
}

describe('CreateProjectWizard', () => {
  it('rejects an empty or whitespace name', async () => {
    const { onCreate } = setup()
    expect(screen.getByRole('dialog', { name: 'New project' })).toHaveTextContent('Step 1 of 5')
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
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 2 of 5')
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: /^novel/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^epic/i })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /^web novel/i })).not.toBeChecked()
    const webnovel = screen.getByRole('radio', { name: /^web novel/i })
    expect(webnovel.closest('label')).toHaveTextContent('Arc')
    expect(webnovel.closest('label')).toHaveTextContent('Volume 1')
  })

  it('creates with the trimmed name, the chosen format, the own-key default, and the recommended level', async () => {
    const { onCreate } = setup()
    await goToFormatStep('  My Book  ')
    await userEvent.click(screen.getByRole('radio', { name: /^web novel/i }))
    expect(screen.getByRole('radio', { name: /^web novel/i })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await nextThenCreate()
    expect(onCreate).toHaveBeenCalledWith('My Book', 'webnovel', 'ownKey', 'ask', [])
  })

  it('preselects own key and shows Cloud disabled as "Coming soon" while Cloud does not serve AI', async () => {
    const { onCreate } = setup('ada@example.com')
    await goToSourceStep('My Book')
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: /^my own key/i })).toBeChecked()
    const cloud = screen.getByRole('radio', { name: /^mythscribe cloud/i })
    expect(cloud).toBeDisabled()
    expect(screen.getByTestId('wizard-cloud-coming-soon')).toHaveTextContent('Coming soon')
    await userEvent.click(screen.getByText('MythScribe Cloud', { exact: true }))
    expect(cloud).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /^local model/i })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await nextThenCreate()
    expect(onCreate).toHaveBeenCalledWith('My Book', 'novel', 'ownKey', 'ask', [])
  })

  it('offers the three AI sources on step 3, own key first, and creates with the chosen one (F-15.11, F-5.15)', async () => {
    const { onCreate } = setup(null, true)
    await goToSourceStep('My Book')
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 3 of 5')
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: /^my own key/i })).toBeChecked()
    expect(screen.getByTestId('wizard-source-hint')).toHaveTextContent('Settings › AI')
    await userEvent.click(screen.getByRole('radio', { name: /^local model/i }))
    expect(screen.getByTestId('wizard-source-hint')).toHaveTextContent('Start Ollama or LM Studio')
    await userEvent.click(screen.getByRole('radio', { name: /^mythscribe cloud/i }))
    expect(screen.getByTestId('wizard-source-hint')).toHaveTextContent(
      'Sign in and buy credits under Settings › Account'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await nextThenCreate()
    expect(screen.queryByTestId('wizard-cloud-coming-soon')).not.toBeInTheDocument()
    expect(onCreate).toHaveBeenCalledWith('My Book', 'novel', 'cloud', 'ask', [])
  })

  it('explains the background work and recommends Use AI on (chat in Ask) on step 4, with off one click away (F-5.18, 2026-10-07)', async () => {
    const { onCreate } = setup()
    await goToDialStep('My Book')
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 4 of 5')
    expect(screen.getByRole('group', { name: 'Use AI' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByTestId('wizard-dial-explainer')).toHaveTextContent('summarizes the scene')
    expect(screen.getByTestId('wizard-dial-explainer')).toHaveTextContent('flags contradictions')
    expect(screen.getByTestId('wizard-dial-explainer')).toHaveTextContent('It starts in Ask')
    const on = screen.getByRole('radio', { name: /^on/i })
    expect(on).toBeChecked()
    expect(on.closest('label')).toHaveTextContent('Recommended')
    expect(screen.getByRole('radio', { name: /^off/i }).closest('label')).not.toHaveTextContent(
      'Recommended'
    )
    await userEvent.click(screen.getByRole('radio', { name: /^off/i }))
    await nextThenCreate()
    expect(onCreate).toHaveBeenCalledWith('My Book', 'novel', 'ownKey', 'off', [])
  })

  it('names the signed-in account under the Cloud option', async () => {
    setup('ada@example.com', true)
    await goToSourceStep('My Book')
    await userEvent.click(screen.getByRole('radio', { name: /^mythscribe cloud/i }))
    expect(screen.getByTestId('wizard-source-hint')).toHaveTextContent(
      'Signed in as ada@example.com'
    )
  })

  it('moves on with Enter from the format, source, and level steps, then Create submits', async () => {
    const { onCreate } = setup()
    await goToFormatStep('My Book')
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'Choose an AI source' })
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'Choose whether AI helps' })
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'Have worldbuilding docs? Add them' })
    expect(onCreate).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith('My Book', 'novel', 'ownKey', 'ask', [])
  })

  it('takes optional worldbuilding files on step 5 and creates with them (F-9.8)', async () => {
    const { onCreate } = setup()
    await goToContextStep('My Book')
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 5 of 5')
    expect(screen.getByRole('dialog')).toHaveTextContent('review everything before it lands')
    chosen = ['/docs/people.md', '/docs/map.png']
    await userEvent.click(screen.getByTestId('wizard-context-add'))
    expect(await screen.findByRole('list', { name: 'Files to add' })).toHaveTextContent('people.md')
    chosen = ['/docs/people.md', '/docs/world.pdf']
    await userEvent.click(screen.getByTestId('wizard-context-add'))
    await screen.findByText('world.pdf')
    await userEvent.click(screen.getByRole('button', { name: 'Remove map.png' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith('My Book', 'novel', 'ownKey', 'ask', [
      '/docs/people.md',
      '/docs/world.pdf'
    ])
  })

  it('Back returns a step at a time with the choices and the name preserved', async () => {
    setup(null, true)
    await goToFormatStep('My Book')
    await userEvent.click(screen.getByRole('radio', { name: /^epic/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(await screen.findByRole('radio', { name: /^mythscribe cloud/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('radio', { name: /^mythscribe cloud/i })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
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
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('dialog', { name: 'Choose whether AI helps' })
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(6)
  })

  it('shows a failed create inline and clears it on Back', async () => {
    const { onCreate } = setup()
    onCreate.mockRejectedValueOnce(new Error('A project already exists at /x'))
    await goToContextStep('My Book')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A project already exists at /x')
    expect(
      screen.getByRole('dialog', { name: 'Have worldbuilding docs? Add them' })
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('disables the last step and Escape while busy', async () => {
    const onCancel = vi.fn()
    const props = { signedInEmail: null, onCancel, onCreate: vi.fn(async () => {}) }
    const { rerender } = render(<CreateProjectWizard busy={false} {...props} />)
    await goToContextStep('My Book')
    rerender(<CreateProjectWizard busy {...props} />)
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
  })
})
