import { describe, expect, it } from 'vitest'
import { draftSummary, type ImportDraft } from '@shared/import'
import { paragraphNode, textRun, type ImportBlock } from './blocks'
import { buildDraft, guessPlacements } from './structure'

const heading = (level: number, text: string): ImportBlock => ({ type: 'heading', level, text })
const para = (text: string): ImportBlock => ({
  type: 'paragraph',
  node: paragraphNode([textRun(text)])
})
const blank: ImportBlock = { type: 'blank' }
const brk: ImportBlock = { type: 'break' }

function draft(blocks: ImportBlock[], name = 'The Quiet House.docx'): ImportDraft {
  return buildDraft(blocks, { name, format: 'docx', novelFormat: 'novel' })
}

/** The shape of a draft as `part > chapter > scene count`, which is what the heuristics decide. */
function shape(built: ImportDraft): string[] {
  return built.parts.map(
    (part) =>
      `${part.title}: ${part.chapters.map((chapter) => `${chapter.title}(${chapter.scenes.length})`).join(', ')}`
  )
}

describe('buildDraft heading roles', () => {
  it('makes h1 the part and h2 the chapter when both occur', () => {
    const built = draft([
      heading(1, 'Part One'),
      heading(2, 'The Bell'),
      para('One.'),
      heading(2, 'The Road'),
      para('Two.'),
      heading(1, 'Part Two'),
      heading(2, 'The Return'),
      para('Three.')
    ])
    expect(shape(built)).toEqual(['Part One: The Bell(1), The Road(1)', 'Part Two: The Return(1)'])
  })

  it('makes a single heading level the chapter and titles the one part after the file', () => {
    const built = draft([
      heading(1, 'The Bell'),
      para('One.'),
      heading(1, 'The Road'),
      para('Two.')
    ])
    expect(shape(built)).toEqual(['The Quiet House: The Bell(1), The Road(1)'])
  })

  it('treats a heading reading like a part as a part whatever its level says', () => {
    const built = draft([
      heading(2, 'Part Two'),
      heading(2, 'The Bell'),
      para('One.'),
      heading(2, 'The Road'),
      para('Two.')
    ])
    expect(shape(built)).toEqual(['Part Two: The Bell(1), The Road(1)'])
  })

  it('demotes headings deeper than the chapter level to bold prose', () => {
    const built = draft([
      heading(1, 'Part One'),
      heading(2, 'The Bell'),
      heading(3, 'A note'),
      para('One.')
    ])
    const scene = built.parts[0]?.chapters[0]?.scenes[0]
    expect(scene?.paragraphs[0]?.content).toEqual([
      { type: 'text', text: 'A note', marks: [{ type: 'bold' }] }
    ])
    expect(scene?.paragraphs).toHaveLength(2)
  })
})

describe('buildDraft title lines', () => {
  it.each(['Chapter Seven', 'CHAPTER 7', 'Ch. 7', '7.', 'IV', 'iv.', 'Prologue', 'Interlude'])(
    'promotes the paragraph %j to a chapter',
    (line) => {
      const built = draft([para(line), para('Body.'), para('Chapter Eight'), para('More.')])
      expect(built.parts[0]?.chapters.map((chapter) => chapter.title)).toEqual([
        line,
        'Chapter Eight'
      ])
    }
  )

  it.each(['Part Two', 'Book Three', 'Act I'])('promotes the paragraph %j to a part', (line) => {
    const built = draft([para(line), para('Body.')])
    expect(built.parts.map((part) => part.title)).toEqual([line])
    expect(built.parts[0]?.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1'])
  })

  it('leaves a long line alone however it starts', () => {
    const long = `Chapter Seven ${'was the longest of them all. '.repeat(4)}`
    const built = draft([para(long)])
    expect(built.parts[0]?.chapters).toHaveLength(1)
    expect(built.parts[0]?.chapters[0]?.scenes[0]?.paragraphs).toHaveLength(1)
  })
})

describe('buildDraft scenes', () => {
  it('splits a chapter at a glyph break', () => {
    const built = draft([
      heading(1, 'The Bell'),
      para('One.'),
      brk,
      para('Two.'),
      brk,
      para('Three.')
    ])
    const chapter = built.parts[0]?.chapters[0]
    expect(chapter?.scenes.map((scene) => scene.title)).toEqual(['Scene 1', 'Scene 2', 'Scene 3'])
    expect(chapter?.scenes[1]?.paragraphs).toHaveLength(1)
  })

  it('splits at a run of blank lines but not at a single one', () => {
    const built = draft([
      heading(1, 'The Bell'),
      para('One.'),
      blank,
      para('Two.'),
      blank,
      blank,
      para('Three.')
    ])
    const chapter = built.parts[0]?.chapters[0]
    expect(chapter?.scenes).toHaveLength(2)
    expect(chapter?.scenes[0]?.paragraphs).toHaveLength(2)
  })

  it('drops chapters and parts a heading left empty', () => {
    const built = draft([
      heading(1, 'Part One'),
      heading(2, 'Contents entry'),
      heading(1, 'Part Two'),
      heading(2, 'The Bell'),
      para('One.')
    ])
    expect(shape(built)).toEqual(['Part Two: The Bell(1)'])
  })

  it('holds everything in one chapter when the file has no headings at all', () => {
    const built = draft([para('One.'), brk, para('Two.')])
    expect(shape(built)).toEqual(['The Quiet House: Chapter 1(2)'])
  })
})

describe('buildDraft matter guesses', () => {
  it('sends a leading title page and a trailing acknowledgements out of the manuscript', () => {
    const built = draft([
      heading(1, 'Title Page'),
      para('The Quiet House'),
      heading(1, 'Dedication'),
      para('For no one.'),
      heading(1, 'Chapter One'),
      para('The bell rang.'),
      heading(1, 'Acknowledgements'),
      para('Thank you.')
    ])
    expect(built.parts[0]?.chapters.map((chapter) => [chapter.title, chapter.placement])).toEqual([
      ['Title Page', 'front'],
      ['Dedication', 'front'],
      ['Chapter One', 'manuscript'],
      ['Acknowledgements', 'end']
    ])
  })

  it('leaves a matter-looking title in the middle of the manuscript alone', () => {
    const built = draft([
      heading(1, 'Chapter One'),
      para('One.'),
      heading(1, 'The Dedication'),
      para('Two.'),
      heading(1, 'Chapter Three'),
      para('Three.')
    ])
    expect(built.parts[0]?.chapters.map((chapter) => chapter.placement)).toEqual([
      'manuscript',
      'manuscript',
      'manuscript'
    ])
  })

  it('keeps a prologue in the manuscript', () => {
    const built = draft([
      heading(1, 'Prologue'),
      para('One.'),
      heading(1, 'Chapter One'),
      para('Two.')
    ])
    expect(built.parts[0]?.chapters[0]?.placement).toBe('manuscript')
  })

  it('calls short leading content Front matter', () => {
    const built = draft([
      para('The Quiet House'),
      para('A novel'),
      heading(1, 'Chapter One'),
      para('One.')
    ])
    expect(built.parts[0]?.chapters.map((chapter) => [chapter.title, chapter.placement])).toEqual([
      ['Front matter', 'front'],
      ['Chapter One', 'manuscript']
    ])
  })

  it('keeps long leading content as the first chapter of the manuscript', () => {
    const long = Array.from({ length: 40 }, (_, index) =>
      para(`Line ${index} ${'word '.repeat(10)}`)
    )
    const built = draft([...long, heading(1, 'Chapter Two'), para('Two.')])
    expect(built.parts[0]?.chapters.map((chapter) => [chapter.title, chapter.placement])).toEqual([
      ['Chapter 1', 'manuscript'],
      ['Chapter Two', 'manuscript']
    ])
  })
})

describe('buildDraft ids and counts', () => {
  it('numbers ids by position and starts nextId at one', () => {
    const built = draft([
      heading(1, 'Part One'),
      heading(2, 'The Bell'),
      para('One.'),
      brk,
      para('Two.')
    ])
    expect(built.parts[0]?.id).toBe('p1')
    expect(built.parts[0]?.chapters[0]?.id).toBe('p1c1')
    expect(built.parts[0]?.chapters[0]?.scenes.map((scene) => scene.id)).toEqual([
      'p1c1s1',
      'p1c1s2'
    ])
    expect(built.nextId).toBe(1)
  })

  it('reports the source and agrees with the summary when nothing is excluded', () => {
    const built = draft([heading(1, 'The Bell'), para('One two three.'), brk, para('Four five.')])
    expect(built.source).toEqual({
      name: 'The Quiet House.docx',
      format: 'docx',
      words: 5,
      paragraphs: 2
    })
    expect(draftSummary(built).words).toBe(5)
  })

  it('uses the labels of the project format', () => {
    const built = buildDraft([heading(1, 'The Bell'), para('One.')], {
      name: 'Arc.txt',
      format: 'txt',
      novelFormat: 'webnovel'
    })
    expect(built.parts[0]?.title).toBe('Arc')
    expect(built.parts[0]?.chapters[0]?.scenes[0]?.title).toBe('Scene 1')
  })
})

describe('guessPlacements', () => {
  it('keeps everything in the manuscript when every title matches a matter set', () => {
    expect(guessPlacements(['Copyright', 'Appendix'])).toEqual(['manuscript', 'manuscript'])
  })

  it('takes only the leading and trailing matches', () => {
    expect(
      guessPlacements(['Copyright', 'Chapter One', 'Glossary', 'Chapter Two', 'Appendix'])
    ).toEqual(['front', 'manuscript', 'manuscript', 'manuscript', 'end'])
  })
})
