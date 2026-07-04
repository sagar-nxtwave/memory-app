-- Short human-readable title per image chunk (e.g. "FIG. 1 — System Architecture"),
-- separate from the long searchable description stored in `content`.
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS image_title text;
