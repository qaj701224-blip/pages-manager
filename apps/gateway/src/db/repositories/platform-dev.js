import {
  buildPlatformDevItem,
  canTransitionPlatformDevItem,
  idempotencyScopeForInput,
  makeId,
  transitionPlatformDevItem,
  transitionPlatformDevItemWithBridge,
} from '@xd/workflow-core';

import {
  platformDevEventToRow,
  platformDevItemToRow,
  rowToPlatformDevEvent,
  rowToPlatformDevItem,
} from '../rows/platform-dev-row.js';
import { rowToWorkItemLink, workItemLinkToRow } from '../rows/slack-row.js';
import { execute, fromDbJson, limitOffsetSql, queryPlaceholders, toDbJson, toIso, upsertRow, withTransaction } from '../sql.js';

const ACTIVE_PLATFORM_DEV_STATUSES = new Set([
  'received',
  'triaging',
  'issue_creating',
  'issue_created',
  'gate_pending',
  'agent_queued',
  'agent_running',
  'branch_committed',
  'pr_created',
  'ci_running',
  'ci_failed',
  'review_waiting',
  'review_blocked',
  'ready_to_merge',
  'failed',
]);

const TERMINAL_PLATFORM_DEV_STATUSES = new Set(['merged', 'closed_unmerged', 'failed', 'cancelled']);

function platformDevKeepsSlackSessionActive(item = {}) {
  return ACTIVE_PLATFORM_DEV_STATUSES.has(item.status);
}

function shaMatches(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = String(left).toLowerCase();
  const normalizedRight = String(right).toLowerCase();
  if (normalizedLeft.length < 7 || normalizedRight.length < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function slackRequestedById(teamId, slackUserId) {
  return `slack:${teamId || 'unknown-team'}:${slackUserId || 'unknown-user'}`;
}

function itemForSlackList(item) {
  return {
    ...item,
    workItemKind: 'platform_dev',
    issueNumber: item.githubIssueNumber,
    issueUrl: item.githubIssueUrl,
    prNumber: item.githubPrNumber,
    prUrl: item.githubPrUrl,
    siteSlug: 'pages-manager',
  };
}

function workItemGateToRow(gate) {
  return {
    id: gate.id,
    work_item_kind: gate.workItemKind,
    work_item_id: gate.workItemId,
    gate_type: gate.gateType,
    status: gate.status,
    reason: gate.reason,
    decided_by: gate.decidedBy,
    decided_at: gate.decidedAt ? new Date(gate.decidedAt) : null,
    metadata_json: toDbJson(gate.metadata),
    created_at: gate.createdAt ? new Date(gate.createdAt) : new Date(),
    updated_at: gate.updatedAt ? new Date(gate.updatedAt) : new Date(),
  };
}

function rowToWorkItemGate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workItemKind: row.work_item_kind,
    workItemId: row.work_item_id,
    gateType: row.gate_type,
    status: row.status,
    reason: row.reason || null,
    decidedBy: row.decided_by || null,
    decidedAt: toIso(row.decided_at),
    metadata: fromDbJson(row.metadata_json, null),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export const platformDevRepositoryMethods = {
  canTransitionPlatformDevItem,
  transitionPlatformDevItem,
  transitionPlatformDevItemWithBridge,

  async upsertPlatformDevItem(item) {
    await upsertRow(this.pool, 'platform_dev_items', platformDevItemToRow(item), { excludeUpdate: ['id', 'created_at'] });
  },

  async insertPlatformDevEvents(events = []) {
    for (const event of events) {
      await upsertRow(this.pool, 'platform_dev_events', platformDevEventToRow(event), {
        excludeUpdate: ['id', 'created_at'],
      });
    }
  },

  async getPlatformDevItemByIdempotency(input) {
    const rows = await execute(
      this.pool,
      [
        'SELECT * FROM platform_dev_items',
        'WHERE source = ? AND requested_by_type = ? AND requested_by_id = ? AND idempotency_key = ?',
        'LIMIT 1',
      ].join(' '),
      [
        input.source || 'slack',
        input.requestedByType || input.requested_by_type || 'user',
        input.requestedById || input.requested_by_id,
        input.idempotencyKey || input.idempotency_key,
      ]
    );
    return this.cachePlatformDevItem(rowToPlatformDevItem(rows[0]));
  },

  async createPlatformDevItem(input) {
    const existing = await this.getPlatformDevItemByIdempotency(input);
    if (existing) return { item: existing, created: false };

    const scope = idempotencyScopeForInput({ source: 'slack', ...input });
    if (this.platformDevIdempotency?.has(scope)) {
      return { item: this.platformDevItems.get(this.platformDevIdempotency.get(scope)), created: false };
    }

    const item = buildPlatformDevItem(input);
    this.appendPlatformDevEvent(item, 'PlatformDevItem received');
    const events = this.platformDevEvents.get(item.id) || [];

    try {
      await withTransaction(this.pool, async (connection) => {
        await upsertRow(connection, 'platform_dev_items', platformDevItemToRow(item), { excludeUpdate: ['id', 'created_at'] });
        for (const event of events) {
          await upsertRow(connection, 'platform_dev_events', platformDevEventToRow(event), {
            excludeUpdate: ['id', 'created_at'],
          });
        }
        if (item.requiresHumanGate) {
          const nowIso = new Date().toISOString();
          const gate = {
            id: makeId('gate'),
            workItemKind: 'platform_dev',
            workItemId: item.id,
            gateType: 'risk',
            status: 'pending',
            reason: item.gateReason || '高风险或敏感范围需要人工确认后再进入自动开发。',
            decidedBy: null,
            decidedAt: null,
            metadata: {
              risk: item.risk,
              issueType: item.issueType,
              areas: item.areas || [],
            },
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          await upsertRow(connection, 'work_item_gates', workItemGateToRow(gate), { excludeUpdate: ['id', 'created_at'] });
        }
      });
    } catch (error) {
      if (String(error.code || '').includes('ER_DUP_ENTRY')) {
        const duplicate = await this.getPlatformDevItemByIdempotency(input);
        if (duplicate) return { item: duplicate, created: false };
      }
      throw error;
    }

    this.cachePlatformDevItem(item);
    return { item, created: true };
  },

  async getPlatformDevItem(itemId) {
    const rows = await execute(this.pool, 'SELECT * FROM platform_dev_items WHERE id = ? LIMIT 1', [itemId]);
    return this.cachePlatformDevItem(rowToPlatformDevItem(rows[0]));
  },

  async listPlatformDevItems(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const where = [];
    const params = [];

    if (options.status) {
      where.push('status = ?');
      params.push(String(options.status));
    }
    if (options.statuses?.length) {
      where.push(`status IN (${queryPlaceholders(options.statuses.length)})`);
      params.push(...options.statuses);
    }
    if (options.source) {
      where.push('source = ?');
      params.push(String(options.source));
    }
    if (options.requestedById) {
      where.push('requested_by_id = ?');
      params.push(String(options.requestedById));
    }

    const whereSql = where.length ? `WHERE ${where.map((item) => `(${item})`).join(' AND ')}` : '';
    const countRows = await execute(this.pool, `SELECT COUNT(*) AS total FROM platform_dev_items ${whereSql}`, params);
    const rows = await execute(
      this.pool,
      `SELECT * FROM platform_dev_items ${whereSql} ORDER BY updated_at DESC ${limitOffsetSql(limit, offset)}`,
      params
    );

    return {
      items: rows.map((row) => this.cachePlatformDevItem(rowToPlatformDevItem(row))),
      total: Number(countRows[0]?.total || 0),
      limit,
      offset,
    };
  },

  async listPlatformDevEvents(itemId) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM platform_dev_events WHERE platform_dev_item_id = ? ORDER BY created_at ASC',
      [itemId]
    );
    const events = rows.map(rowToPlatformDevEvent);
    this.platformDevEvents.set(itemId, events);
    return events;
  },

  async updatePlatformDevItem(itemId, status, patch = {}) {
    const item = await this.getPlatformDevItem(itemId);
    if (!item) return null;
    const beforeCount = this.platformDevEvents.get(itemId)?.length || 0;
    const updated = transitionPlatformDevItemWithBridge(item, status, patch, new Date(), (bridgedItem, nextStatus) => {
      this.appendPlatformDevEvent(bridgedItem, `PlatformDevItem moved to ${nextStatus}`);
    });
    this.appendPlatformDevEvent(updated, `PlatformDevItem moved to ${status}`);
    const events = this.platformDevEvents.get(itemId)?.slice(beforeCount) || [];
    try {
      await this.upsertPlatformDevItem(updated);
      await this.insertPlatformDevEvents(events);
    } catch (error) {
      this.platformDevEvents.set(itemId, this.platformDevEvents.get(itemId)?.slice(0, beforeCount) || []);
      throw error;
    }
    this.cachePlatformDevItem(updated);
    return updated;
  },

  async patchPlatformDevItem(itemId, patch = {}) {
    const item = await this.getPlatformDevItem(itemId);
    if (!item) return null;
    const updated = {
      ...item,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.upsertPlatformDevItem(updated);
    this.cachePlatformDevItem(updated);
    return updated;
  },

  async failPlatformDevItem(itemId, errorCode, errorMessage, patch = {}) {
    const item = await this.getPlatformDevItem(itemId);
    if (!item) return null;
    const beforeCount = this.platformDevEvents.get(itemId)?.length || 0;
    const updated = transitionPlatformDevItem(item, 'failed', { ...patch, errorCode, errorMessage });
    this.appendPlatformDevEvent(updated, errorMessage || errorCode || 'PlatformDevItem failed');
    const events = this.platformDevEvents.get(itemId)?.slice(beforeCount) || [];
    try {
      await this.upsertPlatformDevItem(updated);
      await this.insertPlatformDevEvents(events);
    } catch (error) {
      this.platformDevEvents.set(itemId, this.platformDevEvents.get(itemId)?.slice(0, beforeCount) || []);
      throw error;
    }
    this.cachePlatformDevItem(updated);
    return updated;
  },

  async findPlatformDevItemByIssueNumber(issueNumber) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM platform_dev_items WHERE github_issue_number = ? ORDER BY updated_at DESC LIMIT 1',
      [Number(issueNumber)]
    );
    return this.cachePlatformDevItem(rowToPlatformDevItem(rows[0]));
  },

  async findPlatformDevItemByPrNumber(prNumber, options = {}) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM platform_dev_items WHERE github_pr_number = ? ORDER BY updated_at DESC',
      [Number(prNumber)]
    );
    const candidates = rows.map((row) => this.cachePlatformDevItem(rowToPlatformDevItem(row)));
    if (!candidates.length) return null;
    if (options.headSha) {
      const matched = candidates.find((item) => shaMatches(item.headSha, options.headSha));
      if (matched) return matched;
      return null;
    }
    return candidates.find((item) => !TERMINAL_PLATFORM_DEV_STATUSES.has(item.status)) || candidates[0];
  },

  async linkWorkItemToSlackSession(workItem, session, now = new Date()) {
    if (!workItem?.id) return null;
    const workItemKind = workItem.workItemKind || (workItem.githubIssueNumber !== undefined ? 'platform_dev' : 'site_publishing');
    const workItemId = workItem.id;
    const slackSessionId = session?.id || workItem.slackSessionId || null;
    if (!slackSessionId) return null;

    const existing = await this.findWorkItemLink(workItemKind, workItemId, 'primary');
    const nowIso = now.toISOString();
    const link = {
      id: existing?.id || makeId('wilink'),
      workItemKind,
      workItemId,
      slackSessionId,
      publishingJobId: workItemKind === 'site_publishing' ? workItem.id : null,
      platformDevItemId: workItemKind === 'platform_dev' ? workItem.id : null,
      issueNumber: workItem.issueNumber ?? workItem.githubIssueNumber ?? existing?.issueNumber ?? null,
      prNumber: workItem.prNumber ?? workItem.githubPrNumber ?? existing?.prNumber ?? null,
      branchName: workItem.branchName ?? existing?.branchName ?? null,
      previewUrl: workItem.previewUrl ?? existing?.previewUrl ?? null,
      headSha: workItem.headSha ?? existing?.headSha ?? null,
      relationship: existing?.relationship || 'primary',
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    await upsertRow(this.pool, 'work_item_links', workItemLinkToRow(link), { excludeUpdate: ['id', 'created_at'] });
    this.cacheWorkItemLink(link);

    const currentSession = session || (await this.getSlackSession(slackSessionId));
    if (currentSession && currentSession.status !== 'closed') {
      const active =
        workItemKind === 'platform_dev'
          ? platformDevKeepsSlackSessionActive(workItem)
          : this.jobs?.has(workItem.id) && workItem.status !== 'cancelled' && workItem.status !== 'failed';
      await this.upsertSlackSession(
        {
          ...currentSession,
          status: 'active',
          closedAt: null,
          activeJobId: workItemKind === 'site_publishing' && active ? workItem.id : null,
          activeWorkItemKind: active ? workItemKind : null,
          activeWorkItemId: active ? workItemId : null,
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

  async linkPlatformDevItemToSlackSession(item, session, now = new Date()) {
    return this.linkWorkItemToSlackSession({ ...item, workItemKind: 'platform_dev' }, session, now);
  },

  async ensureWorkItemGate(input = {}) {
    const workItemKind = input.workItemKind || input.work_item_kind;
    const workItemId = input.workItemId || input.work_item_id;
    const gateType = input.gateType || input.gate_type || 'risk';
    if (!workItemKind || !workItemId) return null;

    const existing = await this.getWorkItemGate(workItemKind, workItemId, gateType);
    const nowIso = new Date().toISOString();
    const gate = {
      ...(existing || {}),
      id: existing?.id || input.id || makeId('gate'),
      workItemKind,
      workItemId,
      gateType,
      status: input.status || existing?.status || 'pending',
      reason: input.reason ?? existing?.reason ?? null,
      decidedBy: input.decidedBy ?? existing?.decidedBy ?? null,
      decidedAt: input.decidedAt ?? existing?.decidedAt ?? null,
      metadata: input.metadata ?? input.metadataJson ?? existing?.metadata ?? null,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    await upsertRow(this.pool, 'work_item_gates', workItemGateToRow(gate), { excludeUpdate: ['id', 'created_at'] });
    return gate;
  },

  async getWorkItemGate(workItemKind, workItemId, gateType = 'risk') {
    const rows = await execute(
      this.pool,
      'SELECT * FROM work_item_gates WHERE work_item_kind = ? AND work_item_id = ? AND gate_type = ? LIMIT 1',
      [workItemKind, workItemId, gateType]
    );
    return rowToWorkItemGate(rows[0]);
  },

  async decideWorkItemGate(workItemKind, workItemId, gateType = 'risk', decision = {}) {
    const existing =
      (await this.getWorkItemGate(workItemKind, workItemId, gateType)) ||
      (await this.ensureWorkItemGate({
        workItemKind,
        workItemId,
        gateType,
        reason: decision.reason || null,
      }));
    const nowIso = new Date().toISOString();
    const gate = {
      ...existing,
      status: decision.status,
      reason: decision.reason ?? existing?.reason ?? null,
      decidedBy: decision.decidedBy || null,
      decidedAt: nowIso,
      metadata: decision.metadata ?? existing?.metadata ?? null,
      updatedAt: nowIso,
    };
    await upsertRow(this.pool, 'work_item_gates', workItemGateToRow(gate), { excludeUpdate: ['id', 'created_at'] });
    return gate;
  },

  async findWorkItemLink(workItemKind, workItemId, relationship = 'primary') {
    const rows = await execute(
      this.pool,
      'SELECT * FROM work_item_links WHERE work_item_kind = ? AND work_item_id = ? AND relationship = ? LIMIT 1',
      [workItemKind, workItemId, relationship]
    );
    return this.cacheWorkItemLink(rowToWorkItemLink(rows[0]));
  },

  async findWorkItemLinkByIssueNumber(issueNumber) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM work_item_links WHERE issue_number = ? ORDER BY updated_at DESC LIMIT 1',
      [Number(issueNumber)]
    );
    return this.cacheWorkItemLink(rowToWorkItemLink(rows[0]));
  },

  async findWorkItemLinkByPrNumber(prNumber) {
    const rows = await execute(this.pool, 'SELECT * FROM work_item_links WHERE pr_number = ? ORDER BY updated_at DESC LIMIT 1', [
      Number(prNumber),
    ]);
    return this.cacheWorkItemLink(rowToWorkItemLink(rows[0]));
  },

  async listWorkItemLinksForSlackSession(slackSessionId) {
    const rows = await execute(this.pool, 'SELECT * FROM work_item_links WHERE slack_session_id = ? ORDER BY updated_at DESC', [
      slackSessionId,
    ]);
    return rows.map((row) => this.cacheWorkItemLink(rowToWorkItemLink(row)));
  },

  async listWorkItemsForSlackUser(teamId, slackUserId, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
    const requestedById = slackRequestedById(teamId, slackUserId);
    const statuses = options.statuses || null;
    const [siteResult, platformResult] = await Promise.all([
      this.listJobs({ source: 'slack', requestedById, statuses, limit: 50 }),
      this.listPlatformDevItems({
        source: 'slack',
        requestedById,
        statuses,
        limit: 50,
      }),
    ]);

    const siteItems = (siteResult.jobs || []).map((job) => ({ ...job, workItemKind: 'site_publishing' }));
    const platformItems = (platformResult.items || []).map(itemForSlackList);
    const items = [...siteItems, ...platformItems].sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return rightTime - leftTime;
    });

    return {
      jobs: items.slice(0, limit),
      total: items.length,
      limit,
      offset: 0,
    };
  },
};
