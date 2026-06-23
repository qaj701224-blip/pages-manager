import { makeId } from '@xd/workflow-core';

import { rowToSlackDelivery, slackDeliveryToRow } from '../rows/slack-row.js';
import { execute, insertRowIfNotDuplicate, limitOffsetSql, upsertRow } from '../sql.js';

export const slackDeliveryRepositoryMethods = {
  async recordSlackDelivery(input = {}) {
    const now = new Date().toISOString();
    const teamId = input.teamId || 'unknown-team';
    const eventId = input.eventId || 'unknown-event';
    const delivery = {
      id: input.id || makeId('slackevt'),
      teamId,
      eventId,
      eventType: input.eventType || null,
      action: input.action || null,
      processingStatus: input.processingStatus || input.processing_status || 'received',
      resultType: input.resultType || input.result_type || 'none',
      ignoredReason: input.ignoredReason || input.ignored_reason || null,
      errorCode: input.errorCode || input.error_code || null,
      errorMessage: input.errorMessage || input.error_message || null,
      retryNum: input.retryNum || input.retry_num || 0,
      retryReason: input.retryReason || input.retry_reason || null,
      requestId: input.requestId || input.request_id || null,
      channelId: input.channelId || input.channel_id || null,
      threadTs: input.threadTs || input.thread_ts || null,
      slackUserId: input.slackUserId || input.slack_user_id || null,
      slackSessionId: input.slackSessionId || input.slack_session_id || null,
      publishingJobId: input.publishingJobId || input.publishing_job_id || null,
      workItemKind: input.workItemKind || input.work_item_kind || null,
      workItemId: input.workItemId || input.work_item_id || null,
      platformDevItemId: input.platformDevItemId || input.platform_dev_item_id || null,
      agentRunId: input.agentRunId || input.agent_run_id || null,
      payloadRedacted: input.payloadRedacted || input.payload_redacted || input.payloadRedactedJson || null,
      payloadHash: input.payloadHash || input.payload_hash || null,
      receivedAt: input.receivedAt || input.received_at || now,
      createdAt: now,
      updatedAt: now,
    };
    const created = await insertRowIfNotDuplicate(this.pool, 'slack_events', slackDeliveryToRow(delivery));
    const stored = await this.findSlackDelivery(teamId, eventId);
    return { delivery: stored || this.cacheSlackDelivery(delivery), created };
  },

  async updateSlackDelivery(input = {}, patch = {}, now = new Date()) {
    const existing = await this.findSlackDelivery(input.teamId, input.eventId);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...patch,
      processingStatus: patch.processingStatus || patch.processing_status || existing.processingStatus,
      resultType: patch.resultType || patch.result_type || existing.resultType || 'none',
      ignoredReason:
        Object.hasOwn(patch, 'ignoredReason') || Object.hasOwn(patch, 'ignored_reason')
          ? patch.ignoredReason || patch.ignored_reason || null
          : existing.ignoredReason || null,
      errorCode:
        Object.hasOwn(patch, 'errorCode') || Object.hasOwn(patch, 'error_code')
          ? patch.errorCode || patch.error_code || null
          : existing.errorCode || null,
      errorMessage:
        Object.hasOwn(patch, 'errorMessage') || Object.hasOwn(patch, 'error_message')
          ? patch.errorMessage || patch.error_message || null
          : existing.errorMessage || null,
      updatedAt: now.toISOString(),
    };
    this.cacheSlackDelivery(updated);
    await upsertRow(this.pool, 'slack_events', slackDeliveryToRow(updated), { excludeUpdate: ['id', 'created_at'] });
    return updated;
  },

  async findSlackDelivery(teamId, eventId) {
    const rows = await execute(this.pool, 'SELECT * FROM slack_events WHERE team_id = ? AND event_id = ? LIMIT 1', [
      teamId || 'unknown-team',
      eventId || 'unknown-event',
    ]);
    return this.cacheSlackDelivery(rowToSlackDelivery(rows[0]));
  },

  async listSlackDeliveries(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const where = [];
    const params = [];
    for (const [optionName, column] of [
      ['teamId', 'team_id'],
      ['eventId', 'event_id'],
      ['slackSessionId', 'slack_session_id'],
      ['publishingJobId', 'publishing_job_id'],
      ['workItemKind', 'work_item_kind'],
      ['workItemId', 'work_item_id'],
      ['platformDevItemId', 'platform_dev_item_id'],
      ['processingStatus', 'processing_status'],
      ['channelId', 'channel_id'],
    ]) {
      if (options[optionName]) {
        where.push(`${column} = ?`);
        params.push(options[optionName]);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRows = await execute(this.pool, `SELECT COUNT(*) AS total FROM slack_events ${whereSql}`, params);
    const rows = await execute(
      this.pool,
      `SELECT * FROM slack_events ${whereSql} ORDER BY updated_at DESC ${limitOffsetSql(limit, offset)}`,
      params
    );
    return {
      deliveries: rows.map((row) => this.cacheSlackDelivery(rowToSlackDelivery(row))),
      total: Number(countRows[0]?.total || 0),
      limit,
      offset,
    };
  },
};
