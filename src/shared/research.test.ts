import { describe, expect, it } from 'vitest'
import { alreadyInResearch, researchSourceLine, writtenResearchDoc } from './research'

describe('Research vocabulary (F-16.8)', () => {
  it('reads a document with no meta as written and canon, with no source line', () => {
    const doc = writtenResearchDoc('n-1')
    expect(doc).toEqual({
      nodeId: 'n-1',
      origin: 'written',
      contextFileId: null,
      fileName: null,
      fileType: null,
      converted: false,
      notCanon: false
    })
    expect(researchSourceLine(doc)).toBeNull()
  })

  it('says where an upload came from: converted PDF, image, or another file', () => {
    const upload = { ...writtenResearchDoc('n-2'), origin: 'upload' as const, contextFileId: 'f' }
    expect(
      researchSourceLine({ ...upload, fileName: 'a.pdf', fileType: 'pdf', converted: true })
    ).toBe('Converted from PDF: a.pdf')
    expect(researchSourceLine({ ...upload, fileName: 'map.png', fileType: 'image' })).toBe(
      'Image: map.png'
    )
    expect(researchSourceLine({ ...upload, fileName: 'notes.md', fileType: 'md' })).toBe(
      'Uploaded from notes.md'
    )
    expect(researchSourceLine({ ...upload, fileType: 'docx' })).toBe('Uploaded from the original')
    expect(alreadyInResearch('Tides')).toBe('Already in Research as "Tides".')
  })
})
