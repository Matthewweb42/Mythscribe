/**
 * "Added 27 tags" / "Added 24 tags, skipped 3 already in the bank" / "All 27 tags are already in
 * the bank"; the tag bank import (F-4.9) says "Imported".
 */
export function loadSummary(
  created: number,
  skipped: number,
  verb: 'Added' | 'Imported' = 'Added'
): string {
  if (created === 0) return `All ${skipped} tags are already in the bank`
  const added = created === 1 ? `${verb} 1 tag` : `${verb} ${created} tags`
  return skipped === 0 ? added : `${added}, skipped ${skipped} already in the bank`
}
