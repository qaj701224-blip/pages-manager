import { cloneRecord, mapAdminNormalWorkerSlot, mapWorkerSlot } from '../store-support.js';

export const workerSlotsRepositoryMethods = {
  async createWorkerSlot(input) {
    const now = input.createdAt || this.now();
    const record = {
      id: input.id,
      environment: input.environment,
      slotNumber: input.slotNumber,
      workerName: input.workerName,
      bindingName: input.bindingName,
      status: input.status || 'provisioning',
      assignedSiteId: input.assignedSiteId || null,
      assignedRouteId: input.assignedRouteId || null,
      assignedVersionId: input.assignedVersionId || null,
      assignedAt: input.assignedAt || null,
      lastDeployedVersionId: input.lastDeployedVersionId || null,
      lastSeenAt: input.lastSeenAt || null,
      healthStatus: input.healthStatus || 'unknown',
      notes: input.notes || null,
      createdAt: now,
      updatedAt: input.updatedAt || now,
    };
    await this.db
      .prepare(
        `INSERT INTO worker_slots (
            id, environment, slot_number, worker_name, binding_name, status,
            assigned_site_id, assigned_route_id, assigned_version_id, assigned_at,
            last_deployed_version_id, last_seen_at, health_status, notes,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.slotNumber,
        record.workerName,
        record.bindingName,
        record.status,
        record.assignedSiteId,
        record.assignedRouteId,
        record.assignedVersionId,
        record.assignedAt,
        record.lastDeployedVersionId,
        record.lastSeenAt,
        record.healthStatus,
        record.notes,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return cloneRecord(record);
  },

  async getWorkerSlot(id) {
    const row = await this.db.prepare('SELECT * FROM worker_slots WHERE id = ?').bind(id).first();
    return row ? mapWorkerSlot(row) : null;
  },

  async listWorkerSlots(environment) {
    const result = await this.db
      .prepare(
        `SELECT * FROM worker_slots
          WHERE environment = ?
          ORDER BY slot_number ASC`
      )
      .bind(environment)
      .all();
    return (result.results || []).map(mapWorkerSlot);
  },

  async listAdminNormalWorkers({ environment }) {
    const result = await this.db
      .prepare(
        `WITH active_slot_routes AS (
            SELECT worker_slots.id AS worker_slot_id, MIN(site_routes.id) AS active_route_id
            FROM worker_slots
            JOIN site_routes
              ON site_routes.environment = worker_slots.environment
              AND site_routes.route_status = 'active'
              AND (
                site_routes.slot_id = worker_slots.id
                OR site_routes.active_version_id = worker_slots.assigned_version_id
              )
            WHERE worker_slots.environment = ?
            GROUP BY worker_slots.id
          )
          SELECT worker_slots.*,
            site_routes.site_id AS active_site_id,
            site_routes.id AS active_route_id,
            site_routes.active_version_id AS active_version_id,
            site_routes.hostname AS active_hostname
          FROM worker_slots
          LEFT JOIN active_slot_routes ON active_slot_routes.worker_slot_id = worker_slots.id
          LEFT JOIN site_routes ON site_routes.id = active_slot_routes.active_route_id
          WHERE worker_slots.environment = ?
          ORDER BY worker_slots.slot_number ASC`
      )
      .bind(environment, environment)
      .all();
    return (result.results || []).map(mapAdminNormalWorkerSlot);
  },

  async retireIdleNormalWorker({ id, environment, actorUserId, reason, updatedAt }) {
    const now = updatedAt || this.now();
    const note = `retired by ${actorUserId || 'unknown'}: ${reason || 'legacy normal worker retired'}`;
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
          SET status = 'retired',
            assigned_site_id = NULL,
            assigned_route_id = NULL,
            assigned_version_id = NULL,
            assigned_at = NULL,
            notes = ?,
            updated_at = ?
          WHERE id = ?
            AND environment = ?
            AND status IN ('available', 'assigned', 'cleanup_pending', 'disabled', 'delete_pending')
            AND NOT EXISTS (
              SELECT 1 FROM site_routes
              WHERE site_routes.environment = worker_slots.environment
                AND site_routes.route_status = 'active'
                AND (
                  site_routes.slot_id = worker_slots.id
                  OR site_routes.active_version_id = worker_slots.assigned_version_id
                )
            )`
      )
      .bind(note, now, id, environment)
      .run();
    if (result?.meta?.changes === 0) return null;
    const slot = await this.getWorkerSlot(id);
    return slot ? { ...slot, activeRoute: null } : null;
  },

  async markNormalWorkerDeletePending({ id, environment, actorUserId, reason, updatedAt }) {
    const now = updatedAt || this.now();
    const note = `delete pending by ${actorUserId || 'unknown'}: ${reason || 'legacy normal worker delete pending'}`;
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
          SET status = 'delete_pending',
            notes = ?,
            updated_at = ?
          WHERE id = ?
            AND environment = ?
            AND status IN ('available', 'assigned', 'cleanup_pending', 'disabled', 'delete_pending')
            AND NOT EXISTS (
              SELECT 1 FROM site_routes
              WHERE site_routes.environment = worker_slots.environment
                AND site_routes.route_status = 'active'
                AND (
                  site_routes.slot_id = worker_slots.id
                  OR site_routes.active_version_id = worker_slots.assigned_version_id
                )
            )`
      )
      .bind(note, now, id, environment)
      .run();
    if (result?.meta?.changes === 0) return null;
    const slot = await this.getWorkerSlot(id);
    return slot ? { ...slot, activeRoute: null } : null;
  },

  async assignAvailableWorkerSlot({ environment, siteId, routeId, versionId, assignedAt }) {
    const slotsResult = await this.db
      .prepare(
        `SELECT * FROM worker_slots
          WHERE environment = ? AND status = 'available'
          ORDER BY slot_number ASC
          LIMIT 20`
      )
      .bind(environment)
      .all();
    const slots = slotsResult?.results || [];
    if (slots.length === 0) return null;
    const now = assignedAt || this.now();
    for (const slot of slots) {
      const result = await this.db
        .prepare(
          `UPDATE worker_slots
            SET status = 'assigned', assigned_site_id = ?, assigned_route_id = ?,
              assigned_version_id = ?, assigned_at = ?, last_deployed_version_id = ?,
              updated_at = ?
            WHERE id = ? AND status = 'available'`
        )
        .bind(siteId, routeId, versionId, now, versionId, now, slot.id)
        .run();
      if (!result?.meta || result.meta.changes !== 0) return this.getWorkerSlot(slot.id);
    }
    return null;
  },

  async releaseWorkerSlot(id, { status = 'available', updatedAt } = {}) {
    const now = updatedAt || this.now();
    await this.db
      .prepare(
        `UPDATE worker_slots
          SET status = ?, assigned_site_id = NULL, assigned_route_id = NULL,
            assigned_version_id = NULL, assigned_at = NULL, updated_at = ?
          WHERE id = ?`
      )
      .bind(status, now, id)
      .run();
    return this.getWorkerSlot(id);
  },

  async markWorkerSlotCleanupPending(id, { expectedVersionId, updatedAt } = {}) {
    if (!expectedVersionId) return null;
    const now = updatedAt || this.now();
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
          SET status = 'cleanup_pending', updated_at = ?
          WHERE id = ?
            AND status = 'assigned'
            AND assigned_version_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM site_routes
              WHERE site_routes.environment = worker_slots.environment
                AND site_routes.route_status = 'active'
                AND (
                  site_routes.slot_id = worker_slots.id
                  OR site_routes.active_version_id = worker_slots.assigned_version_id
                )
            )`
      )
      .bind(now, id, expectedVersionId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getWorkerSlot(id);
  },

  async releaseCleanupWorkerSlot(id, { expectedVersionId, updatedAt } = {}) {
    if (!expectedVersionId) return null;
    const now = updatedAt || this.now();
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
          SET status = 'available',
            assigned_site_id = NULL,
            assigned_route_id = NULL,
            assigned_version_id = NULL,
            assigned_at = NULL,
            last_deployed_version_id = COALESCE(last_deployed_version_id, ?),
            updated_at = ?
          WHERE id = ?
            AND status = 'cleanup_pending'
            AND assigned_version_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM site_routes
              WHERE site_routes.environment = worker_slots.environment
                AND site_routes.route_status = 'active'
                AND (
                  site_routes.slot_id = worker_slots.id
                  OR site_routes.active_version_id = worker_slots.assigned_version_id
                )
            )`
      )
      .bind(expectedVersionId, now, id, expectedVersionId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getWorkerSlot(id);
  },
};
