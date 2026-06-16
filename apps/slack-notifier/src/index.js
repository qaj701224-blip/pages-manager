import {
  addSlackReaction,
  notifySlackJob,
  notifySlackJobStatus,
  postSlackMessage,
  removeSlackReaction,
  startSlackAgentReply,
  updateSlackMessage,
  updateSlackAgentReply,
} from '@xd/slack-notifier-core';
import { jsonResponse } from '@xd/worker-kit';

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function unauthorized(message) {
  return jsonResponse({ ok: false, error: message }, 401);
}

function misconfigured(message) {
  return jsonResponse({ ok: false, error: message }, 500);
}

function authorize(request, env = {}) {
  const expected = env.SLACK_NOTIFIER_SHARED_SECRET || env.PAGES_SLACK_NOTIFIER_SHARED_SECRET;
  if (!expected) return misconfigured('Slack notifier shared secret is required');

  const actual = request.headers.get('X-Pages-Slack-Notifier-Token');
  if (actual !== expected) {
    return unauthorized('Invalid slack notifier token');
  }
  return null;
}

function transientStatusStore(existingMessage) {
  return {
    getSlackJobStatusMessage() {
      return existingMessage || null;
    },
    recordAgentRunEvent(input = {}) {
      return {
        created: true,
        event: {
          ...input,
          createdAt: new Date().toISOString(),
        },
      };
    },
    recordSlackJobStatusMessage(jobId, input = {}) {
      return {
        ...(existingMessage || {}),
        ...input,
        jobId,
      };
    },
  };
}

function transientMessageStore() {
  return {
    hasSlackNotification() {
      return false;
    },
    recordSlackNotification() {},
  };
}

function slackApiUrl(env = {}, method) {
  if (env.SLACK_API_BASE_URL) {
    return `${String(env.SLACK_API_BASE_URL).replace(/\/+$/, '')}/${method}`;
  }
  return String(env.SLACK_API_URL || 'https://slack.com/api/chat.postMessage').replace(/\/chat\.postMessage$/, `/${method}`);
}

function normalizeSlackUserProfile(user = {}) {
  const profile = user.profile || {};
  return {
    source: 'slack.users.info',
    slackTeamId: user.team_id || null,
    slackUserId: user.id || null,
    name: user.name || profile.name || null,
    displayName: profile.display_name || profile.display_name_normalized || null,
    realName: profile.real_name || profile.real_name_normalized || user.real_name || null,
    email: profile.email || null,
  };
}

async function fetchSlackUserProfile(env = {}, userId) {
  if (!env.SLACK_BOT_TOKEN) {
    return { ok: false, error: 'Slack bot token is not configured' };
  }
  if (!userId) {
    return { ok: false, error: 'Slack user id is required' };
  }

  const fetchImpl = env.SLACK_PROFILE_FETCH || env.SLACK_FETCH || fetch;
  const response = await fetchImpl(slackApiUrl(env, 'users.info'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: new URLSearchParams({ user: userId }).toString(),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || body?.ok === false || !body?.user) {
    return {
      ok: false,
      error: body?.error || response.statusText || `HTTP ${response.status}`,
    };
  }

  return {
    ok: true,
    profile: normalizeSlackUserProfile(body.user),
  };
}

export function createSlackNotifierApp() {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);

      try {
        if (request.method === 'GET' && url.pathname === '/health') {
          return jsonResponse({ status: 'ok', service: 'slack-notifier' });
        }

        if (!url.pathname.startsWith('/internal/slack-notifier/')) {
          return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
        }

        const authError = authorize(request, env);
        if (authError) return authError;

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/job-status') {
          const body = await readJson(request);
          const result = await notifySlackJobStatus(
            env,
            transientStatusStore(body.existingMessage || null),
            body.job,
            body.options || {}
          );
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/job-message') {
          const body = await readJson(request);
          const result = await notifySlackJob(env, transientMessageStore(), body.job, body.text, body.key);
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/message') {
          const body = await readJson(request);
          const result = await postSlackMessage(env, body.payload || {});
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/update') {
          const body = await readJson(request);
          const result = await updateSlackMessage(env, body.payload || {});
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/agent-reply/start') {
          const body = await readJson(request);
          const result = await startSlackAgentReply(env, body.target || {}, body.options || {});
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/agent-reply/update') {
          const body = await readJson(request);
          const result = await updateSlackAgentReply(env, body.message || {}, body.options || {});
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/reaction') {
          const body = await readJson(request);
          const result = await addSlackReaction(env, body.payload || {});
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/reaction-remove') {
          const body = await readJson(request);
          const result = await removeSlackReaction(env, body.payload || {});
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/user-info') {
          const body = await readJson(request);
          const result = await fetchSlackUserProfile(env, body.user || body.userId || body.slackUserId);
          return jsonResponse(result || { ok: false, error: 'Slack user lookup failed' }, result?.ok === false ? 502 : 200);
        }

        return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, err.status || 500);
      }
    },
  };
}

const defaultApp = createSlackNotifierApp();

export default {
  fetch(request, env) {
    return defaultApp.fetch(request, env);
  },
};
