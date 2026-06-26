-- Allow legacy v1/v2 claims to coexist on the same normalized slug when
-- their concrete hostnames differ. Runtime acquire still rejects new owners
-- while any live claim in the slug group remains active or in reuse hold.

DROP INDEX IF EXISTS idx_hostname_claims_environment_slug_live;

CREATE INDEX IF NOT EXISTS idx_hostname_claims_environment_slug_live
  ON hostname_claims(environment, normalized_slug)
  WHERE status IN ('pending', 'active', 'held', 'conflicted');
