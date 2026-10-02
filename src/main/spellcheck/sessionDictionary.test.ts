import { describe, expect, it, vi } from 'vitest'
import { createSessionDictionary, type SpellSession } from './sessionDictionary'

/** A session whose custom words live in a set; `list` can be held back or made to fail. */
function fakeSession(initial: string[] = []): SpellSession & {
  words: Set<string>
  calls: string[]
  failNextList: boolean
} {
  const words = new Set(initial)
  const calls: string[] = []
  const fake = {
    words,
    calls,
    failNextList: false,
    async listWordsInSpellCheckerDictionary(): Promise<string[]> {
      // A real session answers on a later tick; so does this one.
      await Promise.resolve()
      if (fake.failNextList) {
        fake.failNextList = false
        throw new Error('no spellchecker')
      }
      return [...words]
    },
    addWordToSpellCheckerDictionary(word: string): boolean {
      calls.push(`add:${word}`)
      words.add(word)
      return true
    },
    removeWordFromSpellCheckerDictionary(word: string): boolean {
      calls.push(`remove:${word}`)
      return words.delete(word)
    }
  }
  return fake
}

describe('createSessionDictionary (F-3.11)', () => {
  it('adds the words the session is missing and leaves the ones it has', async () => {
    const session = fakeSession(['Mara'])
    await createSessionDictionary(session, vi.fn()).sync(['Mara', 'Zorvath'])
    expect([...session.words].sort()).toEqual(['Mara', 'Zorvath'])
    expect(session.calls).toEqual(['add:Zorvath'])
  })

  it('removes the words of another project', async () => {
    const session = fakeSession(['Mara', 'Tash'])
    await createSessionDictionary(session, vi.fn()).sync(['Tash', 'Zorvath'])
    expect([...session.words].sort()).toEqual(['Tash', 'Zorvath'])
    expect(session.calls).toEqual(['remove:Mara', 'add:Zorvath'])
  })

  it('empties the session when the project closes', async () => {
    const session = fakeSession(['Mara', 'Tash'])
    await createSessionDictionary(session, vi.fn()).sync([])
    expect(session.words.size).toBe(0)
  })

  it('ends at the second list when two syncs follow each other at once', async () => {
    const session = fakeSession(['Old'])
    const dictionary = createSessionDictionary(session, vi.fn())
    const first = dictionary.sync(['Mara', 'Tash'])
    const second = dictionary.sync(['Zorvath'])
    await Promise.all([first, second])
    expect([...session.words]).toEqual(['Zorvath'])
  })

  it('reports a session that cannot list its words, never rejects, and keeps working', async () => {
    const session = fakeSession(['Mara'])
    const onError = vi.fn()
    const dictionary = createSessionDictionary(session, onError)
    session.failNextList = true
    await expect(dictionary.sync(['Zorvath'])).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect([...session.words]).toEqual(['Mara'])
    await dictionary.sync(['Zorvath'])
    expect([...session.words]).toEqual(['Zorvath'])
  })

  it('is not changed by the caller mutating its list afterwards', async () => {
    const session = fakeSession()
    const words = ['Mara']
    const done = createSessionDictionary(session, vi.fn()).sync(words)
    words.push('Tash')
    await done
    expect([...session.words]).toEqual(['Mara'])
  })
})
