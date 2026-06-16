import {
  buildPublishingJob,
  canTransition,
  idempotencyScopeForInput,
  idempotencyScopeForJob,
  transitionJob,
} from '@xd/workflow-core';

import { eventToRow, jobToRow, rowToEvent, rowToJob } from '../rows/publishing-job-row.js';
import { execute, limitOffsetSql, queryPlaceholders, upsertRow } from '../sql.js';

const REVIEW_ACTIVE_JOB_STATUSES = new Set(['pr_created', 'reviewing', 'changes_requested', 'fixing', 'previewing']);

function shaMatches(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = String(left).toLowerCase();
  const normalizedRight = String(right).toLowerCase();
  if (normalizedLeft.length < 7 || normalizedRight.length < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

export const publishingJobRepositoryMethods = {
  canTransition,
  transitionJob,

  async upsertJob(job) {
    await upsertRow(this.pool, 'publishing_jobs', jobToRow(job), { excludeUpdate: ['id', 'created_at'] });
  },

  async insertEvents(events = []) {
    for (const event of events) {
      await upsertRow(this.pool, 'job_events', eventToRow(event), { excludeUpdate: ['id', 'created_at'] });
    }
  },

  async getJobByIdempotency(input) {
    const rows = await execute(
      this.pool,
      [
        'SELECT * FROM publishing_jobs',
        'WHERE source = ? AND requested_by_type = ? AND requested_by_id = ? AND idempotency_key = ?',
        'LIMIT 1',
      ].join(' '),
      [
        input.source || 'api',
        input.requestedByType || input.requested_by_type || 'user',
        input.requestedById || input.requested_by_id,
        input.idempotencyKey || input.idempotency_key,
      ]
    );
    return this.cacheJob(rowToJob(rows[0]));
  },

  async createJob(input) {
    const existing = await this.getJobByIdempotency(input);
    if (existing) return { job: existing, created: false };

    const scope = idempotencyScopeForInput(input);
    if (this.idempotency.has(scope)) {
      return { job: this.jobs.get(this.idempotency.get(scope)), created: false };
    }

    const job = buildPublishingJob(input);
    this.jobs.set(job.id, job);
    this.idempotency.set(idempotencyScopeForJob(job), job.id);
    this.appendEvent(job, 'PublishingJob received');
    const events = this.events.get(job.id) || [];

    try {
      await this.upsertJob(job);
      await this.insertEvents(events);
    } catch (error) {
      if (String(error.code || '').includes('ER_DUP_ENTRY')) {
        const duplicate = await this.getJobByIdempotency(input);
        if (duplicate) return { job: duplicate, created: false };
      }
      throw error;
    }

    return { job, created: true };
  },

  async getJob(jobId) {
    const rows = await execute(this.pool, 'SELECT * FROM publishing_jobs WHERE id = ? LIMIT 1', [jobId]);
    return this.cacheJob(rowToJob(rows[0]));
  },

  async listJobs(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const where = [];
    const params = [];

    if (options.status) {
      where.push('status = ?');
      params.push(String(options.status));
    }
    if (options.source) {
      where.push('source = ?');
      params.push(String(options.source));
    }
    if (options.q) {
      const like = `%${String(options.q).trim().toLowerCase()}%`;
      where.push(
        [
          'LOWER(id) LIKE ?',
          'LOWER(title) LIKE ?',
          'LOWER(summary) LIKE ?',
          'LOWER(employee_slug) LIKE ?',
          'LOWER(site_slug) LIKE ?',
          'LOWER(requested_by_id) LIKE ?',
          'CAST(issue_number AS CHAR) LIKE ?',
          'CAST(pr_number AS CHAR) LIKE ?',
          'LOWER(preview_url) LIKE ?',
        ].join(' OR ')
      );
      params.push(like, like, like, like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.map((item) => `(${item})`).join(' AND ')}` : '';
    const countRows = await execute(this.pool, `SELECT COUNT(*) AS total FROM publishing_jobs ${whereSql}`, params);
    const rows = await execute(
      this.pool,
      `SELECT * FROM publishing_jobs ${whereSql} ORDER BY updated_at DESC ${limitOffsetSql(limit, offset)}`,
      params
    );

    const jobs = rows.map((row) => this.cacheJob(rowToJob(row)));
    return {
      jobs,
      total: Number(countRows[0]?.total || 0),
      limit,
      offset,
    };
  },

  async listEvents(jobId) {
    const rows = await execute(this.pool, 'SELECT * FROM job_events WHERE publishing_job_id = ? ORDER BY created_at ASC', [
      jobId,
    ]);
    const events = rows.map(rowToEvent);
    this.events.set(jobId, events);
    return events;
  },

  async updateJob(jobId, status, patch = {}) {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const beforeCount = this.events.get(jobId)?.length || 0;
    const updated = this.transitionWithBridge(job, status, patch);
    this.jobs.set(jobId, updated);
    this.appendEvent(updated, `PublishingJob moved to ${status}`);
    const events = this.events.get(jobId)?.slice(beforeCount) || [];
    await this.upsertJob(updated);
    await this.insertEvents(events);
    return updated;
  },

  async moveJobToFixing(jobId, patch = {}) {
    let job = await this.getJob(jobId);
    if (!job) return null;
    if (job.status === 'fixing') return this.patchJob(jobId, patch);
    if (job.status === 'pr_created') job = await this.updateJob(jobId, 'reviewing');
    if (!canTransition(job.status, 'fixing')) return null;
    return this.updateJob(jobId, 'fixing', patch);
  },

  async patchJob(jobId, patch = {}) {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const updated = {
      ...job,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, updated);
    await this.upsertJob(updated);
    return updated;
  },

  async failJob(jobId, errorCode, errorMessage) {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const beforeCount = this.events.get(jobId)?.length || 0;
    const updated = transitionJob(job, 'failed', { errorCode, errorMessage });
    this.jobs.set(jobId, updated);
    this.appendEvent(updated, errorMessage || errorCode || 'PublishingJob failed');
    const events = this.events.get(jobId)?.slice(beforeCount) || [];
    await this.upsertJob(updated);
    await this.insertEvents(events);
    return updated;
  },

  async cancelJob(jobId, errorCode = 'cancelled', errorMessage = 'PublishingJob cancelled') {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const beforeCount = this.events.get(jobId)?.length || 0;
    const updated = {
      ...job,
      status: 'cancelled',
      errorCode,
      errorMessage,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, updated);
    this.appendEvent(updated, errorMessage || errorCode || 'PublishingJob cancelled');
    const events = this.events.get(jobId)?.slice(beforeCount) || [];
    await this.upsertJob(updated);
    await this.insertEvents(events);
    return updated;
  },

  async findJobByPrNumber(prNumber, options = {}) {
    const rows = await execute(this.pool, 'SELECT * FROM publishing_jobs WHERE pr_number = ? ORDER BY updated_at DESC', [
      Number(prNumber),
    ]);
    const candidates = rows.map((row) => this.cacheJob(rowToJob(row)));
    if (!candidates.length) return null;

    if (options.headSha) {
      const matched = candidates.find((job) => shaMatches(job.headSha, options.headSha));
      if (matched) return matched;
    }

    return candidates.find((job) => REVIEW_ACTIVE_JOB_STATUSES.has(job.status)) || candidates[0];
  },

  async listWorkItemsForSlackUser(teamId, slackUserId, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
    const requestedById = `slack:${teamId || 'unknown-team'}:${slackUserId || 'unknown-user'}`;
    const where = ['source = ?', 'requested_by_id = ?'];
    const params = ['slack', requestedById];
    if (options.statuses?.length) {
      where.push(`status IN (${queryPlaceholders(options.statuses.length)})`);
      params.push(...options.statuses);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRows = await execute(this.pool, `SELECT COUNT(*) AS total FROM publishing_jobs ${whereSql}`, params);
    const rows = await execute(
      this.pool,
      `SELECT * FROM publishing_jobs ${whereSql} ORDER BY updated_at DESC ${limitOffsetSql(limit, 0)}`,
      params
    );
    return {
      jobs: rows.map((row) => this.cacheJob(rowToJob(row))),
      total: Number(countRows[0]?.total || 0),
      limit,
      offset: 0,
    };
  },
};
