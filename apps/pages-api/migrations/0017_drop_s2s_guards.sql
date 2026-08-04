DROP INDEX IF EXISTS idx_s2s_nonces_expires_at;
DROP INDEX IF EXISTS idx_s2s_rate_limits_expires_at;
DROP INDEX IF EXISTS idx_access_keys_s2s_owner_created;

DROP TABLE IF EXISTS s2s_nonces;
DROP TABLE IF EXISTS s2s_rate_limits;
