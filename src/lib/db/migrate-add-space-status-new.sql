-- Add 'new' value to space_status enum and change default for spaces.status
ALTER TYPE space_status ADD VALUE IF NOT EXISTS 'new';
ALTER TABLE spaces ALTER COLUMN status SET DEFAULT 'new';
