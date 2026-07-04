-- Add optional cover image to spaces (used as the card thumbnail instead of the gradient monogram)
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS image_key text;
