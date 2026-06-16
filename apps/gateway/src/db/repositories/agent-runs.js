import { makeId } from '@xd/workflow-core';

import { agentRunEventToRow, agentRunToRow, rowToAgentRun, rowToAgentRunEvent } from '../rows/agent-run-row.js';
import { execute, insertRowIfNotDuplicate, upsertRow } from '../sql.js';

function slackAgentLeaseKey(slackSessionId) {
  return `pages-manager:slack-agent:lease:${slackSessionId}`;
}

function slackAgentLeaseMs(config = {}) {
  return Math.max(Number(config.slackAgentSessionLeaseMs) || 180_000, 1_000);
}

async function releaseSlackAgentLease(store, run) {
  if (!store.redis || run?.agentKind !== 'slack_agent' || !run.slackSessionId || !run.id) return;

  const key = slackAgentLeaseKey(run.slackSessionId);
  try {
    const current = await store.redis.get(key);
    if (current === run.id) {
      await store.redis.del(key);
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_agent_lease_release_failed',
        slackSessionId: run.slackSessionId,
        agentRunId: run.id,
        error: error.message,
      })
    );
  }
}

async function clearSlackAgentLeaseForSession(store, slackSessionId, expectedRunId = null) {
  if (!store.redis || !slackSessionId) return false;

  const key = slackAgentLeaseKey(slackSessionId);
  try {
    if (expectedRunId) {
      const current = await store.redis.get(key);
      if (current !== expectedRunId) return false;
    }
    await store.redis.del(key);
    return true;
  } catch (error) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_agent_lease_clear_failed',
        slackSessionId,
        error: error.message,
      })
    );
    return false;
  }
}

async function runningSlackAgentRun(store, slackSessionId, now) {
  const runs = await store.listAgentRunsForSlackSession(slackSessionId);
  for (const run of runs) store.cacheAgentRun(run);

  const nowMs = now.getTime();
  for (const run of runs) {
    if (run.agentKind !== 'slack_agent' || run.slackSessionId !== slackSessionId || run.status !== 'running') {
      continue;
    }
    if (run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() > nowMs) {
      return run;
    }
    await store.failAgentRun(run.id, 'agent_lease_expired', 'Slack Agent lease expired', now);
  }

  return null;
}

export const agentRunRepositoryMethods = {
  async recordAgentRunEvent(input = {}, now = new Date()) {
    const dedupeKey = input.dedupeKey || input.dedupe_key || null;
    const nowIso = now.toISOString();
    const event = {
      id: input.id || makeId('agentevent'),
      publishingJobId: input.publishingJobId || input.publishing_job_id || null,
      slackSessionId: input.slackSessionId || input.slack_session_id || null,
      agentRunId: input.agentRunId || input.agent_run_id || null,
      type: input.type || 'job_progress',
      stage: input.stage || null,
      text: input.text || '',
      status: input.status || 'recorded',
      dedupeKey,
      slackChannelId: input.slackChannelId || input.slack_channel_id || null,
      slackThreadTs: input.slackThreadTs || input.slack_thread_ts || null,
      slackMessageTs: input.slackMessageTs || input.slack_message_ts || null,
      createdAt: nowIso,
    };
    const created = await insertRowIfNotDuplicate(this.pool, 'agent_run_events', agentRunEventToRow(event));
    if (created) return { event: this.cacheAgentRunEvent(event), created: true };

    const rows = dedupeKey
      ? await execute(this.pool, 'SELECT * FROM agent_run_events WHERE dedupe_key = ? LIMIT 1', [dedupeKey])
      : await execute(this.pool, 'SELECT * FROM agent_run_events WHERE id = ? LIMIT 1', [event.id]);
    const existing = rowToAgentRunEvent(rows[0]);
    if (existing) return { event: this.cacheAgentRunEvent(existing), created: false };
    return { event: this.cacheAgentRunEvent(event), created: false };
  },

  async listAgentRunEventsForJob(publishingJobId) {
    const rows = await execute(this.pool, 'SELECT * FROM agent_run_events WHERE publishing_job_id = ? ORDER BY created_at ASC', [
      publishingJobId,
    ]);
    return rows.map((row) => this.cacheAgentRunEvent(rowToAgentRunEvent(row)));
  },

  async listAgentRunsForJob(publishingJobId) {
    const rows = await execute(this.pool, 'SELECT * FROM agent_runs WHERE publishing_job_id = ? ORDER BY created_at ASC', [
      publishingJobId,
    ]);
    return rows.map((row) => this.cacheAgentRun(rowToAgentRun(row)));
  },

  async listAgentRunsForSlackSession(slackSessionId) {
    const rows = await execute(this.pool, 'SELECT * FROM agent_runs WHERE slack_session_id = ? ORDER BY created_at ASC', [
      slackSessionId,
    ]);
    return rows.map((row) => this.cacheAgentRun(rowToAgentRun(row)));
  },

  async createAgentRun(input, now = new Date()) {
    const nowIso = now.toISOString();
    const agentKind = input.agentKind || 'slack_agent';
    const relatedRuns = input.slackSessionId ? await this.listAgentRunsForSlackSession(input.slackSessionId) : [];
    for (const run of relatedRuns) this.cacheAgentRun(run);
    const run = {
      id: input.id || makeId('agent'),
      agentKind,
      slackSessionId: input.slackSessionId || null,
      publishingJobId: input.publishingJobId || null,
      status: input.status || 'running',
      roundNo: input.roundNo || relatedRuns.filter((item) => item.agentKind === agentKind).length + 1,
      provider: input.provider || 'deterministic',
      model: input.model || null,
      modelApiStyle: input.modelApiStyle || null,
      promptVersion: input.promptVersion || null,
      policyVersion: input.policyVersion || null,
      inputSummaryHash: input.inputSummaryHash || null,
      outputHash: input.outputHash || null,
      report: input.report || {},
      errorCode: null,
      errorMessage: null,
      leaseExpiresAt: input.leaseExpiresAt || null,
      timeoutAt: input.timeoutAt || null,
      startedAt: input.startedAt || nowIso,
      completedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.cacheAgentRun(run);
    await upsertRow(this.pool, 'agent_runs', agentRunToRow(run), { excludeUpdate: ['id', 'created_at'] });
    return run;
  },

  async completeAgentRun(agentRunId, patch = {}, now = new Date()) {
    const existing = await this.getAgentRun(agentRunId);
    if (!existing) return null;
    if (existing.status !== 'running') return existing;
    const updated = {
      ...existing,
      ...patch,
      status: 'completed',
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.cacheAgentRun(updated);
    await upsertRow(this.pool, 'agent_runs', agentRunToRow(updated), { excludeUpdate: ['id', 'created_at'] });
    await releaseSlackAgentLease(this, existing);
    return updated;
  },

  async failAgentRun(agentRunId, errorCode, errorMessage, now = new Date()) {
    const existing = await this.getAgentRun(agentRunId);
    if (!existing) return null;
    if (existing.status !== 'running') return existing;
    const updated = {
      ...existing,
      status: 'failed',
      errorCode: errorCode || 'agent_failed',
      errorMessage: errorMessage || errorCode || 'Agent run failed',
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.cacheAgentRun(updated);
    await upsertRow(this.pool, 'agent_runs', agentRunToRow(updated), { excludeUpdate: ['id', 'created_at'] });
    await releaseSlackAgentLease(this, existing);
    return updated;
  },

  async clearSlackAgentLeaseForSession(slackSessionId) {
    return await clearSlackAgentLeaseForSession(this, slackSessionId);
  },

  async getAgentRun(agentRunId) {
    const rows = await execute(this.pool, 'SELECT * FROM agent_runs WHERE id = ? LIMIT 1', [agentRunId]);
    return this.cacheAgentRun(rowToAgentRun(rows[0]));
  },

  async acquireSlackAgentLease(slackSessionId, config, now = new Date()) {
    const running = await runningSlackAgentRun(this, slackSessionId, now);
    if (running) {
      return { acquired: false, agentRun: running };
    }

    const nowMs = now.getTime();
    const leaseMs = slackAgentLeaseMs(config);
    const agentRunId = makeId('agent');

    if (this.redis) {
      const key = slackAgentLeaseKey(slackSessionId);
      const acquired = await this.redis.set(key, agentRunId, 'PX', leaseMs, 'NX');
      if (acquired !== 'OK') {
        const currentRunId = await this.redis.get(key);
        const agentRun = currentRunId
          ? await this.getAgentRun(currentRunId)
          : await runningSlackAgentRun(this, slackSessionId, now);
        if (currentRunId && (!agentRun || agentRun.status !== 'running')) {
          const cleared = await clearSlackAgentLeaseForSession(this, slackSessionId, currentRunId);
          if (cleared) return await this.acquireSlackAgentLease(slackSessionId, config, now);
        }
        return {
          acquired: false,
          agentRun:
            agentRun || {
              id: currentRunId || key,
              agentKind: 'slack_agent',
              slackSessionId,
              status: 'running',
            },
        };
      }

      try {
        const agentRun = await this.createAgentRun(
          {
            id: agentRunId,
            agentKind: 'slack_agent',
            slackSessionId,
            leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
            timeoutAt: new Date(nowMs + config.slackAgentTurnTimeoutMs).toISOString(),
          },
          now
        );
        return { acquired: true, agentRun };
      } catch (error) {
        await this.redis.del(key).catch(() => {});
        throw error;
      }
    }

    const agentRun = await this.createAgentRun(
      {
        id: agentRunId,
        agentKind: 'slack_agent',
        slackSessionId,
        leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
        timeoutAt: new Date(nowMs + config.slackAgentTurnTimeoutMs).toISOString(),
      },
      now
    );
    return { acquired: true, agentRun };
  },
};
