CREATE TABLE IF NOT EXISTS rhea_proposals (
  id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, actor TEXT NOT NULL, account TEXT NOT NULL, client TEXT NOT NULL,
  action TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rhea_proposals_owner ON rhea_proposals(actor, account, expires);
CREATE TABLE IF NOT EXISTS rhea_proposal_events (
  proposal_id TEXT NOT NULL, state TEXT NOT NULL, actor_hash TEXT NOT NULL, client TEXT NOT NULL,
  action TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (proposal_id, state)
);
