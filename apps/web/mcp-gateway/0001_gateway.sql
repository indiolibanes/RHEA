CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY, client TEXT NOT NULL, redirect TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL,
  scope TEXT NOT NULL, expires INTEGER NOT NULL, actor TEXT, account TEXT, google TEXT, google_expires INTEGER,
  code TEXT UNIQUE, consumed INTEGER
);
CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, account TEXT NOT NULL, client TEXT NOT NULL, resource TEXT NOT NULL,
  scope TEXT NOT NULL, google TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER
);
CREATE INDEX IF NOT EXISTS rhea_grants_actor ON oauth_grants(actor, expires);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id), kind TEXT NOT NULL,
  expires INTEGER NOT NULL, consumed INTEGER
);
CREATE INDEX IF NOT EXISTS rhea_tokens_grant ON oauth_tokens(grant_id);
CREATE TABLE IF NOT EXISTS rhea_rate (key TEXT PRIMARY KEY, expires INTEGER NOT NULL, hits INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rhea_audit (
  id TEXT PRIMARY KEY, actor TEXT, client TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL
);
