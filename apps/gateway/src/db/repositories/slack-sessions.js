import { makeId } from '@xd/workflow-core';

import { issueLinkToRow, memoryToRow, rowToIssueLink, rowToMemory, rowToSession, sessionToRow } from '../rows/slack-row.js';
import { execute, upsertRow } from '../sql.js';

const SLACK_ACTIVE_JOB_STATUSES = new Set([
  'received',
  'summarizing',
  'issue_creating',
  'issue_created',
  'indexing',
  'generating_page',
  'patch_generated',
  'branch_committed',
  'pr_created',
  'reviewing',
  'changes_requested',
  'fixing',
  'previewing',
  'preview_deployed',
]);

function hasOwn(input, key) {
  return Object.hasOwn(input, key);
}

function fieldOrExisting(input, existing, key) {
  return hasOwn(input, key) ? input[key] : (existing?.[key] ?? null);
}

function jobKeepsSlackSessionActive(job = {}) {
  return SLACK_ACTIVE_JOB_STATUSES.has(job.status);
}

function createDefaultSessionMemory(sessionId, now = new Date()) {
  const nowIso = now.toISOString();
  return {
    id: makeId('mem'),
    slackSessionId: sessionId,
    summary: '',
    requirements: {},
    pendingQuestions: [],
    preferences: {},
    repoQuestionContext: {},
    lastPreviewFeedback: null,
    lastAgentResponse: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export const slackSessionRepositoryMethods = {
  async findSlackSessionByScope(teamId, slackUserId, sessionKey) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM slack_sessions WHERE team_id = ? AND primary_slack_user_id = ? AND session_key = ? LIMIT 1',
      [teamId, slackUserId, sessionKey]
    );
    return this.cacheSession(rowToSession(rows[0]));
  },

  async upsertSlackSession(input, now = new Date()) {
    let existing = null;
    if (input.id) existing = await this.getSlackSession(input.id);
    if (!existing) existing = await this.findSlackSessionByScope(input.teamId, input.primarySlackUserId, input.sessionKey);
    const nowIso = now.toISOString();
    const session = {
      id: existing?.id || input.id || makeId('sess'),
      teamId: input.teamId,
      sessionKey: input.sessionKey,
      sessionTitle: input.sessionTitle || existing?.sessionTitle || 'Slack conversation',
      channelId: input.channelId ?? existing?.channelId ?? null,
      threadTs: input.threadTs ?? existing?.threadTs ?? null,
      dmChannelId: input.dmChannelId ?? existing?.dmChannelId ?? null,
      surfaceContext: input.surfaceContext || existing?.surfaceContext || {},
      primarySlackUserId: input.primarySlackUserId,
      ownerScopeId: fieldOrExisting(input, existing, 'ownerScopeId'),
      activeJobId: fieldOrExisting(input, existing, 'activeJobId'),
      activeWorkItemKind: fieldOrExisting(input, existing, 'activeWorkItemKind'),
      activeWorkItemId: fieldOrExisting(input, existing, 'activeWorkItemId'),
      activeIssueNumber: fieldOrExisting(input, existing, 'activeIssueNumber'),
      activePrNumber: fieldOrExisting(input, existing, 'activePrNumber'),
      activePreviewUrl: fieldOrExisting(input, existing, 'activePreviewUrl'),
      activeContextExpiresAt: fieldOrExisting(input, existing, 'activeContextExpiresAt'),
      status: input.status || existing?.status || 'active',
      lastIntent: input.lastIntent || existing?.lastIntent || null,
      lastActiveAt: input.lastActiveAt || nowIso,
      closedAt: Object.hasOwn(input, 'closedAt') ? input.closedAt : (existing?.closedAt ?? null),
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    await upsertRow(this.pool, 'slack_sessions', sessionToRow(session), { excludeUpdate: ['id', 'created_at'] });
    const canonical = (await this.findSlackSessionByScope(input.teamId, input.primarySlackUserId, input.sessionKey)) || session;
    this.cacheSession(canonical);
    await this.getSessionMemory(canonical.id);
    return canonical;
  },

  async getSlackSession(sessionId) {
    const rows = await execute(this.pool, 'SELECT * FROM slack_sessions WHERE id = ? LIMIT 1', [sessionId]);
    return this.cacheSession(rowToSession(rows[0]));
  },

  async findSlackSessionsForUser(teamId, slackUserId, options = {}) {
    const rows = await execute(
      this.pool,
      [
        'SELECT * FROM slack_sessions',
        'WHERE team_id = ? AND primary_slack_user_id = ?',
        'ORDER BY last_active_at DESC, updated_at DESC',
      ].join(' '),
      [teamId, slackUserId]
    );
    return rows
      .map((row) => this.cacheSession(rowToSession(row)))
      .filter((session) => !options.statuses || options.statuses.includes(session.status));
  },

  async getSessionMemory(sessionId) {
    const rows = await execute(this.pool, 'SELECT * FROM session_memories WHERE slack_session_id = ? LIMIT 1', [sessionId]);
    const existing = rowToMemory(rows[0]);
    if (existing) return this.cacheMemory(existing);

    const memory = createDefaultSessionMemory(sessionId);
    this.cacheMemory(memory);
    await upsertRow(this.pool, 'session_memories', memoryToRow(memory), { excludeUpdate: ['id', 'created_at'] });
    return memory;
  },

  async updateSessionMemory(sessionId, patch = {}, now = new Date()) {
    const existing = await this.getSessionMemory(sessionId);
    const memory = {
      ...existing,
      ...patch,
      slackSessionId: sessionId,
      updatedAt: now.toISOString(),
    };
    this.cacheMemory(memory);
    await upsertRow(this.pool, 'session_memories', memoryToRow(memory), { excludeUpdate: ['id', 'created_at'] });
    return memory;
  },

  async closeSlackSession(sessionId, now = new Date()) {
    const existing = await this.getSlackSession(sessionId);
    if (!existing) return null;
    const closedAt = now.toISOString();
    const session = {
      ...existing,
      status: 'closed',
      activeJobId: null,
      activeWorkItemKind: null,
      activeWorkItemId: null,
      activeIssueNumber: null,
      activePrNumber: null,
      activePreviewUrl: null,
      activeContextExpiresAt: null,
      closedAt,
      lastActiveAt: closedAt,
      updatedAt: closedAt,
    };
    this.cacheSession(session);
    await upsertRow(this.pool, 'slack_sessions', sessionToRow(session), { excludeUpdate: ['id', 'created_at'] });
    return session;
  },

  async linkJobToSlackSession(job, session, now = new Date()) {
    if (!job?.id) return null;
    const existingByJob = await this.findIssueLinkByJobId(job.id);
    const slackSessionId = session?.id || job.slackSessionId || existingByJob?.slackSessionId;
    if (!slackSessionId) return null;
    const existing = await this.findIssueLinkForSlackSessionAndJob(slackSessionId, job.id);

    const nowIso = now.toISOString();
    const link = {
      id: existing?.id || makeId('issuelink'),
      slackSessionId,
      publishingJobId: job.id,
      issueNumber: job.issueNumber ?? existing?.issueNumber ?? null,
      prNumber: job.prNumber ?? existing?.prNumber ?? null,
      branchName: job.branchName ?? existing?.branchName ?? null,
      previewUrl: job.previewUrl ?? existing?.previewUrl ?? null,
      headSha: job.headSha ?? existing?.headSha ?? null,
      relationship: existing?.relationship || 'primary',
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    this.cacheIssueLink(link);
    await upsertRow(this.pool, 'issue_links', issueLinkToRow(link), { excludeUpdate: ['id', 'created_at'] });

    const currentSession = session || (await this.getSlackSession(slackSessionId));
    if (currentSession) {
      const active = jobKeepsSlackSessionActive(job);
      await this.upsertSlackSession(
        {
          ...currentSession,
          status: 'active',
          closedAt: null,
          activeJobId: active ? job.id : null,
          activeWorkItemKind: active ? 'site_publishing' : null,
          activeWorkItemId: active ? job.id : null,
          activeIssueNumber: active ? link.issueNumber : null,
          activePrNumber: active ? link.prNumber : null,
          activePreviewUrl: active ? link.previewUrl : null,
          activeContextExpiresAt: active ? currentSession.activeContextExpiresAt : null,
        },
        now
      );
    }

    return link;
  },

  async findIssueLinkForSlackSessionAndJob(slackSessionId, jobId) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM issue_links WHERE slack_session_id = ? AND publishing_job_id = ? LIMIT 1',
      [slackSessionId, jobId]
    );
    return this.cacheIssueLink(rowToIssueLink(rows[0]));
  },

  async findIssueLinkByJobId(jobId) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM issue_links WHERE publishing_job_id = ? ORDER BY updated_at DESC LIMIT 1',
      [jobId]
    );
    return this.cacheIssueLink(rowToIssueLink(rows[0]));
  },

  async findIssueLinkByIssueNumber(issueNumber) {
    const rows = await execute(this.pool, 'SELECT * FROM issue_links WHERE issue_number = ? ORDER BY updated_at DESC LIMIT 1', [
      Number(issueNumber),
    ]);
    return this.cacheIssueLink(rowToIssueLink(rows[0]));
  },

  async findIssueLinkByPrNumber(prNumber) {
    const rows = await execute(this.pool, 'SELECT * FROM issue_links WHERE pr_number = ? ORDER BY updated_at DESC LIMIT 1', [
      Number(prNumber),
    ]);
    return this.cacheIssueLink(rowToIssueLink(rows[0]));
  },

  async findIssueLinksForSlackSession(slackSessionId) {
    const rows = await execute(this.pool, 'SELECT * FROM issue_links WHERE slack_session_id = ? ORDER BY updated_at DESC', [
      slackSessionId,
    ]);
    return rows.map((row) => this.cacheIssueLink(rowToIssueLink(row)));
  },
};
