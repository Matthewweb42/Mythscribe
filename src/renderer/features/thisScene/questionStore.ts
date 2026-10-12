import { create } from 'zustand'
import type { NameAnswer, NameAnswerResult, NameQuestion } from '@shared/memory/nameQuestions'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDismissedStore } from './dismissedStore'

/**
 * The name questions of Needs a look (F-16.4; story memory v2): the one owner of the new names
 * and nicknames main asks about once, most named first. Loaded on a v2 open and replaced whole
 * by `questions:changed`, which main pushes after a scan, a record change or an answer. An answer
 * takes its question off the list at once (main's push confirms it); a tombstone the answer wrote
 * joins the Dismissed list, and a record it made or named arrives through `record:changed`.
 */
interface QuestionState {
  questions: NameQuestion[]
  loaded: boolean
  load: () => Promise<void>
  /** Answers a question; null when main refused (the question stays, the error is toasted). */
  answer: (answer: NameAnswer) => Promise<NameAnswerResult | null>
  /** Opens the `questions:changed` subscription (idempotent); call it where a v2 project opens. */
  subscribe: () => void
  clear: () => void
}

let generation = 0
let unsubscribe: (() => void) | null = null

/** Whether `question` is the one `answer` settles. */
const settles = (question: NameQuestion, answer: NameAnswer): boolean =>
  question.name === answer.name &&
  (answer.kind === 'addAs' || answer.kind === 'notAName'
    ? question.kind === 'newName'
    : question.kind === 'nickname' && question.recordId === answer.recordId)

export const useQuestionStore = create<QuestionState>((set, get) => ({
  questions: [],
  loaded: false,

  async load() {
    const mine = generation
    const questions = await ipc().invoke('names:questions', undefined)
    if (mine === generation) set({ questions, loaded: true })
  },

  async answer(answer) {
    const mine = generation
    let result: NameAnswerResult
    try {
      result = await ipc().invoke('names:answer', { answer })
    } catch (err) {
      toast.error(describeError(err))
      return null
    }
    if (mine !== generation) return result
    set({ questions: get().questions.filter((question) => !settles(question, answer)) })
    if (result.kind === 'dismissed') useDismissedStore.getState().add(result.dismissed)
    return result
  },

  subscribe() {
    unsubscribe ??= ipc().on('questions:changed', (questions) => {
      set({ questions, loaded: true })
    })
  },

  clear() {
    generation++
    set({ questions: [], loaded: false })
  }
}))

/** Closes the subscription and empties the store. For tests and project close. */
export function resetQuestionStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useQuestionStore.getState().clear()
}
