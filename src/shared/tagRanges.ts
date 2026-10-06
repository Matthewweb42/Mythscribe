/**
 * Granular tags (F-4.8): a tag on a stretch of text is the `tagRange` mark in the stored document,
 * with the tag's id as its one attribute (`{ tagId }`). ProseMirror maps the mark through every
 * edit, so a range never drifts the way stored character offsets would. Different tags overlap
 * (the mark excludes nothing); the same tag over touching or overlapping text is one range. The
 * mark is index data for the author's eyes: export never prints it and `docToText` ignores it, so
 * prompts, hashes, word counts, drafts, and snapshots are unchanged by it.
 */
export const TAG_RANGE_MARK = 'tagRange'
