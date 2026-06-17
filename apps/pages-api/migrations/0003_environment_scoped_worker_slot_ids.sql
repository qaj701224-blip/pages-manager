-- Scope legacy normal-worker-slot ids by environment.
-- This keeps staging and production slot rows unique even if they share a D1 database
-- during previews, dry-runs, or future migration operations.

UPDATE site_routes
SET slot_id = 'slot_' || environment || '_' || substr(slot_id, 6)
WHERE slot_id GLOB 'slot_[0-9][0-9][0-9]';

UPDATE site_versions
SET slot_id = (
  SELECT 'slot_' || sites.environment || '_' || substr(site_versions.slot_id, 6)
  FROM sites
  WHERE sites.id = site_versions.site_id
)
WHERE slot_id GLOB 'slot_[0-9][0-9][0-9]'
  AND EXISTS (
    SELECT 1
    FROM sites
    WHERE sites.id = site_versions.site_id
  );

UPDATE worker_slots
SET id = 'slot_' || environment || '_' || substr(id, 6)
WHERE id GLOB 'slot_[0-9][0-9][0-9]';
