ALTER TABLE deployments ADD COLUMN failure_stage TEXT;
ALTER TABLE deployments ADD COLUMN failure_diagnostics_json TEXT;

CREATE TABLE IF NOT EXISTS deployment_resource_cleanup_tasks (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  site_id TEXT,
  version_id TEXT,
  deployment_id TEXT,
  cleanup_reason TEXT NOT NULL,
  status TEXT NOT NULL,
  cleanup_after TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cleanup_tasks_environment_status
  ON deployment_resource_cleanup_tasks(environment, status, cleanup_after);

CREATE INDEX IF NOT EXISTS idx_cleanup_tasks_resource
  ON deployment_resource_cleanup_tasks(environment, resource_type, resource_ref);
