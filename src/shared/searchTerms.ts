/**
 * Search terms (F-5.7): what a question or a short plan text means to a lexical match, shared by
 * Story Intelligence's ranking (`queryContext.ts`) and the plan-link matcher (F-16.21,
 * `memory/planMatch.ts`), so both drop the same noise.
 */

/** A token shorter than this is noise ("who", "did" are also stopwords below). */
export const TERM_MIN = 3

/**
 * Words that match everything and mean nothing here: ordinary English function words plus the
 * five nouns every question about a manuscript contains. Kept small: a stopword that is also a
 * character's name would silently un-rank the scenes about them.
 */
export const STOPWORDS = new Set([
  'the',
  'and',
  'but',
  'for',
  'not',
  'are',
  'was',
  'were',
  'been',
  'being',
  'have',
  'has',
  'had',
  'does',
  'did',
  'doing',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'why',
  'how',
  'that',
  'this',
  'these',
  'those',
  'there',
  'then',
  'than',
  'with',
  'without',
  'from',
  'into',
  'onto',
  'over',
  'about',
  'after',
  'before',
  'her',
  'hers',
  'his',
  'she',
  'him',
  'they',
  'them',
  'their',
  'theirs',
  'you',
  'your',
  'yours',
  'its',
  'any',
  'all',
  'can',
  'could',
  'would',
  'should',
  'will',
  'just',
  'ever',
  'anything',
  'something',
  'scene',
  'scenes',
  'chapter',
  'chapters',
  'manuscript',
  'story',
  'book'
])

/**
 * The question's search terms: lower-cased, split on everything that is not a letter or a
 * digit, tokens under `TERM_MIN` and the stopwords dropped, deduplicated in the order the
 * author wrote them.
 */
export function queryTerms(question: string): string[] {
  const terms: string[] = []
  for (const token of question.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < TERM_MIN || STOPWORDS.has(token) || terms.includes(token)) continue
    terms.push(token)
  }
  return terms
}
