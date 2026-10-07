import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSource } from '@shared/aiSettings'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import { RequestCost } from './RequestCost'

const REQUEST = {
  model: 'deepseek/deepseek-v4-flash',
  costUsd: 0.0012,
  usage: { inputTokens: 1_200, outputTokens: 300 },
  cached: false
}

const on = (source: AiSource): void => {
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), source } })
}

beforeEach(() => resetAiSettingsStore())
afterEach(() => resetAiSettingsStore())

describe('RequestCost (F-5.9, AI-BILLING-SPEC C4)', () => {
  it('shows the tokens under an answer from the author’s own key or a local model', () => {
    on('ownKey')
    render(
      <span data-testid="cost">
        <RequestCost request={REQUEST} />
      </span>
    )
    expect(screen.getByTestId('cost')).toHaveTextContent(
      'deepseek/deepseek-v4-flash · $0.0012 · 1,200 in · 300 out'
    )
  })

  it('shows dollars without tokens on MythScribe Cloud', () => {
    on('cloud')
    render(
      <span data-testid="cost">
        <RequestCost request={{ ...REQUEST, cached: true }} />
      </span>
    )
    expect(screen.getByTestId('cost')).toHaveTextContent(
      'deepseek/deepseek-v4-flash · $0.0012 · cached'
    )
    expect(screen.getByTestId('cost').textContent).not.toMatch(/ in · | out/)
  })
})
