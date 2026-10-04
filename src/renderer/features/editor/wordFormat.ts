/** `1 word`, `1,234 words` (F-3.3). */
export function formatWords(words: number): string {
  return `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`
}

/** `+123`, `−45`, `+0`: words added since the project was opened (F-3.3). */
export function formatDelta(delta: number): string {
  return `${delta < 0 ? '−' : '+'}${Math.abs(delta).toLocaleString()}`
}

/** `950`, `1.2k`, `12k`, `1.5M`: a word count short enough for a tree row (F-10.3). */
export function formatCompactWords(words: number): string {
  const abs = Math.abs(words)
  const sign = words < 0 ? '−' : ''
  const short = (value: number, unit: string): string =>
    `${sign}${value < 10 ? Number(value.toFixed(1)).toString() : Math.round(value).toString()}${unit}`
  if (abs >= 1_000_000) return short(abs / 1_000_000, 'M')
  if (abs >= 1_000) return short(abs / 1_000, 'k')
  return `${sign}${abs}`
}
