import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompiledEntry, CompiledManuscript } from '@shared/compile'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { emptySceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { resetSceneMetaStore, useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { resetEditorSettingsStore } from '@renderer/features/editor/settingsStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { CompileDialog } from './CompileDialog'
import { compiledBlocks } from '@shared/compiledBlocks'

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function entry(
  partial: Partial<CompiledEntry> & Pick<CompiledEntry, 'id' | 'title'>
): CompiledEntry {
  return {
    kind: 'document',
    level: null,
    depth: 0,
    meta: null,
    tags: [],
    content: null,
    ...partial
  }
}

const book: CompiledManuscript = {
  entries: [
    entry({ id: 'p1', kind: 'folder', level: 'part', title: 'Part One' }),
    entry({ id: 'c1', kind: 'folder', level: 'chapter', depth: 1, title: 'The Storm' }),
    entry({
      id: 's1',
      level: 'scene',
      depth: 2,
      title: 'Scene 1',
      meta: { location: 'Harbor', pov: 'Mara', timeline: 'Dawn' },
      tags: [{ id: 't-mara', name: 'mara', color: '#dc2626' }],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Rain on ' },
              { type: 'inlineTag', attrs: { id: 't-forest', name: 'dark-forest' } },
              {
                type: 'text',
                text: ' tonight.',
                marks: [{ type: 'aiOrigin', attrs: { proposalId: 'p-1', accepted: 1 } }]
              }
            ]
          }
        ]
      }
    }),
    entry({ id: 's2', level: 'scene', depth: 2, title: 'Scene 2', content: para('Then silence.') }),
    entry({ id: 'c2', kind: 'folder', level: 'chapter', depth: 1, title: 'The Calm' }),
    entry({ id: 's3', level: 'scene', depth: 2, title: 'Scene 1', content: para('Morning came.') })
  ]
}

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

function install(answer: CompiledManuscript | Error): void {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'manuscript:compile') {
      if (answer instanceof Error) throw answer
      return answer
    }
    if (channel === 'sceneMeta:get') return { id: 's1', meta: emptySceneMeta() }
    if (channel === 'sceneMeta:set') return { modified: '2026-10-04T10:00:00.000Z' }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: () => () => {}
  }
  setIpcClient(client)
}

beforeEach(() => {
  resetDocumentStore()
  resetSceneMetaStore()
  resetEditorSettingsStore()
  resetTagStore()
  install(book)
})
afterEach(() => {
  resetDocumentStore()
  resetSceneMetaStore()
  resetTagStore()
})

describe('compiledBlocks (F-3.12)', () => {
  it('puts a scene break only between scenes with no heading in between', () => {
    const kinds = compiledBlocks(book.entries, true).map((block) => block.kind)
    expect(kinds).toEqual([
      'heading',
      'heading',
      'meta',
      'text',
      'break',
      'text',
      'heading',
      'text'
    ])
  })

  it('drops the scene headers when details are off', () => {
    expect(compiledBlocks(book.entries, false).some((block) => block.kind === 'meta')).toBe(false)
  })

  it('prints nothing for a generic folder and no break before a scene folder’s first document', () => {
    const kinds = compiledBlocks(
      [
        entry({ id: 'g', kind: 'folder', title: 'Loose' }),
        entry({ id: 'a', level: 'scene', title: 'A', content: para('A.') }),
        entry({
          id: 'sf',
          kind: 'folder',
          level: 'scene',
          title: 'Folder scene',
          meta: { location: 'Mill', pov: '', timeline: '' }
        }),
        entry({ id: 'd1', title: 'Part a', content: para('One.') }),
        entry({ id: 'd2', title: 'Part b', content: para('Two.') })
      ],
      true
    ).map((block) => block.kind)
    expect(kinds).toEqual(['text', 'break', 'meta', 'text', 'break', 'text'])
  })
})

describe('CompileDialog (F-3.12)', () => {
  it('renders headings, the scene header, the text, and the scene break', async () => {
    useTagStore.getState().merge(tagFixture[0]!)
    render(<CompileDialog format="novel" onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Compiled preview' })
    expect(within(dialog).getByText('Loading…')).toBeInTheDocument()
    const preview = await within(dialog).findByTestId('compile-preview')
    expect(invoke).toHaveBeenCalledWith('manuscript:compile', undefined)

    const headings = within(preview).getAllByTestId('compile-heading')
    expect(headings.map((h) => [h.tagName, h.dataset.level, h.textContent])).toEqual([
      ['H1', 'part', 'Part One'],
      ['H2', 'chapter', 'The Storm'],
      ['H2', 'chapter', 'The Calm']
    ])

    const meta = within(preview).getByTestId('compile-scene-meta')
    expect(meta).toHaveTextContent('Location: Harbor')
    expect(meta).toHaveTextContent('Time: Dawn')
    expect(meta).toHaveTextContent('POV: Mara')
    expect(within(within(meta).getByRole('list', { name: 'Tags' })).getByText('mara')).toBeVisible()

    const breaks = within(preview).getAllByTestId('compile-scene-break')
    expect(breaks).toHaveLength(1)
    expect(breaks[0]).toHaveTextContent('* * *')

    expect(preview).toHaveTextContent('Then silence.')
    expect(preview).toHaveTextContent('Morning came.')
    // The inline tag paints from the bank, and the AI-origin mark parses.
    const token = preview.querySelector('[data-inline-tag]')
    expect(token).toHaveTextContent('#dark-forest')
    expect(token?.getAttribute('style')).toContain('#ea580c')
    expect(preview.querySelector('[data-ai-origin]')).toHaveTextContent('tonight.')
    // Read-only: nothing in the preview is editable.
    expect(preview.querySelector('[contenteditable]')).toBeNull()
  })

  it('hides the scene headers when Scene details is unticked', async () => {
    render(<CompileDialog format="novel" onClose={() => {}} />)
    const preview = await screen.findByTestId('compile-preview')
    expect(within(preview).getByTestId('compile-scene-meta')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Scene details' }))
    expect(within(preview).queryByTestId('compile-scene-meta')).toBeNull()
    expect(preview).toHaveTextContent('Then silence.')
  })

  it('says so when there is nothing to compile', async () => {
    install({ entries: [] })
    render(<CompileDialog format="novel" onClose={() => {}} />)
    expect(await screen.findByText('Nothing to compile yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('compile-preview')).toBeNull()
  })

  it('shows the error main answered, with Close still there', async () => {
    install(new Error('No project is open'))
    const onClose = vi.fn()
    render(<CompileDialog format="novel" onClose={onClose} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('No project is open')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('flushes pending scene metadata before asking main', async () => {
    await useSceneMetaStore.getState().load('s1')
    useSceneMetaStore.getState().edit('s1', { ...emptySceneMeta(), location: 'Mill' })
    render(<CompileDialog format="novel" onClose={() => {}} />)
    await screen.findByTestId('compile-preview')
    const channels = invoke.mock.calls.map(([channel]) => channel)
    expect(channels.indexOf('sceneMeta:set')).toBeGreaterThanOrEqual(0)
    expect(channels.indexOf('sceneMeta:set')).toBeLessThan(channels.indexOf('manuscript:compile'))
  })
})
