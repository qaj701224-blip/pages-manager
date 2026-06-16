import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySlackIntake, normalizeSlackIntakeText, slackStatusReply } from '../../../apps/gateway/src/slack/intake.js';

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

test('classifies help ping and free-form messages without creating jobs', () => {
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
    { action: 'agent_turn', shouldCreateJob: false }
  );
});

test('keeps casual greetings as free-form agent turns', () => {
  const result = classifySlackIntake(body('你好，我想先聊聊个人主页'));

  assert.equal(result.action, 'agent_turn');
  assert.equal(result.shouldCreateJob, false);
  assert.equal(result.shouldAnalyze, true);
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

test('routes natural create or update messages to the Slack Agent', () => {
  for (const text of ['创建一个 issue', '帮我生成一个个人网页', 'create a profile page']) {
    const result = classifySlackIntake(body(`<@U01ABC> ${text}`));
    assert.equal(result.action, 'agent_turn');
    assert.equal(result.shouldCreateJob, false);
    assert.equal(result.shouldAnalyze, true);
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
  assert.equal(result.replyText, null);
});

test('classifies bulk destructive issue requests as unsupported', () => {
  for (const text of ['关闭我名下的所有 issue', '把我的全部 PR 都关掉', '取消所有发布任务', 'delete all my issues']) {
    const result = classifySlackIntake(body(text));

    assert.equal(result.action, 'unsupported_destructive_request');
    assert.equal(result.shouldCreateJob, false);
    assert.equal(result.shouldAnalyze, false);
    assert.match(result.replyText, /不能批量关闭或删除/);
  }
});

test('marks explicit work item history list requests', () => {
  const result = classifySlackIntake(body('查看我的历史发布任务'));

  assert.equal(result.action, 'list_work_items');
  assert.equal(result.includeInactive, true);
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
