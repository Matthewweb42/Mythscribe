-- F-9.12: the local full-text index of manuscript paragraphs (one row per paragraph with text).
-- Written by hand: drizzle does not model virtual tables, so later generated diffs never touch it.
CREATE VIRTUAL TABLE `passage_fts` USING fts5(node_id UNINDEXED, para UNINDEXED, text, tokenize='porter unicode61 remove_diacritics 2');
