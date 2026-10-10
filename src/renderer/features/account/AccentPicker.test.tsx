import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventName, Input, Output } from '@shared/ipc/contract'
import type { SupporterStatus } from '@shared/license'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { AccentPicker } from './AccentPicker'
import { resetAccountStore, useAccountStore } from './accountStore'
import { resetAppAccessStore, useAppAccessStore } from './appAccessStore'

const UNLICENSED: SupporterStatus = {
  licensed: false,
  since: null,
  validUntil: null,
  offline: false,
  product: { variantId: 'supporter-39', priceCents: 3900 },
  accent: 'default'
}
const ENDS = '2026-11-07T00:00:00.000Z'
/** The accents follow the access (changed by the author 2026-10-10): on in the trial. */
const access = (state: 'trial' | 'licensed' | 'expired'): void =>
  useAppAccessStore.setState({ access: { state, trialEndsAt: ENDS, daysLeft: 0 } })

const LICENSED: SupporterStatus = {
  licensed: true,
  since: '2026-09-20T10:00:00.000Z',
  validUntil: '2026-10-04T10:00:00.000Z',
  offline: false,
  product: null,
  accent: 'ember'
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
}

function fakeClient(): Fake {
  const fake: Fake = {
    calls: [],
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        fake.calls.push({ channel, input })
        if (channel !== 'account:setAccent') throw new Error(`unexpected ${channel}`)
        // Main answers the status it stored; the pick itself is checked on the call.
        return { ...LICENSED, accent: 'violet' } as Output<C>
      },
      on<E extends EventName>(event: E): () => void {
        throw new Error(`unexpected ${event}`)
      }
    }
  }
  return fake
}

let fake: Fake

beforeEach(() => {
  resetAccountStore()
  resetAppAccessStore()
  fake = fakeClient()
  setIpcClient(fake.client)
})
afterEach(() => {
  resetAccountStore()
  resetAppAccessStore()
})

describe('AccentPicker (F-15.9)', () => {
  it('locks every accent but the default after the trial ends unpaid, and says why', () => {
    useAccountStore.setState({ supporter: UNLICENSED })
    access('expired')
    render(<AccentPicker />)
    expect(screen.getByText('Accent colour — MythScribe license needed')).toBeInTheDocument()
    const moss = screen.getByTestId('account-accent-default')
    expect(moss).toBeEnabled()
    expect(moss).toHaveAttribute('aria-pressed', 'true')
    expect(moss).toHaveAccessibleName('Moss accent')
    for (const id of ['ember', 'sky', 'rose', 'gold', 'violet']) {
      const swatch = screen.getByTestId(`account-accent-${id}`)
      expect(swatch).toBeDisabled()
      expect(swatch).toHaveAttribute('title', 'MythScribe license needed')
    }
  })

  it('locks the accents while nothing is loaded yet', () => {
    render(<AccentPicker />)
    expect(screen.getByTestId('account-accent-violet')).toBeDisabled()
    expect(screen.getByTestId('account-accent-default')).toHaveAttribute('aria-pressed', 'true')
  })

  it('marks the chosen accent and sends a pick to main with a license', async () => {
    useAccountStore.setState({ supporter: LICENSED })
    access('licensed')
    render(<AccentPicker />)
    expect(screen.getByText('Accent colour')).toBeInTheDocument()
    const ember = screen.getByTestId('account-accent-ember')
    expect(ember).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('account-accent-default')).toHaveAttribute('aria-pressed', 'false')

    const violet = screen.getByTestId('account-accent-violet')
    expect(violet).toBeEnabled()
    await userEvent.click(violet)
    expect(fake.calls).toEqual([{ channel: 'account:setAccent', input: { accent: 'violet' } }])
    await waitFor(() => expect(violet).toHaveAttribute('aria-pressed', 'true'))
    expect(useAccountStore.getState().supporter?.accent).toBe('violet')
  })

  it('unlocks the accents during the trial, without a license', () => {
    useAccountStore.setState({ supporter: UNLICENSED })
    access('trial')
    render(<AccentPicker />)
    expect(screen.getByText('Accent colour')).toBeInTheDocument()
    expect(screen.getByTestId('account-accent-violet')).toBeEnabled()
  })

  it('paints each swatch in the colour it stands for', () => {
    useAccountStore.setState({ supporter: LICENSED })
    render(<AccentPicker />)
    // The one dynamic value in the picker: the preset's own hex from ACCENTS.
    expect(screen.getByTestId('account-accent-gold')).toHaveStyle({ backgroundColor: '#e2b84a' })
  })

  it('disables the swatches while a pick is in flight', () => {
    useAccountStore.setState({ supporter: LICENSED, supporterBusy: true })
    access('licensed')
    render(<AccentPicker />)
    expect(screen.getByTestId('account-accent-default')).toBeDisabled()
    expect(screen.getByTestId('account-accent-violet')).toBeDisabled()
  })
})
