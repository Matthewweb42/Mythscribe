import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AUTHOR_RULES_TEXT_MAX,
  AuthorRules,
  BANNED_PHRASES_MAX,
  DEFAULT_BANNED_PHRASES,
  defaultAuthorRules
} from '@shared/authorRules'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, IpcRequestError, type IpcClient } from '@renderer/lib/ipc'
import { AuthorRulesSection } from './AuthorRulesSection'
import { resetAuthorRulesStore, useAuthorRulesStore } from './authorRulesStore'
import { resetVoiceStore } from './voiceStore'

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  rules: AuthorRules
  /** What `authorRules:set` answers; by default the sent value. */
  setAnswer: (value: AuthorRules) => AuthorRules
}

function fakeClient(initial: AuthorRules): Fake {
  const calls: Fake['calls'] = []
  const fake: Fake = {
    calls,
    rules: initial,
    setAnswer: (value) => value,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push({ channel, input })
        switch (channel) {
          case 'authorRules:get':
            return fake.rules as Output<C>
          case 'authorRules:set':
            fake.rules = fake.setAnswer(AuthorRules.parse(input))
            return fake.rules as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on: () => () => {}
    }
  }
  return fake
}

const SEEDED = defaultAuthorRules()
let fake: Fake

const sets = (): AuthorRules[] =>
  fake.calls.filter((c) => c.channel === 'authorRules:set').map((c) => AuthorRules.parse(c.input))
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const rulesField = (): HTMLElement => screen.getByLabelText('Style rules')
const newPhrase = (): HTMLElement => screen.getByLabelText('New banned phrase')
/** The chips in order; an empty array when the list is gone (the section shows a note instead). */
const phrases = (): string[] => {
  const list = screen.queryByRole('list', { name: 'Banned phrases' })
  if (list === null) return []
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.textContent?.replace('×', '').trim() ?? '')
}

/** Renders the section with `initial` loaded, the way `App.tsx` loads it with the project. */
async function open(initial: AuthorRules = SEEDED): Promise<void> {
  fake = fakeClient(initial)
  setIpcClient(fake.client)
  render(<AuthorRulesSection />)
  await useAuthorRulesStore.getState().load()
  await screen.findByTestId('author-rules-section')
}

beforeEach(() => {
  resetAuthorRulesStore()
  resetVoiceStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetAuthorRulesStore()
  resetVoiceStore()
})

describe('AuthorRulesSection (F-14.2)', () => {
  it('renders nothing until the rules load, then the help line and the seeded phrases', async () => {
    fake = fakeClient(SEEDED)
    setIpcClient(fake.client)
    render(<AuthorRulesSection />)
    expect(screen.queryByTestId('author-rules-section')).not.toBeInTheDocument()
    await useAuthorRulesStore.getState().load()
    expect(await screen.findByTestId('author-rules-section')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Author rules' })).toBeInTheDocument()
    expect(screen.getByText(/Hard constraints sent with every ghost-text/)).toBeInTheDocument()
    expect(rulesField()).toHaveValue('')
    expect(rulesField()).toHaveAttribute('maxlength', String(AUTHOR_RULES_TEXT_MAX))
    expect(phrases()).toEqual([...DEFAULT_BANNED_PHRASES])
    expect(
      screen.getByText(`${DEFAULT_BANNED_PHRASES.length} of ${BANNED_PHRASES_MAX}`)
    ).toBeInTheDocument()
  })

  it('writes the typed rules once after the debounce and counts the characters', async () => {
    await open({ rules: '', bannedPhrases: [] })
    await userEvent.type(rulesField(), 'British spelling.')
    expect(rulesField()).toHaveValue('British spelling.')
    expect(screen.getByText(`17 / ${AUTHOR_RULES_TEXT_MAX}`)).toBeInTheDocument()
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]).toEqual({ rules: 'British spelling.', bannedPhrases: [] })
  })

  it('adds a phrase with the Add button and with Enter, and empties the field', async () => {
    await open({ rules: '', bannedPhrases: [] })
    await userEvent.type(newPhrase(), 'picked up')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(phrases()).toEqual(['picked up'])
    expect(newPhrase()).toHaveValue('')
    await userEvent.type(newPhrase(), 'a sense of{Enter}')
    expect(phrases()).toEqual(['picked up', 'a sense of'])
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]?.bannedPhrases).toEqual(['picked up', 'a sense of'])
  })

  it('refuses a blank or duplicate phrase without a write', async () => {
    await open({ rules: '', bannedPhrases: ['delve'] })
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    await userEvent.type(newPhrase(), '   {Enter}')
    expect(phrases()).toEqual(['delve'])
    await userEvent.clear(newPhrase())
    await userEvent.type(newPhrase(), 'Delve{Enter}')
    expect(phrases()).toEqual(['delve'])
    expect(newPhrase()).toHaveValue('Delve') // kept so the author can fix it
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sets()).toHaveLength(0)
  })

  it('removes a phrase by name', async () => {
    await open({ rules: '', bannedPhrases: ['delve', 'tapestry'] })
    await userEvent.click(screen.getByRole('button', { name: 'Remove phrase delve' }))
    expect(phrases()).toEqual(['tapestry'])
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(sets()[0]?.bannedPhrases).toEqual(['tapestry'])
  })

  it('restores the missing seeded phrases without dropping the author’s own', async () => {
    await open({ rules: '', bannedPhrases: ['picked up'] })
    const restore = screen.getByRole('button', { name: 'Restore default phrases' })
    expect(restore).toBeEnabled()
    await userEvent.click(restore)
    expect(phrases()).toEqual(['picked up', ...DEFAULT_BANNED_PHRASES])
    await waitFor(() => expect(sets()).toHaveLength(1))
    expect(restore).toBeDisabled() // nothing left to restore
  })

  it('reverts and toasts when the write is refused', async () => {
    await open({ rules: '', bannedPhrases: ['delve'] })
    fake.setAnswer = () => {
      throw new IpcRequestError({ code: 'IO', message: 'Disk is read-only' })
    }
    await userEvent.click(screen.getByRole('button', { name: 'Remove phrase delve' }))
    expect(phrases()).toEqual([])
    await waitFor(() => expect(toasts()).toEqual(['Disk is read-only']))
    expect(phrases()).toEqual(['delve'])
  })
})
