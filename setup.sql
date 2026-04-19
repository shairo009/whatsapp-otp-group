-- Run this SQL in your Neon database console to set up the tables

CREATE TYPE group_status AS ENUM ('pending', 'approved');

CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  link TEXT NOT NULL,
  description TEXT,
  status group_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Add your first WhatsApp group link here (change the link below)
INSERT INTO groups (link, description, status)
VALUES (
  'https://chat.whatsapp.com/LFTB4WMVPrm4xTpfBamPzW',
  'WhatsApp OTP Group - Join to share and receive OTP codes',
  'approved'
);
