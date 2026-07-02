export const SCHEMA_VERSION = 11;

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
      department_path TEXT,
      department_checked_at TEXT,
      session_version INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      environment TEXT NOT NULL,
      owner_type TEXT NOT NULL DEFAULT 'user',
      owner_id TEXT,
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
      runtime_config_generation INTEGER NOT NULL DEFAULT 0,
      runtime_config_lock_id TEXT,
      route_status TEXT NOT NULL,
      cache_tier TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS hostname_claims (
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
    )`,
    `CREATE TABLE IF NOT EXISTS hostname_claim_conflicts (
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
      var_names_json TEXT,
      secret_names_json TEXT,
      runtime_config_snapshot_json TEXT,
      artifact_availability TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS site_secrets (
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
    )`,
    `CREATE TABLE IF NOT EXISTS site_vars (
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
      environment TEXT,
      owner_user_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      pepper_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      site_id TEXT,
      owner_type TEXT NOT NULL DEFAULT 'user',
      owner_id TEXT,
      created_by_user_id TEXT,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      revoked_by_user_id TEXT,
      revoked_reason TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      team_type TEXT NOT NULL,
      department_path TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_by_type TEXT NOT NULL,
      created_by_user_id TEXT,
      merged_into_team_id TEXT,
      merged_at TEXT,
      merged_by_user_id TEXT,
      merge_reason TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      membership_source TEXT NOT NULL,
      department_path TEXT,
      role_overridden_at TEXT,
      removed_at TEXT,
      removed_by_user_id TEXT,
      restored_at TEXT,
      restored_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS platform_admins (
      environment TEXT NOT NULL,
      user_id TEXT NOT NULL,
      granted_by_user_id TEXT NOT NULL,
      grant_reason TEXT,
      revoked_at TEXT,
      revoked_by_user_id TEXT,
      revoke_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (environment, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      name TEXT NOT NULL,
      events_json TEXT NOT NULL,
      payload_mode TEXT NOT NULL,
      restricted_template_json TEXT,
      encrypted_url_ciphertext TEXT NOT NULL,
      url_host TEXT NOT NULL,
      url_masked TEXT NOT NULL,
      url_fingerprint TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_delivery_status TEXT,
      created_by_user_id TEXT NOT NULL,
      disabled_at TEXT,
      disabled_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      render_status TEXT NOT NULL,
      payload_mode TEXT NOT NULL,
      template_revision INTEGER,
      payload_hash TEXT,
      target_host TEXT NOT NULL,
      http_status INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
      environment TEXT,
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
    `CREATE INDEX IF NOT EXISTS idx_sites_owner
      ON sites(environment, owner_type, owner_id)
      WHERE deleted_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_routes_hostname_live
      ON site_routes(hostname)
      WHERE route_status != 'deleted'`,
    `CREATE INDEX IF NOT EXISTS idx_site_routes_site_id
      ON site_routes(site_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_secrets_live
      ON site_secrets(environment, site_id, name)
      WHERE deleted_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_vars_live
      ON site_vars(environment, site_id, name)
      WHERE deleted_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_hostname_claims_hostname
      ON hostname_claims(hostname)`,
    `CREATE INDEX IF NOT EXISTS idx_hostname_claims_environment_slug_live
      ON hostname_claims(environment, normalized_slug)
      WHERE status IN ('pending', 'active', 'held', 'conflicted')`,
    `CREATE INDEX IF NOT EXISTS idx_hostname_claim_conflicts_hostname
      ON hostname_claim_conflicts(hostname)`,
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
    `CREATE INDEX IF NOT EXISTS idx_access_keys_owner_model
      ON access_keys(owner_type, owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_access_keys_environment_owner
      ON access_keys(environment, owner_type, owner_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_department_active
      ON teams(environment, team_type, department_path)
      WHERE team_type = 'department' AND status = 'active'`,
    `CREATE INDEX IF NOT EXISTS idx_teams_environment_status
      ON teams(environment, status)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_team_user
      ON team_members(team_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_team_members_user_active
      ON team_members(user_id, team_id)
      WHERE removed_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_environment
      ON webhook_subscriptions(environment, enabled, updated_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_subscriptions_fingerprint
      ON webhook_subscriptions(environment, url_fingerprint)`,
    `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
      ON webhook_deliveries(environment, subscription_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_site_created
      ON audit_events(site_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_events_environment_created
      ON audit_events(environment, created_at)`,
  ];
}
