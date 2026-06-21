-- Replace the early artifact_kind storage model with resolved deployment metadata.
-- The table rebuild removes the old NOT NULL column so new deploys only persist
-- deploymentShape / fallback / routingMode.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE site_versions_next (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  execution_provider TEXT,
  dispatch_type TEXT,
  dispatch_binding_name TEXT,
  slot_id TEXT,
  artifact_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deployment_shape TEXT NOT NULL,
  requested_fallback TEXT NOT NULL,
  resolved_fallback TEXT,
  routing_mode TEXT NOT NULL,
  worker_entry TEXT,
  assets_config_json TEXT,
  worker_modules_json TEXT,
  asset_manifest_json TEXT,
  canonical_content_hash TEXT,
  artifact_availability TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO site_versions_next (
  id,
  site_id,
  deployment_id,
  worker_name,
  runtime,
  execution_provider,
  dispatch_type,
  dispatch_binding_name,
  slot_id,
  artifact_ref,
  content_hash,
  deployment_shape,
  requested_fallback,
  resolved_fallback,
  routing_mode,
  worker_entry,
  assets_config_json,
  worker_modules_json,
  asset_manifest_json,
  canonical_content_hash,
  artifact_availability,
  created_by,
  created_at
)
SELECT
  id,
  site_id,
  deployment_id,
  worker_name,
  runtime,
  execution_provider,
  dispatch_type,
  dispatch_binding_name,
  slot_id,
  artifact_ref,
  content_hash,
  CASE artifact_kind
    WHEN 'worker' THEN 'worker-only'
    ELSE 'assets-only'
  END,
  'auto',
  CASE artifact_kind
    WHEN 'worker' THEN NULL
    WHEN 'spa' THEN 'index'
    ELSE 'not-found'
  END,
  CASE artifact_kind
    WHEN 'worker' THEN 'worker-only'
    ELSE 'assets-only'
  END,
  NULL,
  CASE artifact_kind
    WHEN 'worker' THEN NULL
    WHEN 'spa' THEN '{"not_found_handling":"single-page-application"}'
    ELSE '{"not_found_handling":"404-page"}'
  END,
  NULL,
  NULL,
  content_hash,
  'active',
  created_by,
  created_at
FROM site_versions;

DROP TABLE site_versions;

ALTER TABLE site_versions_next RENAME TO site_versions;

PRAGMA defer_foreign_keys = OFF;
