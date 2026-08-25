ALTER TABLE sites ADD COLUMN title TEXT;
ALTER TABLE sites ADD COLUMN data_namespace TEXT;
ALTER TABLE sites ADD COLUMN slug_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sites ADD COLUMN slug_routing_synced_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sites ADD COLUMN slug_routing_reconcile_attempted_at TEXT;

UPDATE sites SET data_namespace = slug WHERE data_namespace IS NULL;

CREATE INDEX IF NOT EXISTS idx_sites_slug_routing_reconciliation
  ON sites(environment, slug_routing_reconcile_attempted_at, updated_at, id)
  WHERE deleted_at IS NULL;
