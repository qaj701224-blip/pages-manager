import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPublishingJob,
  buildPlatformDevItem,
  canTransition,
  canTransitionPlatformDevItem,
  idempotencyScopeForJob,
  idempotencyScopeForPlatformDevItem,
  transitionPlatformDevItem,
  transitionPlatformDevItemWithBridge,
  transitionJob,
} from '../../../packages/workflow-core/src/index.js';

test('buildPublishingJob creates a received job with an idempotency scope', () => {
  const job = buildPublishingJob(
    {
      source: 'slack',
      requestedById: 'slack:T:user',
      idempotencyKey: 'evt_1',
      employeeSlug: 'zhangsan',
      siteSlug: 'profile',
      brief: 'Create a profile page',
      requesterProfile: {
        source: 'slack.users.info',
        slackTeamId: 'T1',
        slackUserId: 'U1',
        displayName: '张三',
        realName: 'Zhang San',
        email: 'zhangsan@example.com',
      },
    },
    { id: 'job_test', now: new Date('2026-06-12T00:00:00.000Z') }
  );

  assert.equal(job.id, 'job_test');
  assert.equal(job.status, 'received');
  assert.equal(job.employeeSlug, 'zhangsan');
  assert.deepEqual(job.requesterProfile, {
    source: 'slack.users.info',
    slackTeamId: 'T1',
    slackUserId: 'U1',
    displayName: '张三',
    realName: 'Zhang San',
    email: 'zhangsan@example.com',
  });
  assert.equal(idempotencyScopeForJob(job), 'slack:user:slack:T:user:evt_1');
});

test('first priority status transitions allow preview loop', () => {
  let job = buildPublishingJob(
    {
      requestedById: 'usr_1',
      idempotencyKey: 'key_1',
      employeeSlug: 'zhangsan',
      siteSlug: 'profile',
    },
    { id: 'job_test' }
  );

  for (const status of [
    'issue_creating',
    'issue_created',
    'indexing',
    'generating_page',
    'patch_generated',
    'branch_committed',
    'pr_created',
    'reviewing',
    'previewing',
    'preview_deployed',
  ]) {
    job = transitionJob(job, status);
  }

  assert.equal(job.status, 'preview_deployed');
  assert.equal(canTransition('preview_deployed', 'fixing'), true);
});

test('production deploy cannot happen before production merge states', () => {
  assert.equal(canTransition('preview_deployed', 'deploying'), false);
  assert.throws(() => transitionJob({ id: 'job_test', status: 'preview_deployed' }, 'deploying'), /Invalid/);
});

test('buildPlatformDevItem normalizes enterprise lane metadata and gate policy', () => {
  const item = buildPlatformDevItem(
    {
      source: 'slack',
      requestedById: 'slack:T:user',
      idempotencyKey: 'evt_platform_1',
      title: '收紧 Slack issue 流程',
      summary: '通过 Slack 创建 pages-manager 自身开发 issue。',
      issueType: 'type:ci',
      areas: ['area:gateway', 'area:github', 'area:gateway'],
    },
    { id: 'pdev_test', now: new Date('2026-06-12T00:00:00.000Z') }
  );

  assert.equal(item.id, 'pdev_test');
  assert.equal(item.status, 'received');
  assert.equal(item.issueType, 'type:ci');
  assert.deepEqual(item.areas, ['area:gateway', 'area:github']);
  assert.equal(item.risk, 'risk:high');
  assert.equal(item.agentEligible, true);
  assert.equal(item.requiresHumanGate, true);
  assert.equal(item.gateStatus, 'pending');
  assert.equal(idempotencyScopeForPlatformDevItem(item), 'slack:user:slack:T:user:evt_platform_1');
});

test('buildPlatformDevItem fails closed for explicit platform policy overrides', () => {
  const feedback = buildPlatformDevItem(
    {
      requestedById: 'usr_1',
      idempotencyKey: 'feedback_1',
      issueType: 'type:feedback',
      agentEligible: false,
    },
    { id: 'pdev_feedback' }
  );
  const ci = buildPlatformDevItem(
    {
      requestedById: 'usr_1',
      idempotencyKey: 'ci_1',
      issueType: 'type:ci',
      risk: 'risk:medium',
      requiresHumanGate: false,
    },
    { id: 'pdev_ci' }
  );
  const explicitBlockedDev = buildPlatformDevItem(
    {
      requestedById: 'usr_1',
      idempotencyKey: 'dev_blocked_1',
      issueType: 'type:dev',
      agentEligible: false,
    },
    { id: 'pdev_dev_blocked' }
  );

  assert.equal(feedback.agentEligible, false);
  assert.equal(feedback.requiresHumanGate, false);
  assert.equal(explicitBlockedDev.agentEligible, false);
  assert.equal(ci.risk, 'risk:high');
  assert.equal(ci.requiresHumanGate, true);
});

test('PlatformDevItem transitions cover issue, agent, PR, CI, review and merge', () => {
  let item = buildPlatformDevItem(
    {
      requestedById: 'usr_1',
      idempotencyKey: 'key_1',
      title: '平台开发',
      summary: '平台开发',
    },
    { id: 'pdev_test' }
  );

  for (const status of [
    'issue_creating',
    'issue_created',
    'agent_queued',
    'agent_running',
    'branch_committed',
    'pr_created',
    'ci_running',
    'review_waiting',
    'ready_to_merge',
    'merged',
  ]) {
    item = transitionPlatformDevItem(item, status);
  }

  assert.equal(item.status, 'merged');
  assert.equal(canTransitionPlatformDevItem('ready_to_merge', 'merged'), true);
  assert.equal(canTransitionPlatformDevItem('merged', 'agent_running'), false);
});

test('PlatformDevItem bridge transitions normalize late executor callbacks', () => {
  const item = buildPlatformDevItem(
    {
      requestedById: 'usr_1',
      idempotencyKey: 'key_bridge',
      title: '平台开发',
      summary: '平台开发',
    },
    { id: 'pdev_bridge' }
  );
  const bridgedStatuses = [];
  const updated = transitionPlatformDevItemWithBridge(
    item,
    'pr_created',
    { githubPrNumber: 99 },
    new Date('2026-06-12T00:00:00.000Z'),
    (_, status) => bridgedStatuses.push(status)
  );

  assert.equal(updated.status, 'pr_created');
  assert.equal(updated.githubPrNumber, 99);
  assert.deepEqual(bridgedStatuses, ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed']);
});
