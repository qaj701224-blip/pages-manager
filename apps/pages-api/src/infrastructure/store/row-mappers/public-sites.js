export function mapPublicSite(row) {
  return {
    id: row.id,
    title: row.title || null,
    slug: row.slug,
    slugRevision: Number(row.slug_revision),
    slugRoutingSyncedRevision: Number(row.slug_routing_synced_revision),
    environment: row.environment,
    ownerType: row.owner_type,
    hostname: row.route_hostname,
    visibility: row.route_visibility,
    createdAt: row.created_at,
    updatedAt: row.effective_updated_at,
  };
}
