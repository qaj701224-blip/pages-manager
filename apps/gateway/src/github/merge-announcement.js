import { postSlackMessage } from '../slack/notifier.js';
import { redactSecretLikeText } from '../slack/text.js';

const DEFAULT_BASE_REFS = ['master'];
const MAX_TEXT = 2900;
const FORBIDDEN_SUMMARY_RE = /\b(gateway|worker|mysql|status card|job id|callback)\b/i;

function envFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function envList(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeSummaryEndpoint(env = {}) {
  if (env.SLACK_AGENT_MERGE_SUMMARY_URL) return env.SLACK_AGENT_MERGE_SUMMARY_URL;
  const base = env.SLACK_AGENT_TURN_URL || env.SLACK_AGENT_ANALYZE_URL || null;
  if (!base) return null;
  try {
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/(?:turn|analyze)\/?$/, '/merge-summary');
    return url.toString();
  } catch {
    return null;
  }
}

function truncate(text, maxLength) {
  const value = redactSecretLikeText(String(text || '').trim());
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function validateSummaryText(summary = {}) {
  const text = [
    summary.headline,
    ...(summary.summaryBullets || []),
    summary.impact,
    summary.risk,
    ...(summary.tags || []),
  ]
    .filter(Boolean)
    .join('\n');
  if (!text) return false;
  return !FORBIDDEN_SUMMARY_RE.test(text);
}

function stripConventionalPrefix(title) {
  return String(title || '')
    .replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, '')
    .trim();
}

function changedAreaFromPullRequest(pullRequest = {}) {
  const headRef = pullRequest.head?.ref || '';
  const title = pullRequest.title || '';
  if (/docs?|文档/i.test(`${title} ${headRef}`)) return '文档';
  if (/ci|workflow|actions|build/i.test(`${title} ${headRef}`)) return 'CI / workflow';
  if (/slack/i.test(`${title} ${headRef}`)) return 'Slack 体验';
  if (/gateway|worker|server|api/i.test(`${title} ${headRef}`)) return '平台服务';
  if (/site|pages/i.test(`${title} ${headRef}`)) return '站点发布';
  return '代码库';
}

function hasOnlySitePaths(pullRequest = {}) {
  const changedFiles = pullRequest.changed_files;
  const title = pullRequest.title || '';
  const headRef = pullRequest.head?.ref || '';
  if (/^sites\//i.test(headRef)) return true;
  if (/sites\//i.test(title) && changedFiles && Number(changedFiles) <= 3) return true;
  return false;
}

export function mergeAnnouncementEnabled(env = {}) {
  return envFlag(env.MERGE_ANNOUNCEMENT_ENABLED, false);
}

export function mergeAnnouncementDedupeKey(input = {}) {
  return `merge-announcement:${input.repoFullName}:${input.prNumber}:${input.mergeCommitSha}`;
}

export function normalizeMergeAnnouncementInput(body = {}) {
  const pullRequest = body.pull_request || {};
  const repoFullName = body.repository?.full_name || '';
  const prNumber = pullRequest.number || body.number || null;
  const mergeCommitSha = pullRequest.merge_commit_sha || pullRequest.head?.sha || null;

  if (!repoFullName || !prNumber || !mergeCommitSha) return null;

  return {
    repoFullName,
    prNumber,
    prTitle: truncate(pullRequest.title || `PR #${prNumber}`, 180),
    prUrl: pullRequest.html_url || (body.repository?.html_url ? `${body.repository.html_url}/pull/${prNumber}` : null),
    baseRef: pullRequest.base?.ref || null,
    headRef: pullRequest.head?.ref || null,
    authorLogin: pullRequest.user?.login || null,
    mergedByLogin: pullRequest.merged_by?.login || null,
    mergeCommitSha,
    bodyExcerpt: truncate(pullRequest.body || '', 600),
    changedFiles: Number(pullRequest.changed_files) || null,
    additions: Number(pullRequest.additions) || null,
    deletions: Number(pullRequest.deletions) || null,
    area: changedAreaFromPullRequest(pullRequest),
    siteOnly: hasOnlySitePaths(pullRequest),
  };
}

export function shouldHandleMergeAnnouncement(body = {}, action, env = {}) {
  if (!mergeAnnouncementEnabled(env)) return { ok: false, reason: 'disabled' };
  if (action !== 'closed') return { ok: false, reason: 'unsupported_action' };
  const pullRequest = body.pull_request || {};
  if (!pullRequest.merged) return { ok: false, reason: 'not_merged' };

  const input = normalizeMergeAnnouncementInput(body);
  if (!input) return { ok: false, reason: 'missing_required_fields' };

  const configuredRepo = env.GITHUB_REPO || env.GITHUB_REPOSITORY || null;
  if (configuredRepo && input.repoFullName !== configuredRepo) return { ok: false, reason: 'repo_not_allowed' };

  const allowedBaseRefs = envList(env.MERGE_ANNOUNCEMENT_BASE_REFS, DEFAULT_BASE_REFS);
  if (allowedBaseRefs.length > 0 && !allowedBaseRefs.includes(input.baseRef)) {
    return { ok: false, reason: 'base_ref_not_allowed' };
  }

  if (input.siteOnly && !envFlag(env.MERGE_ANNOUNCEMENT_INCLUDE_SITE_PRS, false)) {
    return { ok: false, reason: 'site_pr_skipped' };
  }

  if (!env.MERGE_ANNOUNCEMENT_CHANNEL_ID) return { ok: false, reason: 'missing_channel' };

  return { ok: true, input, dedupeKey: mergeAnnouncementDedupeKey(input) };
}

export function fallbackMergeAnnouncementSummary(input = {}) {
  const headline = truncate(stripConventionalPrefix(input.prTitle) || input.prTitle || `PR #${input.prNumber} 已合并`, 80);
  const stats = [
    input.changedFiles ? `${input.changedFiles} 个文件` : null,
    input.additions ? `+${input.additions}` : null,
    input.deletions ? `-${input.deletions}` : null,
  ]
    .filter(Boolean)
    .join('，');

  return {
    source: 'fallback',
    headline,
    summaryBullets: [
      `影响范围：${input.area || '代码库'}${stats ? `（${stats}）` : ''}。`,
    ],
    impact: `影响范围请以 PR 描述和 changed files 为准。`,
    risk: '未生成 Agent 风险摘要；如需进一步确认，请以 PR 与 CI 结果为准。',
    tags: [input.baseRef, input.area].filter(Boolean).slice(0, 5),
  };
}

function normalizeAgentSummary(rawSummary = {}, fallback = {}) {
  const headline = truncate(nonEmptyString(rawSummary.headline || rawSummary.title), 80);
  const summaryBullets = (Array.isArray(rawSummary.summaryBullets)
    ? rawSummary.summaryBullets
    : Array.isArray(rawSummary.summary_bullets)
      ? rawSummary.summary_bullets
      : Array.isArray(rawSummary.bullets)
        ? rawSummary.bullets
        : []
  )
    .map((item) => truncate(item, 180))
    .filter(Boolean)
    .slice(0, 5);
  const tags = (Array.isArray(rawSummary.tags) ? rawSummary.tags : [])
    .map((item) => truncate(item, 32))
    .filter(Boolean)
    .slice(0, 5);

  if (!headline || summaryBullets.length < 3) return null;
  const summary = {
    source: 'agent',
    headline,
    summaryBullets,
    impact: truncate(rawSummary.impact || fallback.impact || '', 220),
    risk: truncate(rawSummary.risk || fallback.risk || '', 220),
    tags,
  };
  return validateSummaryText(summary) ? summary : null;
}

async function fetchAgentMergeSummary(input, fallback, env = {}) {
  if (envFlag(env.MERGE_ANNOUNCEMENT_AGENT_ENABLED, true) === false) {
    return { summary: fallback, source: 'fallback_disabled' };
  }

  const endpoint = mergeSummaryEndpoint(env);
  if (!endpoint || !env.SLACK_AGENT_SHARED_SECRET) {
    return { summary: fallback, source: 'fallback_missing_agent_config' };
  }

  const fetchImpl = env.SLACK_AGENT_FETCH || fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Pages-Slack-Agent-Token': env.SLACK_AGENT_SHARED_SECRET,
    },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || response.statusText || `HTTP ${response.status}`);
  }

  const summary = normalizeAgentSummary(body.summary || body.data?.summary || body, fallback);
  if (!summary) {
    return { summary: fallback, source: 'fallback_invalid_agent_output' };
  }
  return { summary, source: 'agent' };
}

function formatBullets(summary = {}) {
  return (summary.summaryBullets || [])
    .slice(0, 5)
    .map((item) => `• ${truncate(item, 180)}`)
    .join('\n');
}

function formatMergeAnnouncementText(input = {}, summary = {}) {
  const title = truncate(input.prTitle || `PR #${input.prNumber}`, 180);
  const headline = truncate(summary.headline || stripConventionalPrefix(title) || title, 180);
  const prLink = input.prUrl ? `<${input.prUrl}|PR #${input.prNumber}>` : `PR #${input.prNumber}`;
  const intro = `${input.repoFullName} 合并了 ${prLink}: ${title}。`;
  const lines = [
    `*${intro}*`,
    headline && headline !== title && headline !== stripConventionalPrefix(title) ? `\n${headline}` : '',
    '\n要点:',
    formatBullets(summary),
    summary.impact ? `• 影响：${truncate(summary.impact, 220)}` : '',
    summary.risk ? `• 风险：${truncate(summary.risk, 220)}` : '',
  ].filter(Boolean);
  return lines.join('\n').slice(0, MAX_TEXT);
}

export function buildMergeAnnouncementSlackPayload(input = {}, summary = {}, env = {}) {
  const channel = env.MERGE_ANNOUNCEMENT_CHANNEL_ID;
  const title = truncate(input.prTitle || `PR #${input.prNumber}`, 180);
  const prLink = input.prUrl ? `<${input.prUrl}|PR #${input.prNumber}>` : `PR #${input.prNumber}`;
  const details = formatMergeAnnouncementText(input, summary);

  return {
    channel,
    text: `PR 已合并：${input.repoFullName} ${prLink} ${title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: details || `*${input.repoFullName} 合并了 ${prLink}: ${title}。*` },
      },
    ],
  };
}

async function recordMergeAnnouncementEvent(store, input, dedupeKey, patch = {}) {
  if (!store?.recordAgentRunEvent) return { created: true, event: null };
  return store.recordAgentRunEvent({
    type: 'merge_announcement',
    stage: patch.stage || 'pending',
    text: patch.text || `PR #${input.prNumber} merge announcement ${patch.stage || 'pending'}`,
    status: patch.status || 'pending',
    dedupeKey: patch.dedupeKey || dedupeKey,
    agentRunId: patch.agentRunId || null,
    slackChannelId: patch.slackChannelId || null,
    slackMessageTs: patch.slackMessageTs || null,
  });
}

export async function processMergeAnnouncement({ input, dedupeKey, store, env }) {
  const agentRun = store?.createAgentRun
    ? await store.createAgentRun({
        agentKind: 'merge_announcement',
        status: 'running',
        provider: 'slack_agent',
        promptVersion: 'merge_announcement_summary_v1',
        report: {
          repoFullName: input.repoFullName,
          prNumber: input.prNumber,
          mergeCommitSha: input.mergeCommitSha,
        },
      })
    : null;
  const fallback = fallbackMergeAnnouncementSummary(input);
  let summary = fallback;
  let summarySource = fallback.source;
  try {
    const result = await fetchAgentMergeSummary(input, fallback, env);
    summary = result.summary;
    summarySource = result.source || summary.source || fallback.source;
  } catch (err) {
    summarySource = 'fallback_agent_error';
    await recordMergeAnnouncementEvent(store, input, `${dedupeKey}:summary-fallback`, {
      agentRunId: agentRun?.id || null,
      stage: 'summary_fallback',
      status: 'recorded',
      text: err.message,
      slackChannelId: env.MERGE_ANNOUNCEMENT_CHANNEL_ID || null,
    });
  }
  const payload = buildMergeAnnouncementSlackPayload(input, summary, env);

  try {
    const result = await postSlackMessage(env, payload);
    if (!result?.ok) {
      await recordMergeAnnouncementEvent(store, input, `${dedupeKey}:failed`, {
        agentRunId: agentRun?.id || null,
        stage: 'failed',
        status: 'failed',
        text: result?.error || 'Slack merge announcement failed',
        slackChannelId: payload.channel,
      });
      await store?.failAgentRun?.(agentRun?.id, 'slack_post_failed', result?.error || 'Slack notifier request failed');
      return { ok: false, error: result?.error || 'Slack notifier request failed' };
    }

    await recordMergeAnnouncementEvent(store, input, `${dedupeKey}:sent`, {
      agentRunId: agentRun?.id || null,
      stage: 'sent',
      status: 'completed',
      text: `PR #${input.prNumber} merge announcement sent`,
      slackChannelId: result.channel || payload.channel,
      slackMessageTs: result.ts || null,
    });
    await store?.completeAgentRun?.(agentRun?.id, {
      provider: summarySource === 'agent' ? 'slack_agent' : 'deterministic',
      report: {
        repoFullName: input.repoFullName,
        prNumber: input.prNumber,
        mergeCommitSha: input.mergeCommitSha,
        summarySource,
        slackChannelId: result.channel || payload.channel,
        slackMessageTs: result.ts || null,
      },
    });

    return { ok: true, channel: result.channel || payload.channel, ts: result.ts || null, summarySource };
  } catch (err) {
    await recordMergeAnnouncementEvent(store, input, `${dedupeKey}:failed`, {
      agentRunId: agentRun?.id || null,
      stage: 'failed',
      status: 'failed',
      text: err.message,
      slackChannelId: payload.channel,
    });
    await store?.failAgentRun?.(agentRun?.id, 'merge_announcement_failed', err.message);
    return { ok: false, error: err.message };
  }
}

export async function enqueueMergeAnnouncement({ body, action, store, env }) {
  const decision = shouldHandleMergeAnnouncement(body, action, env);
  if (!decision.ok) return { queued: false, ignored: decision.reason };

  const pending = await recordMergeAnnouncementEvent(store, decision.input, decision.dedupeKey, {
    stage: 'pending',
    status: 'pending',
    slackChannelId: env.MERGE_ANNOUNCEMENT_CHANNEL_ID,
  });
  if (pending && pending.created === false) {
    return { queued: false, ignored: 'duplicate_merge_announcement', dedupeKey: decision.dedupeKey };
  }

  return { queued: true, dedupeKey: decision.dedupeKey, input: decision.input };
}
