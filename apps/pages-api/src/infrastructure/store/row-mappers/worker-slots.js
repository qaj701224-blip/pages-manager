export function mapWorkerSlot(row) {
  return {
    id: row.id,
    environment: row.environment,
    slotNumber: row.slot_number,
    workerName: row.worker_name,
    bindingName: row.binding_name,
    status: row.status,
    assignedSiteId: row.assigned_site_id,
    assignedRouteId: row.assigned_route_id,
    assignedVersionId: row.assigned_version_id,
    assignedAt: row.assigned_at,
    lastDeployedVersionId: row.last_deployed_version_id,
    lastSeenAt: row.last_seen_at,
    healthStatus: row.health_status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAdminNormalWorkerSlot(row) {
  const slot = mapWorkerSlot(row);
  return {
    ...slot,
    activeRoute: row.active_route_id
      ? {
          siteId: row.active_site_id,
          routeId: row.active_route_id,
          activeVersionId: row.active_version_id,
          hostname: row.active_hostname,
        }
      : null,
  };
}
