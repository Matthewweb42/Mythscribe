-- F-16.5 (story memory v2, P1): the local passage index of the manuscript, scene notes, Pinned,
-- Ideas and Research, one row per paragraph with text, labelled by its source and its canon
-- status. Written by hand: drizzle does not model virtual tables, so later generated diffs never
-- touch it. A v1 project never writes to it; `passage_fts` (0022) stays v1's.
CREATE VIRTUAL TABLE `memory_passage_fts` USING fts5(source UNINDEXED, owner_id UNINDEXED, para UNINDEXED, canon UNINDEXED, text, tokenize='porter unicode61 remove_diacritics 2');
