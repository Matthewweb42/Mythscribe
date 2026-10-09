import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { KnowledgeConversion } from '@shared/knowledge'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ConversionDialog } from './ConversionDialog'
import { costLine } from './conversionText'
import { resetConversionStore, useConversionStore } from './conversionStore'

const PENDING: KnowledgeConversion = {
  state: 'pending',
  scenes: 42,
  costUsd: 0.12,
  priced: true,
  model: 'deepseek/deepseek-v4-flash',
  source: 'ownKey',
  minutes: 6,
  deferred: false
}

let calls: Channel[]
let push: ((conversion: KnowledgeConversion) => void) | null
let refuse: boolean

beforeEach(() => {
  resetConversionStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  push = null
  refuse = false
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
      calls.push(channel)
      if (channel === 'knowledge:later') return { ...PENDING, deferred: true } as Output<C>
      if (channel === 'knowledge:convert') {
        if (refuse) throw new IpcRequestError({ code: 'IO', message: 'Could not write the backup' })
        return { ...PENDING, state: 'done', scenes: 0 } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: (channel, listener) => {
      if (channel === 'knowledge:conversionChanged') {
        push = listener as (conversion: KnowledgeConversion) => void
      }
      return () => {}
    }
  }
  setIpcClient(client)
  useConversionStore.getState().subscribe()
})
afterEach(() => {
  resetConversionStore()
})

const announce = (conversion: KnowledgeConversion): void => {
  act(() => push?.(conversion))
}

describe('ConversionDialog (F-9.14, D11)', () => {
  it('stays closed until main says scenes wait, and for none or done', () => {
    render(<ConversionDialog />)
    expect(screen.queryByTestId('conversion-dialog')).toBeNull()
    announce({ ...PENDING, state: 'none', scenes: 0 })
    expect(screen.queryByTestId('conversion-dialog')).toBeNull()
    announce(PENDING)
    expect(screen.getByRole('dialog', { name: 'Update your story index' })).toHaveTextContent(
      '42 scenes were read by an earlier version and need one more reading.'
    )
    expect(screen.getByTestId('conversion-cost')).toHaveTextContent(
      'Estimated cost: about $0.12 on your own key (deepseek/deepseek-v4-flash).'
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('About 6 minutes in the background')
    expect(screen.getByRole('dialog')).toHaveTextContent('A full backup is made first.')
  })

  it('closes on Later for this session', async () => {
    render(<ConversionDialog />)
    announce({ ...PENDING, scenes: 1 })
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '1 scene was read by an earlier version and needs one more reading.'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(calls).toEqual(['knowledge:later'])
    expect(screen.queryByTestId('conversion-dialog')).toBeNull()
  })

  it('starts the pass on Update now, and toasts a failed backup with the dialog left open', async () => {
    render(<ConversionDialog />)
    announce(PENDING)
    refuse = true
    await userEvent.click(screen.getByRole('button', { name: 'Update now' }))
    expect(useDialogStore.getState().toasts.at(-1)?.message).toMatch(/Could not write the backup/)
    expect(screen.getByTestId('conversion-dialog')).toBeInTheDocument()
    refuse = false
    await userEvent.click(screen.getByRole('button', { name: 'Update now' }))
    expect(calls).toEqual(['knowledge:convert', 'knowledge:convert'])
    expect(screen.queryByTestId('conversion-dialog')).toBeNull()
  })

  it('words the cost for a local model, MythScribe Cloud, and an unpriced model', () => {
    expect(costLine({ ...PENDING, source: 'local', costUsd: 0 })).toBe(
      'Free: it runs on your local model.'
    )
    expect(costLine({ ...PENDING, source: 'cloud', costUsd: 0.001 })).toBe(
      'Estimated cost: about <$0.01 from your MythScribe Cloud balance (deepseek/deepseek-v4-flash).'
    )
    expect(costLine({ ...PENDING, priced: false, model: 'llama' })).toBe(
      'Cost unknown: llama is not in the price table.'
    )
  })
})
