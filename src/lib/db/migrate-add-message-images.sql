-- Persist citations + documentImages alongside each assistant message so they
-- survive a page refresh instead of only existing on the live SSE response.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS citations jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS document_images jsonb;
ALTER TABLE global_messages ADD COLUMN IF NOT EXISTS citations jsonb;
ALTER TABLE global_messages ADD COLUMN IF NOT EXISTS document_images jsonb;
