-- Run this SQL in your Neon database console to set up the tables

CREATE TYPE group_status AS ENUM ('pending', 'approved', 'removed', 'review');

CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  link TEXT NOT NULL UNIQUE,
  description TEXT,
  name TEXT,
  image_url TEXT,
  status group_status NOT NULL DEFAULT 'pending',
  last_checked_at TIMESTAMP,
  broken_since TIMESTAMP,
  removed_reason TEXT,
  removed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- For older databases that already have the groups table, run these manually:
-- ALTER TYPE group_status ADD VALUE IF NOT EXISTS 'removed';
-- ALTER TYPE group_status ADD VALUE IF NOT EXISTS 'review';
-- ALTER TABLE groups ADD COLUMN IF NOT EXISTS name TEXT;
-- ALTER TABLE groups ADD COLUMN IF NOT EXISTS image_url TEXT;
-- ALTER TABLE groups ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP;
-- ALTER TABLE groups ADD COLUMN IF NOT EXISTS broken_since TIMESTAMP;
-- ALTER TABLE groups ADD COLUMN IF NOT EXISTS removed_reason TEXT;
-- ALTER TABLE groups ADD COLUMN IF NOT EXISTS removed_at TIMESTAMP;
-- ALTER TABLE groups ADD CONSTRAINT groups_link_unique UNIQUE (link);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reports_group_id_idx ON reports(group_id);

-- Add your first WhatsApp group link here (change the link below)
INSERT INTO groups (link, description, status)
VALUES (
  'https://chat.whatsapp.com/LFTB4WMVPrm4xTpfBamPzW',
  'WhatsApp OTP Group - Join to share and receive OTP codes',
  'approved'
)
ON CONFLICT (link) DO NOTHING;
