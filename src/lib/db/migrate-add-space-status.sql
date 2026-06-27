-- Run this on your Neon/Postgres DB to add project status support
CREATE TYPE space_status AS ENUM ('on_track', 'at_risk', 'on_hold', 'completed');
ALTER TABLE spaces ADD COLUMN status space_status NOT NULL DEFAULT 'on_track';
