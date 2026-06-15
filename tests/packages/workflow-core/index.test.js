import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPublishingJob,
  canTransition,
  idempotencyScopeForJob,
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
