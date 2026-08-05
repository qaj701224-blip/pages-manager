-- Composite indexes for bounded resource-governance reconciliation queries.
CREATE INDEX IF NOT EXISTS idx_site_routes_environment_status_worker
  ON site_routes(environment, route_status, worker_name);

CREATE INDEX IF NOT EXISTS idx_site_routes_environment_worker_ownership
  ON site_routes(environment, worker_name);

CREATE INDEX IF NOT EXISTS idx_site_routes_worker_environment_ownership
  ON site_routes(worker_name, environment);

CREATE INDEX IF NOT EXISTS idx_site_versions_site_worker_artifact
  ON site_versions(site_id, worker_name, artifact_availability);

CREATE INDEX IF NOT EXISTS idx_site_versions_worker_site_ownership
  ON site_versions(worker_name, site_id);

CREATE INDEX IF NOT EXISTS idx_cleanup_tasks_environment_type_status_ref
  ON deployment_resource_cleanup_tasks(environment, resource_type, status, resource_ref);
