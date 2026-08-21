ALTER TABLE deployments ADD COLUMN trace_id TEXT;

CREATE TABLE IF NOT EXISTS deployment_events (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  inbound_ray_id TEXT,
  deployment_id TEXT,
  site_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  stage TEXT NOT NULL,
  operation TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  diagnostics_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployment_events_deployment
  ON deployment_events(environment, deployment_id, started_at);

CREATE INDEX IF NOT EXISTS idx_deployment_events_trace
  ON deployment_events(environment, trace_id, started_at);

CREATE INDEX IF NOT EXISTS idx_deployment_events_site
  ON deployment_events(environment, site_id, created_at);
