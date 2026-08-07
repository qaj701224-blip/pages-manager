ALTER TABLE sites ADD COLUMN default_exposure TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE sites ADD COLUMN default_access_mode TEXT;

ALTER TABLE site_routes ADD COLUMN exposure TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE site_routes ADD COLUMN access_mode TEXT;

UPDATE sites
SET default_access_mode = CASE default_visibility
  WHEN 'internal' THEN 'anonymous'
  WHEN 'org' THEN 'org'
  WHEN 'acl' THEN 'acl'
  WHEN 'owner' THEN 'owner'
  WHEN 'disabled' THEN 'disabled'
  ELSE NULL
END;

UPDATE site_routes
SET access_mode = CASE visibility
  WHEN 'internal' THEN 'anonymous'
  WHEN 'org' THEN 'org'
  WHEN 'acl' THEN 'acl'
  WHEN 'owner' THEN 'owner'
  WHEN 'disabled' THEN 'disabled'
  ELSE NULL
END;

CREATE TABLE IF NOT EXISTS site_policy_locks (
  environment TEXT NOT NULL,
  site_id TEXT NOT NULL,
  lock_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (environment, site_id)
);
