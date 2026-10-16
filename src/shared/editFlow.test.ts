import { describe, expect, it } from 'vitest'
import {
  autoNotesSpec,
  NotesAutoSettings,
  notesUpdateAsk,
  notesUpdateDepth,
  scopeKey
} from './editFlow'

describe('notes updates (notes redesign phase 3)', () => {
  it('reads a chat request to update the notes, with or without a scope', () => {
    expect(notesUpdateAsk('Update my notes from this chapter')).toBe('chapter')
    expect(notesUpdateAsk('update the notes from the book.')).toBe('book')
    expect(notesUpdateAsk('Can you update my notes from the whole manuscript?')).toBe('book')
    expect(notesUpdateAsk('please refresh my notes with this scene')).toBe('scene')
    expect(notesUpdateAsk('Update my notes')).toBe('here')
    expect(notesUpdateAsk('Update notes, please!')).toBe('here')
  })

  it('leaves every other message to the chat', () => {
    expect(notesUpdateAsk('Update my notes on Mara with her grey eyes')).toBeNull()
    expect(notesUpdateAsk('What do my notes say about the storm?')).toBeNull()
    expect(notesUpdateAsk('Update this chapter')).toBeNull()
    expect(notesUpdateAsk('')).toBeNull()
  })

  it('pre-fills Quick, Deep for the whole book; the automatic run is Quick on the chapter', () => {
    expect(notesUpdateDepth('scene')).toBe('quick')
    expect(notesUpdateDepth('chapter')).toBe('quick')
    expect(notesUpdateDepth('book')).toBe('deep')
    expect(autoNotesSpec('ch-1')).toEqual({
      categories: ['updateNotes'],
      depth: 'quick',
      scope: { kind: 'chapter', nodeId: 'ch-1' }
    })
  })

  it('keeps an automatic run under its own key', () => {
    const scope = { kind: 'chapter' as const, nodeId: 'ch-1' }
    expect(scopeKey(scope)).toBe('chapter:ch-1')
    expect(scopeKey(scope, true)).toBe('auto:chapter:ch-1')
  })

  it('caps the daily runs between 1 and 50', () => {
    expect(NotesAutoSettings.safeParse({ on: true, dailyCap: 0 }).success).toBe(false)
    expect(NotesAutoSettings.safeParse({ on: true, dailyCap: 51 }).success).toBe(false)
    expect(NotesAutoSettings.safeParse({ on: false, dailyCap: 50 }).success).toBe(true)
  })
})
