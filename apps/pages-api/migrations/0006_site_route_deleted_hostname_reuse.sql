-- Allow deleted site_routes to preserve history without occupying reusable hostnames.

DROP INDEX IF EXISTS idx_site_routes_hostname;

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_routes_hostname_live
  ON site_routes(hostname)
  WHERE route_status != 'deleted';
