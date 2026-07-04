-- Add new document type enum values
-- Run once against production DB before deploying the new file-type support

ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'pptx';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'image';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'zip';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'email';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'cad';
