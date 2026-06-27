ALTER TABLE site_versions ADD COLUMN var_names_json TEXT;
ALTER TABLE site_versions ADD COLUMN secret_names_json TEXT;
ALTER TABLE site_versions ADD COLUMN runtime_config_snapshot_json TEXT;

CREATE TABLE IF NOT EXISTS site_secrets (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_secrets_live
  ON site_secrets(environment, site_id, name)
  WHERE deleted_at IS NULL;
