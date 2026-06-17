-- Keep incremental ACL grant idempotent across retries and concurrent requests.

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_acl_entries_unique_subject
  ON site_acl_entries(site_id, subject_type, subject_value, access_role, effect);
