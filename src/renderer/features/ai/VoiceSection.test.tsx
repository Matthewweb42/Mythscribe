import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultAuthorRules } from '@shared/authorRules'
import type {
  Channel,
  Input,
  Output,
  TreeNode,
  VoiceConsistencyReport,
  VoiceExemplar,
  VoiceProfile
} from '@shared/ipc/contract'
import { computeStylometrics } from '@shared/stylometry'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { VoiceSection } from './VoiceSection'
import { resetVoiceStore, useVoiceStore } from './voiceStore'

const LONG =
  'Mara turned from the window and looked at the ridge, where the storm had settled for the night and the river kept rising.'

const exemplars: VoiceExemplar[] = [
  {
    id: 'e1',
    nodeId: 'scene-1',
    text: LONG,
    pov: 'Mara',
    kind: 'interiority',
    created: '2026-09-14T08:00:00.000Z'
  },
  {
    id: 'e2',
    nodeId: null,
    text: 'Short enough to show whole.',
    pov: null,
    kind: 'dialogue',
    created: '2026-09-14T08:01:00.000Z'
  }
]

const profile = (over: Partial<VoiceProfile> = {}): VoiceProfile => ({
  rules: ['Narration is in past tense.', 'Short sentences, median 9 words.'],
  stats: computeStylometrics(''),
  exemplars,
  confidence: 0.256,
  wordCount: 2_560,
  authorRules: defaultAuthorRules(),
  ...over
})

const REPORT: VoiceConsistencyReport = {
  profileWordCount: 2_560,
  documents: [
    { id: 'scene-1', title: 'Scene 1', wordCount: 900, status: 'ok', violations: [] },
    { id: 'scene-2', title: 'Scene 2', wordCount: 40, status: 'short', violations: [] },
    {
      id: 'scene-3',
      title: 'Scene 3',
      wordCount: 1_620,
      status: 'drift',
      violations: [
        'Narrated in present tense; the manuscript is in past tense.',
        "Sentences run a median of 30 words; the manuscript's is 9."
      ]
    }
  ]
}

const node = (id: string, title: string, over: Partial<TreeNode> = {}): TreeNode => ({
  id,
  parentId: 'ms',
  sectionType: null,
  kind: 'document',
  hierarchyLevel: 'scene',
  title,
  position: 0,
  wordCount: 0,
  matterType: null,
  preset: null,
  created: '2026-09-14T08:00:00.000Z',
  modified: '2026-09-14T08:00:00.000Z',
  ...over
})

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  profile: VoiceProfile
  report: () => VoiceConsistencyReport
  removeAnswer: () => null
}

function fakeClient(initial: VoiceProfile): Fake {
  const calls: Fake['calls'] = []
  const fake: Fake = {
    calls,
    profile: initial,
    report: () => REPORT,
    removeAnswer: () => null,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push({ channel, input })
        switch (channel) {
          case 'voice:profile':
            return fake.profile as Output<C>
          case 'voice:consistencyReport':
            return fake.report() as Output<C>
          case 'voice:removeExemplar': {
            const answer = fake.removeAnswer()
            const { id } = input as Input<'voice:removeExemplar'>
            fake.profile = {
              ...fake.profile,
              exemplars: fake.profile.exemplars.filter((e) => e.id !== id)
            }
            return answer as Output<C>
          }
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on: () => () => {}
    }
  }
  return fake
}

let fake: Fake
const section = (): HTMLElement => screen.getByTestId('voice-section')
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function open(initial: VoiceProfile = profile()): Promise<void> {
  fake = fakeClient(initial)
  setIpcClient(fake.client)
  useVoiceStore.setState({ exemplars: initial.exemplars })
  render(<VoiceSection />)
  await waitFor(() => expect(useVoiceStore.getState().profile).not.toBeNull())
}

beforeEach(() => {
  resetVoiceStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.getState().clear()
})

describe('VoiceSection (F-14.1)', () => {
  it('renders nothing until the profile loads, then the confidence, the words, the rules, and the exemplars', async () => {
    fake = fakeClient(profile())
    setIpcClient(fake.client)
    useVoiceStore.setState({ exemplars })
    render(<VoiceSection />)
    expect(screen.queryByTestId('voice-section')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('voice-section')).toBeInTheDocument())
    expect(fake.calls).toEqual([{ channel: 'voice:profile', input: {} }])
    expect(screen.getByTestId('voice-confidence')).toHaveTextContent('26%')
    expect(screen.getByRole('progressbar', { name: 'Confidence' })).toHaveAttribute(
      'value',
      '0.256'
    )
    expect(screen.getByTestId('voice-words')).toHaveTextContent(
      'Built from 2,560 words of manuscript and 2 of 12 exemplars.'
    )
    const rules = within(screen.getByRole('list', { name: 'Voice rules' })).getAllByRole('listitem')
    expect(rules.map((r) => r.textContent)).toEqual([
      'Narration is in past tense.',
      'Short sentences, median 9 words.'
    ])
    const rows = within(screen.getByRole('list', { name: 'Voice exemplars' })).getAllByRole(
      'listitem'
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Interiority · POV Mara')
    expect(rows[0]).toHaveTextContent(`${LONG.slice(0, 80).trimEnd()}…`)
    expect(rows[0]).not.toHaveTextContent('kept rising')
    expect(rows[1]).toHaveTextContent('Dialogue · POV —')
    expect(rows[1]).toHaveTextContent('Short enough to show whole.')
    expect(section()).toHaveTextContent('Select 80–2,000 characters in the editor')
  })

  it('explains an empty profile', async () => {
    await open(profile({ rules: [], exemplars: [], confidence: 0, wordCount: 0 }))
    expect(screen.getByTestId('voice-confidence')).toHaveTextContent('0%')
    expect(section()).toHaveTextContent('No rules yet')
    expect(section()).toHaveTextContent('No exemplars marked yet.')
    expect(screen.queryByRole('list', { name: 'Voice rules' })).not.toBeInTheDocument()
  })

  it('Remove drops the row through the store and reloads the profile', async () => {
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Remove exemplar 1' }))
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Voice exemplars' })).getAllByRole('listitem')
      ).toHaveLength(1)
    )
    expect(fake.calls.map((c) => c.channel)).toEqual([
      'voice:profile',
      'voice:removeExemplar',
      'voice:profile'
    ])
    expect(fake.calls[1]?.input).toEqual({ id: 'e1' })
    expect(useVoiceStore.getState().exemplars?.map((e) => e.id)).toEqual(['e2'])
    await waitFor(() => expect(screen.getByTestId('voice-words')).toHaveTextContent('1 of 12'))
  })

  it('checks voice consistency on demand: drifting scenes first with their lines, short ones summarised, a title selects the scene (F-14.7)', async () => {
    await open()
    useTreeStore.setState({
      ...buildIndex([
        node('ms', 'manuscript', {
          parentId: null,
          sectionType: 'manuscript',
          kind: 'folder',
          hierarchyLevel: null
        }),
        node('scene-1', 'Scene 1'),
        node('scene-3', 'Scene 3', { position: 1 })
      ]),
      loaded: true
    })
    expect(screen.queryByTestId('voice-consistency')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Check voice consistency' }))
    await waitFor(() => expect(screen.getByTestId('voice-consistency')).toBeInTheDocument())
    expect(fake.calls.at(-1)).toEqual({ channel: 'voice:consistencyReport', input: {} })
    const list = screen.getByRole('list', { name: 'Voice consistency' })
    const rows = [...list.querySelectorAll(':scope > li')]
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['drift', 'ok'])
    expect(rows[0]).toHaveTextContent('Scene 3')
    expect(rows[0]).toHaveTextContent('Drifts · 1,620 words')
    expect(
      within(screen.getByRole('list', { name: 'Drift in Scene 3' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(REPORT.documents[2]?.violations)
    expect(rows[1]).toHaveTextContent('Scene 1')
    expect(rows[1]).toHaveTextContent('Matches · 900 words')
    expect(screen.getByTestId('voice-consistency-skipped')).toHaveTextContent(
      '1 scene under 200 words was skipped.'
    )
    await userEvent.click(within(list).getByRole('button', { name: 'Scene 3' }))
    expect(useTreeStore.getState().selectedId).toBe('scene-3')
  })

  it('explains a report with nothing to score, and toasts a failed check', async () => {
    await open()
    fake.report = () => ({
      profileWordCount: 0,
      documents: [
        { id: 'a', title: 'A', wordCount: 0, status: 'short', violations: [] },
        { id: 'b', title: 'B', wordCount: 12, status: 'short', violations: [] }
      ]
    })
    await userEvent.click(screen.getByRole('button', { name: 'Check voice consistency' }))
    await waitFor(() => expect(screen.getByTestId('voice-consistency')).toBeInTheDocument())
    expect(screen.queryByRole('list', { name: 'Voice consistency' })).not.toBeInTheDocument()
    expect(screen.getByTestId('voice-consistency')).toHaveTextContent(
      'Nothing to score yet: every scene is under 200 words.'
    )
    expect(screen.getByTestId('voice-consistency-skipped')).toHaveTextContent(
      '2 scenes under 200 words were skipped.'
    )
    fake.report = () => {
      throw new IpcRequestError({ code: 'NO_PROJECT', message: 'No project is open' })
    }
    await userEvent.click(screen.getByRole('button', { name: 'Check voice consistency' }))
    await waitFor(() => expect(toasts()).toEqual(['No project is open']))
    expect(screen.getByRole('button', { name: 'Check voice consistency' })).toBeEnabled()
  })

  it('toasts a refused removal and keeps the row', async () => {
    await open()
    fake.removeAnswer = () => {
      throw new IpcRequestError({ code: 'NOT_FOUND', message: 'Voice exemplar not found' })
    }
    await userEvent.click(screen.getByRole('button', { name: 'Remove exemplar 2' }))
    await waitFor(() => expect(toasts()).toEqual(['Voice exemplar not found']))
    expect(
      within(screen.getByRole('list', { name: 'Voice exemplars' })).getAllByRole('listitem')
    ).toHaveLength(2)
  })
})
