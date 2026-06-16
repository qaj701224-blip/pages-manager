import { makeId } from '@xd/workflow-core';

import { rowToSlackJobStatusMessage, slackJobStatusMessageToRow, slackStatusScopeKey } from '../rows/slack-row.js';
import { execute, upsertRow } from '../sql.js';

export const slackNotificationRepositoryMethods = {
  async hasSlackNotification(jobId, key) {
    const rows = await execute(
      this.pool,
      'SELECT id FROM slack_notification_dedupes WHERE job_id = ? AND dedupe_key = ? LIMIT 1',
      [jobId, key]
    );
    return rows.length > 0;
  },

  async recordSlackNotification(jobId, key) {
    this.slackNotifications.add(`${jobId}:${key}`);
    await upsertRow(
      this.pool,
      'slack_notification_dedupes',
      { id: makeId('slackdedupe'), job_id: jobId, dedupe_key: key, created_at: new Date() },
      { excludeUpdate: ['id', 'created_at'] }
    );
  },

  async getSlackJobStatusMessage(jobId, options = {}) {
    const scopeKey = slackStatusScopeKey(options);
    const rows = await execute(this.pool, 'SELECT * FROM slack_job_status_messages WHERE job_id = ? AND scope_key = ? LIMIT 1', [
      jobId,
      scopeKey,
    ]);
    return this.cacheSlackJobStatusMessage(rowToSlackJobStatusMessage(rows[0]));
  },

  async recordSlackJobStatusMessage(jobId, input = {}, now = new Date()) {
    const scopeKey = slackStatusScopeKey(input);
    const existing = await this.getSlackJobStatusMessage(jobId, { scopeKey });
    const nowIso = now.toISOString();
    const message = {
      ...(existing || {}),
      id: existing?.id || input.id || makeId('slackmsg'),
      jobId,
      slackSessionId: input.slackSessionId ?? existing?.slackSessionId ?? null,
      scopeKey,
      channel: input.channel ?? existing?.channel ?? null,
      threadTs: input.threadTs ?? existing?.threadTs ?? null,
      messageTs: input.messageTs ?? input.ts ?? existing?.messageTs ?? null,
      stage: input.stage ?? existing?.stage ?? null,
      status: input.status ?? existing?.status ?? null,
      updatedAt: nowIso,
      createdAt: existing?.createdAt || nowIso,
    };
    this.cacheSlackJobStatusMessage(message);
    await upsertRow(this.pool, 'slack_job_status_messages', slackJobStatusMessageToRow(message), {
      excludeUpdate: ['id', 'created_at'],
    });
    return message;
  },
};
