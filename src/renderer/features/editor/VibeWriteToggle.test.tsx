import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { setIpcClient } from '@renderer/lib/ipc'
import { VibeWriteToggle } from './VibeWriteToggle'

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 2,
  ghostText: { enabled: false, idleMs: 1500 },
  ...over
})
const button = (): HTMLElement => screen.getByRole('button', { name: 'VibeWrite' })

beforeEach(() => {
  resetAiSettingsStore()
  resetPendingSaves()
  setIpcClient({
    invoke: () => Promise.reject(new Error('no ipc in this test')),
    on: () => () => {}
  })
})
afterEach(() => {
  resetAiSettingsStore()
})

describe('VibeWriteToggle (F-5.3)', () => {
  it('renders nothing until the settings load', () => {
    render(<VibeWriteToggle error={null} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('follows ghostText.enabled with aria-pressed and toggles it through the store', async () => {
    useAiSettingsStore.setState({ settings: settings() })
    render(<VibeWriteToggle error={null} />)
    expect(button()).toBeEnabled()
    expect(button()).toHaveAttribute('aria-pressed', 'false')
    expect(button()).toHaveAttribute('title', 'VibeWrite: ghost-text continuations while you write')
    await userEvent.click(button())
    expect(useAiSettingsStore.getState().settings?.ghostText).toEqual({
      enabled: true,
      idleMs: 1500
    })
    expect(button()).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(button())
    expect(useAiSettingsStore.getState().settings?.ghostText.enabled).toBe(false)
  })

  it('is disabled below Suggest with the level in its title, and when the feature is off for the project', () => {
    useAiSettingsStore.setState({
      settings: settings({ dial: 1, ghostText: { enabled: true, idleMs: 1500 } })
    })
    const { rerender } = render(<VibeWriteToggle error={null} />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute('aria-pressed', 'false')
    expect(button()).toHaveAttribute(
      'title',
      'VibeWrite needs the AI dial at Suggest or higher (Settings, AI tab)'
    )
    useAiSettingsStore.setState({
      settings: settings({ features: { ...defaultAiSettings().features, ghostText: false } })
    })
    rerender(<VibeWriteToggle error={null} />)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'Ghost text is turned off for this project (Settings, AI tab)'
    )
  })

  it('carries the last subtle failure in its title while on', () => {
    useAiSettingsStore.setState({
      settings: settings({ ghostText: { enabled: true, idleMs: 1500 } })
    })
    render(<VibeWriteToggle error="OpenAI is rate-limiting this key. Wait a moment and retry." />)
    expect(button()).toHaveAttribute(
      'title',
      'VibeWrite paused: OpenAI is rate-limiting this key. Wait a moment and retry.'
    )
  })
})
