export const SCHEMA_VERSION = 5;

export function createSchemaSql() {
  return [
    `CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      account TEXT,
      account_id TEXT,
      email TEXT NOT NULL,
      realname TEXT,
      employeenum TEXT,
      employee_status TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      environment TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      default_visibility TEXT NOT NULL,
      execution_mode_override TEXT,
      site_uuid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS site_routes (
      id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      site_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      runtime TEXT NOT NULL,
      execution_provider TEXT,
      worker_name TEXT,
      dispatch_type TEXT,
      dispatch_binding_name TEXT,
      slot_id TEXT,
      active_version_id TEXT,
      visibility TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      route_generation INTEGER NOT NULL,
      route_status TEXT NOT NULL,
      cache_tier TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS site_versions (
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
    )`,
    `CREATE TABLE IF NOT EXISTS worker_slots (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      slot_number INTEGER NOT NULL,
      worker_name TEXT NOT NULL,
      binding_name TEXT NOT NULL,
      status TEXT NOT NULL,
      assigned_site_id TEXT,
      assigned_route_id TEXT,
      assigned_version_id TEXT,
      assigned_at TEXT,
      last_deployed_version_id TEXT,
      last_seen_at TEXT,
      health_status TEXT NOT NULL DEFAULT 'unknown',
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      site_id TEXT NOT NULL,
      version_id TEXT,
      actor_id TEXT NOT NULL,
      actor_user_id TEXT,
      actor_type TEXT NOT NULL,
      source TEXT NOT NULL,
      operation TEXT NOT NULL,
      visibility TEXT,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      idempotency_scope TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      terminal_response_json TEXT,
      previous_version_id TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS site_members (
      site_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (site_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS site_acl_entries (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_value TEXT NOT NULL,
      access_role TEXT NOT NULL,
      effect TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS access_keys (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      pepper_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      site_id TEXT,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS auth_sessions_index (
      sid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      revoked_at TEXT,
      auth_time TEXT NOT NULL,
      user_agent_hash TEXT,
      ip_hash TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      trace_id TEXT,
      event_type TEXT NOT NULL,
      actor_user_id TEXT,
      actor_type TEXT NOT NULL,
      site_id TEXT,
      route_id TEXT,
      version_id TEXT,
      decision TEXT NOT NULL,
      status_code INTEGER,
      ip_hash TEXT,
      user_agent_hash TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_environment_slug
      ON sites(environment, slug)
      WHERE deleted_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_routes_hostname
      ON site_routes(hostname)`,
    `CREATE INDEX IF NOT EXISTS idx_site_routes_site_id
      ON site_routes(site_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_slots_environment_number
      ON worker_slots(environment, slot_number)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_slots_environment_binding
      ON worker_slots(environment, binding_name)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_slots_environment_worker
      ON worker_slots(environment, worker_name)`,
    `CREATE INDEX IF NOT EXISTS idx_worker_slots_status
      ON worker_slots(environment, status, slot_number)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_idempotency
      ON deployments(idempotency_scope, idempotency_key)`,
    `CREATE INDEX IF NOT EXISTS idx_site_acl_entries_site
      ON site_acl_entries(site_id, created_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_acl_entries_unique_subject
      ON site_acl_entries(site_id, subject_type, subject_value, access_role, effect)`,
    `CREATE INDEX IF NOT EXISTS idx_access_keys_owner
      ON access_keys(owner_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_site_created
      ON audit_events(site_id, created_at)`,
  ];
}
