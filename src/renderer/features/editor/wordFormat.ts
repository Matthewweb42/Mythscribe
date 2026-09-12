/** `1 word`, `1,234 words` (F-3.3). */
export function formatWords(words: number): string {
  return `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`
}

/** `+123`, `−45`, `+0`: words added since the project was opened (F-3.3). */
export function formatDelta(delta: number): string {
  return `${delta < 0 ? '−' : '+'}${Math.abs(delta).toLocaleString()}`
}
