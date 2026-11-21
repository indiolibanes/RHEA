CREATE TABLE IF NOT EXISTS rhea_drive_links (
  actor TEXT PRIMARY KEY,
  account TEXT,
  link_id TEXT,
  sealed TEXT,
  access_expires INTEGER,
  renew_lock TEXT,
  renew_until INTEGER,
  updated INTEGER NOT NULL
);
ALTER TABLE oauth_tokens ADD COLUMN scope TEXT;
