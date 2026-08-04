ALTER TABLE users ADD COLUMN cindy_membership_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cindy_membership_id
  ON users(cindy_membership_id)
  WHERE cindy_membership_id IS NOT NULL;
