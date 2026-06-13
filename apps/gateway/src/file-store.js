import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { MemoryGatewayStore } from './store.js';

const MAP_FIELDS = [
  'jobs',
  'idempotency',
  'events',
  'githubDeliveries',
  'slackDeliveries',
  'reviewAgentComments',
  'slackNotifications',
  'slackJobStatusMessages',
  'agentRunEvents',
  'agentRunEventByDedupeKey',
  'slackSessions',
  'slackSessionByScopeKey',
  'sessionMemories',
  'issueLinks',
  'issueLinkByJobId',
  'issueLinkByIssueNumber',
  'issueLinkByPrNumber',
  'agentRuns',
];

function mapEntries(value) {
  return Array.isArray(value) ? value : [];
}

function setEntries(value) {
  return Array.isArray(value) ? value : [];
}

export class FileBackedGatewayStore extends MemoryGatewayStore {
  constructor(filePath) {
    super();
    if (!filePath) {
      throw new Error('filePath is required');
    }
    this.filePath = filePath;
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) return;

    const snapshot = JSON.parse(readFileSync(this.filePath, 'utf8'));
    for (const field of MAP_FIELDS) {
      if (field === 'slackNotifications') {
        this[field] = new Set(setEntries(snapshot[field]));
      } else {
        this[field] = new Map(mapEntries(snapshot[field]));
      }
    }
  }

  snapshot() {
    const snapshot = { version: 1 };
    for (const field of MAP_FIELDS) {
      snapshot[field] = field === 'slackNotifications' ? [...this[field].values()] : [...this[field].entries()];
    }
    return snapshot;
  }

  persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
    renameSync(tmpPath, this.filePath);
  }

  createJob(input) {
    const result = super.createJob(input);
    this.persist();
    return result;
  }

  updateJob(jobId, status, patch = {}) {
    const result = super.updateJob(jobId, status, patch);
    this.persist();
    return result;
  }

  failJob(jobId, errorCode, errorMessage) {
    const result = super.failJob(jobId, errorCode, errorMessage);
    this.persist();
    return result;
  }

  patchJob(jobId, patch = {}) {
    const result = super.patchJob(jobId, patch);
    this.persist();
    return result;
  }

  recordGithubDelivery(input) {
    const result = super.recordGithubDelivery(input);
    this.persist();
    return result;
  }

  recordSlackDelivery(input) {
    const result = super.recordSlackDelivery(input);
    this.persist();
    return result;
  }

  recordReviewAgentComment(comment) {
    const result = super.recordReviewAgentComment(comment);
    this.persist();
    return result;
  }

  recordSlackNotification(jobId, key) {
    const result = super.recordSlackNotification(jobId, key);
    this.persist();
    return result;
  }

  recordSlackJobStatusMessage(jobId, input = {}, now = new Date()) {
    const result = super.recordSlackJobStatusMessage(jobId, input, now);
    this.persist();
    return result;
  }

  recordAgentRunEvent(input = {}, now = new Date()) {
    const result = super.recordAgentRunEvent(input, now);
    this.persist();
    return result;
  }

  upsertSlackSession(input, now = new Date()) {
    const result = super.upsertSlackSession(input, now);
    this.persist();
    return result;
  }

  updateSessionMemory(sessionId, patch = {}, now = new Date()) {
    const result = super.updateSessionMemory(sessionId, patch, now);
    this.persist();
    return result;
  }

  closeSlackSession(sessionId, now = new Date()) {
    const result = super.closeSlackSession(sessionId, now);
    this.persist();
    return result;
  }

  linkJobToSlackSession(job, session, now = new Date()) {
    const result = super.linkJobToSlackSession(job, session, now);
    this.persist();
    return result;
  }

  createAgentRun(input, now = new Date()) {
    const result = super.createAgentRun(input, now);
    this.persist();
    return result;
  }

  completeAgentRun(agentRunId, patch = {}, now = new Date()) {
    const result = super.completeAgentRun(agentRunId, patch, now);
    this.persist();
    return result;
  }

  failAgentRun(agentRunId, errorCode, errorMessage, now = new Date()) {
    const result = super.failAgentRun(agentRunId, errorCode, errorMessage, now);
    this.persist();
    return result;
  }
}
