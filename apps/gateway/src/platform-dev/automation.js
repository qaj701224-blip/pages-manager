import { startWorkerForPlatformDevItemIfConfigured } from '../publishing/worker-dispatcher.js';
import { notifySlackPlatformDevStatus, platformNotificationText } from '../slack/platform-notifier.js';

const PLATFORM_AGENT_DISPATCHED_EVENT = 'platform_agent_dispatched';
export const PLATFORM_SLACK_FOLLOWUP_QUEUED_EVENT = 'platform_slack_followup_queued';
const DEFAULT_MAX_FIX_ATTEMPTS = 3;

function maxFixAttempts(env = {}) {
  const value = Number(env.PAGES_PLATFORM_MAX_FIX_ATTEMPTS || DEFAULT_MAX_FIX_ATTEMPTS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_FIX_ATTEMPTS;
}

function eventTime(event = {}) {
  const timestamp = Date.parse(event.createdAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function fixDispatchEvents(events = []) {
  return events.filter((event) => event.type === PLATFORM_AGENT_DISPATCHED_EVENT && event.stage === 'agent_queued');
}

function latestFixDispatchForTrigger(events = [], trigger = '') {
  return fixDispatchEvents(events)
    .filter((event) => String(event.text || '').includes(`trigger:${trigger}`))
    .sort((left, right) => eventTime(right) - eventTime(left))[0];
}

function queuedFollowupsAfterLastSlackDispatch(events = []) {
  const lastDispatch = latestFixDispatchForTrigger(events, 'slack_followup');
  const lastDispatchTime = eventTime(lastDispatch);
  return events
    .filter((event) => event.type === PLATFORM_SLACK_FOLLOWUP_QUEUED_EVENT)
    .filter((event) => eventTime(event) > lastDispatchTime)
    .sort((left, right) => eventTime(left) - eventTime(right));
}

function triggerLabel(trigger = '') {
  if (trigger === 'slack_followup') return '追加需求';
  if (trigger === 'ci_failed') return 'CI 未通过';
  if (trigger === 'review_blocked') return 'Review 需要修改';
  return '需要继续处理';
}

export function platformWorkerStartErrorText(error = '') {
  const text = String(error || '').trim();
  if (!text) return '';
  if (/not found/i.test(text)) {
    return '自动开发暂未启动：GitHub workflow 还不可用。';
  }
  return `自动开发暂未启动：${text}`;
}

function canDispatchPlatformFix(item = {}) {
  if (!item?.id) return false;
  if (!item.agentEligible) return false;
  if (item.requiresHumanGate && item.gateStatus !== 'approved') return false;
  const dispatchableStatuses = [
    'issue_created',
    'pr_created',
    'ci_failed',
    'review_waiting',
    'review_blocked',
    'ready_to_merge',
    'agent_queued',
    'failed',
  ];
  return dispatchableStatuses.includes(item.status);
}

export async function dispatchPlatformDevFixIfNeeded(store, item, env, options = {}) {
  if (!canDispatchPlatformFix(item)) {
    return {
      skipped: true,
      reason: 'not_dispatchable',
      item,
      workerStart: null,
      slackStatusNotification: null,
    };
  }

  const trigger = options.trigger || item.status || 'manual';
  const events = store?.listAgentRunEventsForWorkItem
    ? await store.listAgentRunEventsForWorkItem('platform_dev', item.id)
    : [];
  const dispatchCount = fixDispatchEvents(events).length;
  if (dispatchCount >= maxFixAttempts(env)) {
    const failed = await store.updatePlatformDevItem(item.id, 'failed', {
      errorCode: 'platform_fix_attempts_exhausted',
      errorMessage: '自动修复次数已达到上限，请人工查看 Issue / PR 后再继续。',
    });
    if (!failed) {
      return {
        skipped: true,
        reason: 'item_update_failed',
        item: null,
        workerStart: null,
        slackStatusNotification: null,
      };
    }
    await store.linkPlatformDevItemToSlackSession(failed);
    const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, failed, {
      stage: 'failed',
      text: '自动修复次数已达到上限，请人工查看。',
      statusText: ':warning: 自动修复已暂停。',
      skipDuplicate: false,
      slackSessionId: failed.slackSessionId || null,
    });
    return {
      skipped: true,
      reason: 'fix_attempts_exhausted',
      item: failed,
      workerStart: null,
      slackStatusNotification,
    };
  }

  const latestTriggerDispatch = latestFixDispatchForTrigger(events, trigger);
  const itemUpdatedAt = Date.parse(item.updatedAt || '');
  if (
    latestTriggerDispatch &&
    Number.isFinite(itemUpdatedAt) &&
    eventTime(latestTriggerDispatch) >= itemUpdatedAt &&
    options.force !== true
  ) {
    return {
      skipped: true,
      reason: 'already_dispatched_for_trigger',
      item,
      workerStart: null,
      slackStatusNotification: null,
    };
  }

  const queued =
    item.status === 'agent_queued'
      ? await store.patchPlatformDevItem(item.id, {
          errorCode: null,
          errorMessage: null,
        })
      : await store.updatePlatformDevItem(item.id, 'agent_queued', {
          errorCode: null,
          errorMessage: null,
        });
  if (!queued) {
    return {
      skipped: true,
      reason: 'item_update_failed',
      item: null,
      workerStart: null,
      slackStatusNotification: null,
    };
  }
  await store.linkPlatformDevItemToSlackSession(queued);
  let workerStart = null;
  try {
    workerStart = await startWorkerForPlatformDevItemIfConfigured(queued, env);
  } catch (error) {
    workerStart = { started: false, error: error.message || 'Worker start failed' };
  }

  if (workerStart?.started === false) {
    const failed =
      (await store.failPlatformDevItem?.(
        queued.id,
        'worker_start_failed',
        workerStart.error || 'Worker start failed',
        {
          workflowName: queued.workflowName || undefined,
          workflowRunId: queued.workflowRunId || undefined,
        }
      )) || queued;
    await store.linkPlatformDevItemToSlackSession(failed);
    const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, failed, {
      stage: 'failed',
      text: platformWorkerStartErrorText(workerStart.error) || '自动开发暂未启动。',
      statusText: ':x: 自动开发启动失败。',
      currentChange: options.currentChange || null,
      skipDuplicate: false,
      slackSessionId: failed.slackSessionId || null,
      dedupeKey: `platform-fix-dispatch-failed:${queued.id}:${trigger}:${queued.updatedAt || Date.now()}`,
    });
    return {
      skipped: false,
      reason: 'worker_start_failed',
      item: failed,
      workerStart,
      dispatchEvent: null,
      slackStatusNotification,
    };
  }

  const dispatchEvent =
    workerStart?.started && store?.recordAgentRunEvent
      ? await store.recordAgentRunEvent({
          workItemKind: 'platform_dev',
          workItemId: queued.id,
          slackSessionId: queued.slackSessionId || null,
          type: PLATFORM_AGENT_DISPATCHED_EVENT,
          stage: 'agent_queued',
          status: 'dispatched',
          text: `trigger:${trigger} attempt:${dispatchCount + 1} ${triggerLabel(trigger)}，已启动自动修复。`,
          dedupeKey: `platform-agent-dispatched:${queued.id}:${trigger}:${queued.updatedAt || Date.now()}`,
          slackChannelId: queued.slackThread?.channelId || null,
          slackThreadTs: queued.slackThread?.threadTs || null,
        })
      : null;

  const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, queued, {
    stage: 'agent_queued',
    text: workerStart?.started
      ? `${options.issueSyncText || triggerLabel(trigger)}已启动自动修复。`
      : `${options.issueSyncText || triggerLabel(trigger)}${platformWorkerStartErrorText(workerStart?.error) || '等待自动修复启动。'}`,
    statusText: workerStart?.started
      ? ':hourglass_flowing_sand: 正在自动修复。'
      : `:warning: ${platformWorkerStartErrorText(workerStart?.error) || '已进入修复队列。'}`,
    currentChange: options.currentChange || null,
    skipDuplicate: false,
    slackSessionId: queued.slackSessionId || null,
    dedupeKey: `platform-fix-dispatch:${queued.id}:${trigger}:${dispatchEvent?.event?.id || Date.now()}`,
  });

  return {
    skipped: false,
    reason: null,
    item: queued,
    workerStart,
    dispatchEvent,
    slackStatusNotification,
  };
}

export async function dispatchQueuedPlatformDevFollowupIfNeeded(store, item, env) {
  if (!item?.id || !store?.listAgentRunEventsForWorkItem) return null;
  if (!['pr_created', 'ci_failed', 'review_waiting', 'review_blocked', 'ready_to_merge', 'failed'].includes(item.status)) {
    return null;
  }
  const events = await store.listAgentRunEventsForWorkItem('platform_dev', item.id);
  const queued = queuedFollowupsAfterLastSlackDispatch(events);
  if (!queued.length) return null;
  return await dispatchPlatformDevFixIfNeeded(store, item, env, {
    trigger: 'slack_followup',
    force: true,
  });
}

export function platformAutoFixText(trigger = '', item = {}) {
  return platformNotificationText(item.status, item) || `${triggerLabel(trigger)}，正在继续处理。`;
}
