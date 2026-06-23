import { makeId } from '@xd/workflow-core';

import {
  rowToSlackAgentReplyMessage,
  rowToSlackJobStatusMessage,
  rowToSlackWorkItemStatusMessage,
  slackAgentReplyMessageToRow,
  slackJobStatusMessageToRow,
  slackWorkItemStatusMessageToRow,
  slackStatusScopeKey,
  workItemStatusScopeKey,
} from '../rows/slack-row.js';
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

  async hasSlackWorkItemNotification(workItemKind, workItemId, key) {
    const rows = await execute(
      this.pool,
      'SELECT id FROM slack_notification_dedupes WHERE work_item_kind = ? AND work_item_id = ? AND dedupe_key = ? LIMIT 1',
      [workItemKind, workItemId, key]
    );
    return rows.length > 0;
  },

  async recordSlackWorkItemNotification(workItemKind, workItemId, key) {
    this.slackNotifications.add(`${workItemKind}:${workItemId}:${key}`);
    await upsertRow(
      this.pool,
      'slack_notification_dedupes',
      {
        id: makeId('slackdedupe'),
        job_id: null,
        work_item_kind: workItemKind,
        work_item_id: workItemId,
        dedupe_key: key,
        created_at: new Date(),
      },
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

  async getSlackWorkItemStatusMessage(workItemKind, workItemId, options = {}) {
    const scopeKey = workItemStatusScopeKey(options);
    const rows = await execute(
      this.pool,
      [
        'SELECT * FROM slack_work_item_status_messages',
        'WHERE work_item_kind = ? AND work_item_id = ? AND scope_key = ?',
        'LIMIT 1',
      ].join(' '),
      [workItemKind, workItemId, scopeKey]
    );
    return this.cacheSlackWorkItemStatusMessage(rowToSlackWorkItemStatusMessage(rows[0]));
  },

  async recordSlackWorkItemStatusMessage(workItemKind, workItemId, input = {}, now = new Date()) {
    const scopeKey = workItemStatusScopeKey(input);
    const existing = await this.getSlackWorkItemStatusMessage(workItemKind, workItemId, { scopeKey });
    const nowIso = now.toISOString();
    const message = {
      ...(existing || {}),
      id: existing?.id || input.id || makeId('slackmsg'),
      workItemKind,
      workItemId,
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
    this.cacheSlackWorkItemStatusMessage(message);
    await upsertRow(this.pool, 'slack_work_item_status_messages', slackWorkItemStatusMessageToRow(message), {
      excludeUpdate: ['id', 'created_at'],
    });
    return message;
  },

  async getSlackAgentReplyMessage(agentRunId) {
    const rows = await execute(this.pool, 'SELECT * FROM slack_agent_reply_messages WHERE agent_run_id = ? LIMIT 1', [
      agentRunId,
    ]);
    return this.cacheSlackAgentReplyMessage(rowToSlackAgentReplyMessage(rows[0]));
  },

  async getLatestSlackAgentReplyMessageForSession(slackSessionId) {
    if (!slackSessionId) return null;
    const rows = await execute(
      this.pool,
      'SELECT * FROM slack_agent_reply_messages WHERE slack_session_id = ? ORDER BY updated_at DESC LIMIT 1',
      [slackSessionId]
    );
    return this.cacheSlackAgentReplyMessage(rowToSlackAgentReplyMessage(rows[0]));
  },

  async recordSlackAgentReplyMessage(agentRunId, input = {}, now = new Date()) {
    const existing = await this.getSlackAgentReplyMessage(agentRunId);
    const nowIso = now.toISOString();
    const message = {
      ...(existing || {}),
      id: existing?.id || input.id || makeId('slackreply'),
      slackSessionId: input.slackSessionId ?? existing?.slackSessionId,
      agentRunId,
      channel: input.channel ?? existing?.channel ?? null,
      threadTs: input.threadTs ?? existing?.threadTs ?? null,
      messageTs: input.messageTs ?? input.ts ?? existing?.messageTs ?? null,
      textSnapshot: input.textSnapshot ?? input.text ?? existing?.textSnapshot ?? '',
      lastSequence: input.lastSequence ?? input.sequence ?? existing?.lastSequence ?? 0,
      status: input.status ?? existing?.status ?? 'running',
      updatedAt: nowIso,
      createdAt: existing?.createdAt || nowIso,
    };
    this.cacheSlackAgentReplyMessage(message);
    await upsertRow(this.pool, 'slack_agent_reply_messages', slackAgentReplyMessageToRow(message), {
      excludeUpdate: ['id', 'created_at'],
    });
    return message;
  },
};
