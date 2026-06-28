CREATE TABLE IF NOT EXISTS site_vars (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_vars_live
  ON site_vars(environment, site_id, name)
  WHERE deleted_at IS NULL;
