-- Add a cross-version hostname claim ledger for v1/v2 workers.xd.team coexistence.

CREATE TABLE IF NOT EXISTS hostname_claims (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  hostname TEXT NOT NULL,
  normalized_slug TEXT NOT NULL,
  hostname_family TEXT NOT NULL,
  owner_system TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  lease_expires_at TEXT,
  released_at TEXT,
  reuse_hold_until TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hostname_claim_conflicts (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  hostname TEXT NOT NULL,
  normalized_slug TEXT NOT NULL,
  candidate_system TEXT NOT NULL,
  candidate_owner_id TEXT NOT NULL,
  candidate_ref TEXT,
  candidate_hostname TEXT,
  reason TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostname_claims_hostname
  ON hostname_claims(hostname);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostname_claims_environment_slug_live
  ON hostname_claims(environment, normalized_slug)
  WHERE status IN ('pending', 'active', 'held', 'conflicted');

CREATE INDEX IF NOT EXISTS idx_hostname_claim_conflicts_hostname
  ON hostname_claim_conflicts(hostname);
