import { makeId } from '@xd/workflow-core';

import { githubDeliveryToRow, rowToGithubDelivery } from '../rows/github-row.js';
import { execute, insertRowIfNotDuplicate, limitOffsetSql, upsertRow } from '../sql.js';

export const githubDeliveryRepositoryMethods = {
  async recordGithubDelivery(input) {
    const now = new Date().toISOString();
    const delivery = {
      id: makeId('ghdeliv'),
      repoFullName: input.repoFullName,
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      action: input.action || null,
      status: 'received',
      createdAt: now,
      updatedAt: now,
    };
    const created = await insertRowIfNotDuplicate(this.pool, 'github_webhook_deliveries', githubDeliveryToRow(delivery));
    const rows = await execute(
      this.pool,
      'SELECT * FROM github_webhook_deliveries WHERE repo_full_name = ? AND delivery_id = ? LIMIT 1',
      [input.repoFullName, input.deliveryId]
    );
    const stored = rowToGithubDelivery(rows[0]) || delivery;
    return { delivery: this.cacheGithubDelivery(stored), created };
  },

  async updateGithubDelivery(input = {}, patch = {}, now = new Date()) {
    const repoFullName = input.repoFullName || input.repo_full_name;
    const deliveryId = input.deliveryId || input.delivery_id;
    if (!repoFullName || !deliveryId) return null;
    const rows = await execute(
      this.pool,
      'SELECT * FROM github_webhook_deliveries WHERE repo_full_name = ? AND delivery_id = ? LIMIT 1',
      [repoFullName, deliveryId]
    );
    const existing = rowToGithubDelivery(rows[0]);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...patch,
      status: patch.status || existing.status || 'received',
      requestId:
        Object.hasOwn(patch, 'requestId') || Object.hasOwn(patch, 'request_id')
          ? patch.requestId || patch.request_id || null
          : existing.requestId || null,
      payloadHash:
        Object.hasOwn(patch, 'payloadHash') || Object.hasOwn(patch, 'payload_hash')
          ? patch.payloadHash || patch.payload_hash || null
          : existing.payloadHash || null,
      updatedAt: now.toISOString(),
    };
    this.cacheGithubDelivery(updated);
    await upsertRow(this.pool, 'github_webhook_deliveries', githubDeliveryToRow(updated), {
      excludeUpdate: ['id', 'created_at'],
    });
    return updated;
  },

  async listGithubDeliveries(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const where = [];
    const params = [];
    if (options.repoFullName) {
      where.push('repo_full_name = ?');
      params.push(options.repoFullName);
    }
    if (options.eventName) {
      where.push('event_name = ?');
      params.push(options.eventName);
    }
    if (options.action) {
      where.push('action = ?');
      params.push(options.action);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRows = await execute(this.pool, `SELECT COUNT(*) AS total FROM github_webhook_deliveries ${whereSql}`, params);
    const rows = await execute(
      this.pool,
      `SELECT * FROM github_webhook_deliveries ${whereSql} ORDER BY updated_at DESC ${limitOffsetSql(limit, offset)}`,
      params
    );
    return {
      deliveries: rows.map((row) => this.cacheGithubDelivery(rowToGithubDelivery(row))),
      total: Number(countRows[0]?.total || 0),
      limit,
      offset,
    };
  },
};
