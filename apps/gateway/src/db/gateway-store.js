import { eventForStatus, idempotencyScopeForJob } from '@xd/workflow-core';

import { createMysqlPool } from './client.js';
import { bindMysqlRepositoryMethods } from './repositories/index.js';
import { createRedisClient } from './redis.js';
import { execute } from './sql.js';

const CALLBACK_BRIDGES = {
  issue_created: {
    received: ['issue_creating', 'issue_created'],
  },
  generating_page: {
    issue_created: ['indexing', 'generating_page'],
  },
  pr_created: {
    issue_created: ['generating_page', 'pr_created'],
  },
  preview_deployed: {
    pr_created: ['previewing', 'preview_deployed'],
    reviewing: ['previewing', 'preview_deployed'],
  },
};

export class MySqlGatewayStore {
  constructor(pool, options = {}) {
    this.backend = 'mysql';
    this.pool = pool;
    this.redis = options.redis || null;

    this.jobs = new Map();
    this.idempotency = new Map();
    this.events = new Map();
    this.githubDeliveries = new Map();
    this.slackDeliveries = new Map();
    this.reviewAgentComments = new Map();
    this.siteCheckRuns = new Map();
    this.slackNotifications = new Set();
    this.slackJobStatusMessages = new Map();
    this.slackAgentReplyMessages = new Map();
    this.agentRunEvents = new Map();
    this.agentRunEventByDedupeKey = new Map();
    this.slackSessions = new Map();
    this.slackSessionByScopeKey = new Map();
    this.sessionMemories = new Map();
    this.issueLinks = new Map();
    this.issueLinkByIssueNumber = new Map();
    this.issueLinkByPrNumber = new Map();
    this.agentRuns = new Map();

    bindMysqlRepositoryMethods(this);
  }

  static async create(env = process.env) {
    const redis = env.REDIS_URL ? createRedisClient(env) : null;
    return new MySqlGatewayStore(createMysqlPool(env), { redis });
  }

  async health() {
    await execute(this.pool, 'SELECT 1');
    if (this.redis) {
      await this.redis.ping();
    }
    return { ok: true, backend: this.backend };
  }

  async flush() {}

  async close() {
    if (this.redis) {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
    await this.pool.end();
  }

  transitionWithBridge(job, status, patch) {
    if (this.canTransition(job.status, status)) {
      return this.transitionJob(job, status, patch);
    }

    const bridge = CALLBACK_BRIDGES[status]?.[job.status];
    if (!bridge) return this.transitionJob(job, status, patch);

    let current = job;
    for (const nextStatus of bridge) {
      current = this.transitionJob(current, nextStatus, nextStatus === status ? patch : {});
      if (nextStatus !== status) {
        this.appendEvent(current, `PublishingJob moved to ${nextStatus}`);
      }
    }
    return current;
  }

  appendEvent(job, message) {
    const events = this.events.get(job.id) || [];
    events.push(eventForStatus(job, message));
    this.events.set(job.id, events);
  }

  slackDeliveryKey(teamId, eventId) {
    return `${teamId || 'unknown-team'}:${eventId || 'unknown-event'}`;
  }

  slackSessionScopeKey(input) {
    return [input.teamId, input.primarySlackUserId, input.sessionKey].join(':');
  }

  cacheJob(job) {
    if (!job) return null;
    this.jobs.set(job.id, job);
    this.idempotency.set(idempotencyScopeForJob(job), job.id);
    return job;
  }

  cacheGithubDelivery(delivery) {
    if (delivery) this.githubDeliveries.set(`${delivery.repoFullName}:${delivery.deliveryId}`, delivery);
    return delivery;
  }

  cacheSlackDelivery(delivery) {
    if (delivery) this.slackDeliveries.set(this.slackDeliveryKey(delivery.teamId, delivery.eventId), delivery);
    return delivery;
  }

  cacheReviewComment(comment) {
    if (comment) this.reviewAgentComments.set(`${comment.repoFullName}:${comment.githubCommentNodeId}`, comment);
    return comment;
  }

  cacheSiteCheckRun(run) {
    if (run) this.siteCheckRuns.set(`${run.repoFullName}:${run.checkRunNodeId || run.checkRunId}`, run);
    return run;
  }

  cacheSession(session) {
    if (!session) return null;
    this.slackSessions.set(session.id, session);
    this.slackSessionByScopeKey.set(this.slackSessionScopeKey(session), session.id);
    return session;
  }

  cacheMemory(memory) {
    if (memory) this.sessionMemories.set(memory.slackSessionId, memory);
    return memory;
  }

  cacheIssueLink(link) {
    if (!link) return null;
    this.issueLinks.set(link.id, link);
    if (link.issueNumber) this.issueLinkByIssueNumber.set(String(link.issueNumber), link);
    if (link.prNumber) this.issueLinkByPrNumber.set(String(link.prNumber), link);
    return link;
  }

  cacheAgentRun(run) {
    if (run) this.agentRuns.set(run.id, run);
    return run;
  }

  cacheAgentRunEvent(event) {
    if (!event) return null;
    this.agentRunEvents.set(event.id, event);
    if (event.dedupeKey) this.agentRunEventByDedupeKey.set(event.dedupeKey, event.id);
    return event;
  }

  cacheSlackJobStatusMessage(message) {
    if (message) this.slackJobStatusMessages.set(`${message.jobId}:${message.scopeKey || 'job'}`, message);
    return message;
  }

  cacheSlackAgentReplyMessage(message) {
    if (message) this.slackAgentReplyMessages.set(message.agentRunId, message);
    return message;
  }
}
