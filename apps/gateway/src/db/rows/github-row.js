import { makeId } from '@xd/workflow-core';

import { toDate, toIso } from '../sql.js';

export function githubDeliveryToRow(delivery) {
  return {
    id: delivery.id || makeId('ghdeliv'),
    repo_full_name: delivery.repoFullName,
    delivery_id: delivery.deliveryId,
    event_name: delivery.eventName,
    action: delivery.action || null,
    status: delivery.status || 'received',
    request_id: delivery.requestId || null,
    payload_hash: delivery.payloadHash || null,
    created_at: toDate(delivery.createdAt),
    updated_at: toDate(delivery.updatedAt || delivery.createdAt),
  };
}

export function rowToGithubDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    deliveryId: row.delivery_id,
    eventName: row.event_name,
    action: row.action || null,
    status: row.status || 'received',
    requestId: row.request_id || null,
    payloadHash: row.payload_hash || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
