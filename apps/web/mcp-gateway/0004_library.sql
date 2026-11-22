-- Telegram Library foundation. Applying this migration grants no Telegram capability.
CREATE TABLE rhea_library_sources (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  peer_fingerprint TEXT NOT NULL UNIQUE,
  peer_sealed TEXT NOT NULL,
  display_label TEXT NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX rhea_library_sources_owner ON rhea_library_sources(actor, revoked_at);

CREATE TABLE rhea_library_series (
  source_id TEXT NOT NULL REFERENCES rhea_library_sources(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_title TEXT,
  PRIMARY KEY (source_id, id)
);
CREATE TABLE rhea_library_aliases (
  source_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  language TEXT NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (source_id, series_id, language, title),
  FOREIGN KEY (source_id, series_id) REFERENCES rhea_library_series(source_id, id)
);
CREATE TABLE rhea_library_snapshots (
  source_id TEXT NOT NULL REFERENCES rhea_library_sources(id),
  id TEXT NOT NULL,
  revision TEXT NOT NULL,
  head_message_id INTEGER CHECK (head_message_id > 0),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  inventory_hash TEXT NOT NULL CHECK (length(inventory_hash) = 64),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, id)
);
CREATE TABLE rhea_library_messages (
  source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  message_id INTEGER NOT NULL CHECK (message_id > 0),
  series_id TEXT,
  published_at INTEGER NOT NULL,
  edited_at INTEGER,
  display_label TEXT,
  caption TEXT,
  filename TEXT,
  season INTEGER CHECK (season >= 0),
  episode REAL CHECK (episode >= 0),
  part INTEGER CHECK (part > 0),
  kind TEXT NOT NULL CHECK (kind IN ('episode','ova','ona','special','movie','extra')),
  album_id TEXT,
  multipart_id TEXT,
  media_identity TEXT,
  size_bytes INTEGER CHECK (size_bytes >= 0),
  sha256 TEXT CHECK (length(sha256) = 64),
  copy_policy TEXT NOT NULL CHECK (copy_policy IN ('unknown','allowed','protected','unsupported')),
  PRIMARY KEY (source_id, snapshot_id, message_id),
  FOREIGN KEY (source_id, snapshot_id) REFERENCES rhea_library_snapshots(source_id, id),
  FOREIGN KEY (source_id, series_id) REFERENCES rhea_library_series(source_id, id)
);
CREATE INDEX rhea_library_messages_series ON rhea_library_messages(source_id, snapshot_id, series_id, season, episode);
CREATE TABLE rhea_library_corrections (
  source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  patch_json TEXT NOT NULL CHECK (json_valid(patch_json) AND json_type(patch_json) = 'object'),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, snapshot_id, message_id),
  FOREIGN KEY (source_id, snapshot_id, message_id) REFERENCES rhea_library_messages(source_id, snapshot_id, message_id)
);

CREATE TABLE rhea_library_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  strategy TEXT NOT NULL CHECK (strategy IN ('staging','suffix')),
  state TEXT NOT NULL CHECK (state IN ('SCANNED','PLANNED','APPROVED','COPYING','VERIFIED','AWAITING_DELETION_APPROVAL','FINALIZED','PAUSED','FAILED','RECOVERY_REQUIRED')),
  dry_run INTEGER NOT NULL DEFAULT 1 CHECK (dry_run IN (0,1)),
  lease_token TEXT,
  lease_until INTEGER,
  resume_after INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_id, snapshot_id) REFERENCES rhea_library_snapshots(source_id, id)
);
CREATE UNIQUE INDEX rhea_library_one_active_run ON rhea_library_runs(source_id)
  WHERE state IN ('APPROVED','COPYING','VERIFIED','AWAITING_DELETION_APPROVAL','PAUSED','RECOVERY_REQUIRED');

CREATE TABLE rhea_library_events (
  run_id TEXT NOT NULL REFERENCES rhea_library_runs(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_code TEXT NOT NULL,
  actor_hash TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, sequence)
);
CREATE TABLE rhea_library_receipts (
  run_id TEXT NOT NULL REFERENCES rhea_library_runs(id),
  batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
  operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING','CONFIRMED','UNCERTAIN')),
  expected_head INTEGER NOT NULL,
  next_head INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, batch_index)
);
CREATE TABLE rhea_library_message_map (
  run_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL CHECK (source_message_id > 0),
  destination_message_id INTEGER NOT NULL CHECK (destination_message_id > 0),
  PRIMARY KEY (run_id, source_message_id),
  UNIQUE (run_id, destination_message_id),
  FOREIGN KEY (run_id, batch_index) REFERENCES rhea_library_receipts(run_id, batch_index)
);
CREATE TABLE rhea_library_approvals (
  run_id TEXT NOT NULL REFERENCES rhea_library_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('copy','cleanup')),
  actor_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
  acknowledged_irreversibility INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_irreversibility IN (0,1)),
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > approved_at),
  consumed_at INTEGER,
  PRIMARY KEY (run_id, kind),
  CHECK (kind <> 'cleanup' OR acknowledged_irreversibility = 1)
);
