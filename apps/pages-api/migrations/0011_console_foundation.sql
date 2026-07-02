ALTER TABLE users ADD COLUMN department_path TEXT;
ALTER TABLE users ADD COLUMN department_checked_at TEXT;

ALTER TABLE sites ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE sites ADD COLUMN owner_id TEXT;

UPDATE sites
SET owner_type = 'user',
  owner_id = owner_user_id
WHERE owner_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_sites_owner
  ON sites(environment, owner_type, owner_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS teams (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_department_active
  ON teams(environment, team_type, department_path)
  WHERE team_type = 'department' AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_teams_environment_status
  ON teams(environment, status);

CREATE TABLE IF NOT EXISTS team_members (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_team_user
  ON team_members(team_id, user_id);

CREATE INDEX IF NOT EXISTS idx_team_members_user_active
  ON team_members(user_id, team_id)
  WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_admins (
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
);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
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
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_environment
  ON webhook_subscriptions(environment, enabled, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_subscriptions_fingerprint
  ON webhook_subscriptions(environment, url_fingerprint);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
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
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhook_deliveries(environment, subscription_id, created_at);

ALTER TABLE access_keys ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE access_keys ADD COLUMN owner_id TEXT;
ALTER TABLE access_keys ADD COLUMN created_by_user_id TEXT;
ALTER TABLE access_keys ADD COLUMN revoked_by_user_id TEXT;
ALTER TABLE access_keys ADD COLUMN revoked_reason TEXT;
ALTER TABLE access_keys ADD COLUMN environment TEXT;

UPDATE access_keys
SET owner_type = 'user',
  owner_id = owner_user_id,
  created_by_user_id = owner_user_id
WHERE owner_id IS NULL;

UPDATE access_keys
SET environment = (
  SELECT sites.environment
  FROM sites
  WHERE sites.id = access_keys.site_id
)
WHERE environment IS NULL
  AND site_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_access_keys_owner_model
  ON access_keys(owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_access_keys_environment_owner
  ON access_keys(environment, owner_type, owner_id);
