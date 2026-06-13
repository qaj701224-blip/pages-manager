import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySlackIntake,
  normalizeSlackIntakeText,
  slackStatusReply,
} from '../../../apps/gateway/src/slack-intake.js';

function body(text) {
  return {
    event: {
      type: 'app_mention',
      text,
    },
  };
}

test('normalizes Slack mention prefixes', () => {
  assert.equal(normalizeSlackIntakeText('<@U01ABC>   创建一个 issue'), '创建一个 issue');
});

test('classifies help ping and unknown messages without creating jobs', () => {
  assert.deepEqual(
    {
      action: classifySlackIntake(body('帮助')).action,
      shouldCreateJob: classifySlackIntake(body('帮助')).shouldCreateJob,
    },
    { action: 'help', shouldCreateJob: false }
  );
  assert.deepEqual(
    {
      action: classifySlackIntake(body('1')).action,
      shouldCreateJob: classifySlackIntake(body('1')).shouldCreateJob,
    },
    { action: 'ping', shouldCreateJob: false }
  );
  assert.deepEqual(
    {
      action: classifySlackIntake(body('随便聊一句')).action,
      shouldCreateJob: classifySlackIntake(body('随便聊一句')).shouldCreateJob,
    },
    { action: 'unknown', shouldCreateJob: false }
  );
});

test('classifies message commands deterministically', () => {
  for (const [text, expectedText] of [
    ['issue: 给 smoke/profile 做一个个人主页', '给 smoke/profile 做一个个人主页'],
    ['issue 给 smoke/profile 做一个个人主页', '给 smoke/profile 做一个个人主页'],
    ['page: 帮我生成一个个人网页', '帮我生成一个个人网页'],
    ['site: update smoke profile', 'update smoke profile'],
  ]) {
    const result = classifySlackIntake(body(`<@U01ABC> ${text}`));
    assert.equal(result.action, 'create_job');
    assert.equal(result.shouldCreateJob, true);
    assert.equal(result.text, expectedText);
  }
});

test('classifies missing message command requirements without creating jobs', () => {
  const result = classifySlackIntake(body('issue:'));

  assert.equal(result.action, 'missing_requirement');
  assert.equal(result.shouldCreateJob, false);
  assert.match(result.replyText, /请在 `issue:` 后面/);
});

test('classifies explicit create issue and create page messages as jobs', () => {
  for (const text of ['创建一个 issue', '帮我生成一个个人网页', 'create a profile page']) {
    const result = classifySlackIntake(body(`<@U01ABC> ${text}`));
    assert.equal(result.action, 'create_job');
    assert.equal(result.shouldCreateJob, true);
    assert.equal(result.text, text);
  }
});

test('classifies status messages with job id', () => {
  const result = classifySlackIntake(body('状态 job_abc123'));

  assert.equal(result.action, 'status');
  assert.equal(result.shouldCreateJob, false);
  assert.equal(result.jobId, 'job_abc123');
});

test('classifies status command without job id as a friendly reply', () => {
  const result = classifySlackIntake(body('status:'));

  assert.equal(result.action, 'status');
  assert.equal(result.shouldCreateJob, false);
  assert.equal(result.jobId, null);
  assert.match(result.replyText, /status: job_xxx/);
});

test('builds status reply from a job', () => {
  assert.match(slackStatusReply('job_missing', null), /没有找到/);
  assert.match(
    slackStatusReply('job_1', {
      id: 'job_1',
      status: 'issue_created',
      employeeSlug: 'smoke',
      siteSlug: 'profile',
      issueNumber: 8,
    }),
    /Issue：#8/
  );
});
