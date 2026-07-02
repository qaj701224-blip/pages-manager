ALTER TABLE audit_events ADD COLUMN environment TEXT;

UPDATE audit_events
SET environment = (
  SELECT sites.environment
  FROM sites
  WHERE sites.id = audit_events.site_id
)
WHERE environment IS NULL
  AND site_id IS NOT NULL;

UPDATE audit_events
SET environment = json_extract(metadata_json, '$.environment')
WHERE environment IS NULL
  AND metadata_json IS NOT NULL
  AND json_extract(metadata_json, '$.environment') IN ('production', 'staging');

CREATE INDEX IF NOT EXISTS idx_audit_events_environment_created
  ON audit_events(environment, created_at);
