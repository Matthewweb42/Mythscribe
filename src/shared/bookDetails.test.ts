import { describe, expect, it } from 'vitest'
import {
  BookDetails,
  bookSurname,
  bookTitle,
  defaultBookDetails,
  isbnFor,
  parseBookDetails
} from './bookDetails'

describe('BookDetails', () => {
  it('defaults every field, so a row from before a field parses unchanged', () => {
    expect(defaultBookDetails()).toMatchObject({
      title: '',
      isbns: [],
      alsoBy: [],
      cover: null,
      language: 'en',
      keywords: []
    })
    expect(parseBookDetails({ title: 'River' })).toEqual({
      ...defaultBookDetails(),
      title: 'River'
    })
  })

  it('reads a value that does not fit as the defaults', () => {
    expect(parseBookDetails({ title: 7 })).toEqual(defaultBookDetails())
    expect(parseBookDetails(null)).toEqual(defaultBookDetails())
    expect(BookDetails.safeParse({ language: 'not a tag' }).success).toBe(false)
    expect(BookDetails.safeParse({ language: 'en-GB' }).success).toBe(true)
  })

  it('derives the surname and the title', () => {
    const d = defaultBookDetails()
    expect(bookSurname({ ...d, author: ' Ann  Marie Lee ' })).toBe('Lee')
    expect(bookSurname({ ...d, author: 'Ann Lee', surname: 'Lee-Smith' })).toBe('Lee-Smith')
    expect(bookSurname(d)).toBe('')
    expect(bookTitle(d, ' My Novel ')).toBe('My Novel')
    expect(bookTitle({ ...d, title: 'River' }, 'My Novel')).toBe('River')
  })

  it('picks the ISBN of an edition, the first for none', () => {
    const d = {
      ...defaultBookDetails(),
      isbns: [
        { edition: 'Paperback', isbn: ' 978-1 ' },
        { edition: 'Ebook', isbn: '978-2' }
      ]
    }
    expect(isbnFor(d, 'ebook')).toBe('978-2')
    expect(isbnFor(d, '')).toBe('978-1')
    expect(isbnFor(d, 'Hardcover')).toBe('')
    expect(isbnFor(defaultBookDetails(), '')).toBe('')
  })
})
