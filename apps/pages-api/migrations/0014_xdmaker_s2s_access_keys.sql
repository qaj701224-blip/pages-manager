ALTER TABLE users ADD COLUMN feishu_open_id TEXT;
ALTER TABLE users ADD COLUMN created_source TEXT NOT NULL DEFAULT 'xd_sso';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized
  ON users(lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_feishu_open_id
  ON users(feishu_open_id)
  WHERE feishu_open_id IS NOT NULL;

ALTER TABLE access_keys ADD COLUMN issued_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE access_keys ADD COLUMN issued_session_version INTEGER;

CREATE TABLE IF NOT EXISTS s2s_nonces (
  environment TEXT NOT NULL,
  client_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (environment, client_id, nonce)
);

CREATE TABLE IF NOT EXISTS s2s_rate_limits (
  environment TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (environment, scope, subject, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_s2s_nonces_expires_at
  ON s2s_nonces(expires_at);

CREATE INDEX IF NOT EXISTS idx_s2s_rate_limits_expires_at
  ON s2s_rate_limits(expires_at);

CREATE INDEX IF NOT EXISTS idx_access_keys_s2s_owner_created
  ON access_keys(environment, issued_source, owner_user_id, created_at);
