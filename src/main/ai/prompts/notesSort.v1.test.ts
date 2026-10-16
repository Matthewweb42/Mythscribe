import { describe, expect, it } from 'vitest'
import { NOTES_SORT_MAX_TOKENS, NOTES_SORT_PAGES_MAX } from '@shared/notesSort'
import {
  buildNotesSortPrompt,
  NOTES_SORT_PROMPT_VERSION,
  NOTES_SORT_RULES,
  NOTES_SORT_SENTINEL
} from './notesSort.v1'

describe('notesSort.v1 prompt (notes structure B, Sort with Ms Scribe)', () => {
  it('puts the rules and the Notes listing first, then one part of the document', () => {
    const built = buildNotesSortPrompt({
      listing: 'Folders: Characters; Places\nPages: Characters › Mara',
      title: 'Fenlands',
      part: { index: 1, count: 2 },
      text: '## Rook\n\nA smuggler.'
    })
    expect(built.version).toBe(NOTES_SORT_PROMPT_VERSION)
    expect(built.maxTokens).toBe(NOTES_SORT_MAX_TOKENS)
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content.startsWith(NOTES_SORT_SENTINEL)).toBe(true)
    expect(built.messages[0]?.content).toBe(
      `${NOTES_SORT_RULES}\n\n# Her notes\nFolders: Characters; Places\nPages: Characters › Mara`
    )
    expect(built.messages[1]?.content).toBe(
      '# Document: Fenlands (part 2 of 2)\n## Rook\n\nA smuggler.'
    )
    expect(NOTES_SORT_RULES).toContain(`At most ${NOTES_SORT_PAGES_MAX} pages.`)
  })

  it('says when Notes is empty and leaves the part count out for a one-part document', () => {
    const built = buildNotesSortPrompt({
      listing: '',
      title: 'Planning call',
      part: { index: 0, count: 1 },
      text: 'The Tide Council.'
    })
    expect(built.messages[0]?.content.endsWith('# Her notes\nHer notes are empty.')).toBe(true)
    expect(built.messages[1]?.content).toBe('# Document: Planning call\nThe Tide Council.')
  })
})
