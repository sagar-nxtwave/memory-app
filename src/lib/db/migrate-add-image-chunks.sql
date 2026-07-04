-- Dedicated image chunks: each figure/diagram becomes its own searchable chunk.
-- embedding = vision caption + OCR text; image_url = the served figure URL.
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block on PostgreSQL,
-- so run these two statements separately (not wrapped in BEGIN/COMMIT).

ALTER TYPE chunk_type ADD VALUE IF NOT EXISTS 'image';

ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS image_url text;
